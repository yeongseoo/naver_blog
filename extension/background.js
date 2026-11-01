/*
 * background.js - Service Worker (Phase 1 POC) · 빌드 #5
 *
 * 역할: chrome.debugger API로 "진짜(trusted) 키 입력"을 네이버 에디터에 전달한다.
 *
 * 배경: 스마트에디터 ONE은 숨겨진 input_buffer iframe으로 실제 키보드 입력만 받는다.
 *       합성 이벤트/execCommand/DOM조작은 무시된다. 따라서 content script의 합성 클릭으로
 *       "입력 위치(제목/본문)"만 지정하고, 실제 타이핑은 debugger의 Input.insertText로 보낸다.
 *
 * 흐름:
 *   content: 제목 문단 클릭(위치 지정)
 *   background: Input.insertText(제목)
 *   content: 본문 문단 클릭
 *   background: Input.insertText(본문)
 *   content: 입력 결과 읽어 검증
 */

const BUILD = 34;
const LOG = `[네이버자동입력 BG #${BUILD}]`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** content script 로 메시지 (에디터 프레임만 응답) */
function sendTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (r) => {
      if (chrome.runtime.lastError) resolve({ __error: chrome.runtime.lastError.message });
      else resolve(r);
    });
  });
}

// --- chrome.debugger 래퍼 ---
function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}
function dbgDetach(tabId) {
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}
function dbgSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(r);
    });
  });
}

/** 포커스된 요소(에디터 input_buffer)에 실제 텍스트 입력 */
async function insertText(tabId, text) {
  await dbgSend(tabId, "Input.insertText", { text });
}

/** 한 필드 처리: 클릭(위치지정) → 입력 → 검증 */
async function fillField(tabId, field, text, rec) {
  const clicked = await sendTab(tabId, { type: "CLICK_FIELD", field });
  rec(`${field} 위치 클릭`, !!(clicked && clicked.ok), clicked && clicked.error);
  if (!clicked || !clicked.ok) return false;

  await sleep(200);
  await insertText(tabId, text);
  await sleep(200);

  const read = await sendTab(tabId, { type: "READ_FIELD", field });
  const got = read && read.text ? read.text : "";
  const ok = got.includes(text.slice(0, 5));
  rec(`${field} 입력`, ok, got.slice(0, 25));
  return ok;
}

/** 자동 입력 전체 실행 */
async function runAutofill(tabId, payload) {
  const steps = [];
  const rec = (step, ok, detail) => {
    steps.push({ step, ok, detail });
    console.log(LOG, ok ? "✅" : "❌", step, detail || "");
  };

  let attached = false;
  try {
    await dbgAttach(tabId);
    attached = true;
    rec("디버거 연결", true);

    const titleOk = await fillField(tabId, "title", payload.title, rec);
    const bodyOk = await fillField(tabId, "body", payload.body, rec);

    return { success: titleOk && bodyOk, steps };
  } catch (e) {
    // DevTools(F12)가 열려 있으면 attach 실패한다
    const hint = /already attached|Another debugger/i.test(e.message)
      ? " (F12 개발자도구를 닫고 다시 시도하세요)"
      : "";
    rec("오류", false, e.message + hint);
    return { success: false, steps, error: e.message + hint };
  } finally {
    if (attached) await dbgDetach(tabId);
  }
}

/**
 * 이미지 삽입 (Phase 2 / 빌드 #7)
 * 사진 버튼 클릭 → 파일 선택창을 debugger로 가로채 로컬 파일 지정 → 업로드 검증.
 * (debugger 는 이미 attach 된 상태에서 호출)
 */
async function insertImage(tabId, filePath, rec) {
  await dbgSend(tabId, "Page.enable");
  await dbgSend(tabId, "DOM.enable");

  // 파일 선택창 가로채기 활성화 → OS 대화상자 대신 이벤트로 처리
  await dbgSend(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });

  // 업로드 전 이미지 개수
  const before = await sendTab(tabId, { type: "COUNT_IMAGES" });
  const n0 = (before && before.seImage) || 0;
  const m0 = (before && before.imgInMain) || 0;

  // 파일 선택창 이벤트 대기 준비
  let onFileChooser;
  const chooserPromise = new Promise((resolve) => {
    onFileChooser = (source, method, params) => {
      if (source.tabId === tabId && method === "Page.fileChooserOpened") resolve(params);
    };
    chrome.debugger.onEvent.addListener(onFileChooser);
  });

  try {
    // 사진 버튼 클릭 (content) → 파일 선택창 발생
    const clicked = await sendTab(tabId, { type: "CLICK_IMAGE_BUTTON" });
    rec("사진 버튼 클릭", !!(clicked && clicked.ok), clicked && (clicked.selector || clicked.error));
    if (!clicked || !clicked.ok) return false;

    // 파일 선택창 이벤트 대기 (최대 5초)
    const params = await Promise.race([chooserPromise, sleep(5000).then(() => null)]);
    if (!params) {
      rec("파일 선택창 감지", false, "이벤트 없음");
      return false;
    }
    rec("파일 선택창 감지", true, "backendNodeId=" + params.backendNodeId);

    if (!params.backendNodeId) {
      rec("파일 지정", false, "backendNodeId 없음");
      return false;
    }

    // 로컬 파일을 file input 에 지정 → 네이버가 업로드 시작
    await dbgSend(tabId, "DOM.setFileInputFiles", {
      files: [filePath],
      backendNodeId: params.backendNodeId,
    });
    rec("파일 지정", true, filePath);
  } finally {
    chrome.debugger.onEvent.removeListener(onFileChooser);
    await dbgSend(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
  }

  // 업로드 완료(이미지 컴포넌트 증가) 폴링 — 최대 15초
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(700);
    const cur = await sendTab(tabId, { type: "COUNT_IMAGES" });
    const n1 = (cur && cur.seImage) || 0;
    const m1 = (cur && cur.imgInMain) || 0;
    if (n1 > n0 || m1 > m0) {
      rec("이미지 삽입 확인", true, `se-image ${n0}→${n1}, img ${m0}→${m1}`);
      return true;
    }
  }
  rec("이미지 삽입 확인", false, "타임아웃(업로드 지연/실패)");
  return false;
}

/** 이미지 삽입 단독 실행 */
async function runInsertImage(tabId, filePath) {
  const steps = [];
  const rec = (step, ok, detail) => {
    steps.push({ step, ok, detail });
    console.log(LOG, ok ? "✅" : "❌", step, detail || "");
  };
  let attached = false;
  try {
    await dbgAttach(tabId);
    attached = true;
    rec("디버거 연결", true);
    const ok = await insertImage(tabId, filePath, rec);
    return { success: ok, steps };
  } catch (e) {
    const hint = /already attached|Another debugger/i.test(e.message)
      ? " (F12 개발자도구를 닫고 다시 시도하세요)"
      : "";
    rec("오류", false, e.message + hint);
    return { success: false, steps, error: e.message + hint };
  } finally {
    if (attached) await dbgDetach(tabId);
  }
}

/**
 * 순서 삽입 (STEP 6 / 빌드 #8): 제목 → 텍스트1 → 이미지 → 텍스트2
 * 에디터에서 실제로 동일한 순서로 배치되는지 검증한다.
 */
async function runSequence(tabId, seq) {
  const steps = [];
  const rec = (step, ok, detail) => {
    steps.push({ step, ok, detail });
    console.log(LOG, ok ? "✅" : "❌", step, detail || "");
  };
  let attached = false;
  try {
    await dbgAttach(tabId);
    attached = true;
    rec("디버거 연결", true);

    const tOk = await fillField(tabId, "title", seq.title, rec);
    const b1Ok = await fillField(tabId, "body", seq.text1, rec);
    const imgOk = await insertImage(tabId, seq.imagePath, rec);
    // 이미지 뒤 새로 생긴 마지막 문단에 텍스트2 입력
    await sleep(300);
    const b2Ok = await fillField(tabId, "bodyLast", seq.text2, rec);

    return { success: tOk && b1Ok && imgOk && b2Ok, steps };
  } catch (e) {
    const hint = /already attached|Another debugger/i.test(e.message)
      ? " (F12 개발자도구를 닫고 다시 시도하세요)"
      : "";
    rec("오류", false, e.message + hint);
    return { success: false, steps, error: e.message + hint };
  } finally {
    if (attached) await dbgDetach(tabId);
  }
}

// --- Block Engine (Phase 3 / 빌드 #9) ---

/** 현재 포커스 위치에 텍스트 입력 (클릭 없이) */
async function typeAtCaret(tabId, text) {
  await dbgSend(tabId, "Input.insertText", { text });
}

/** Enter 키 입력 → 새 문단 생성 */
async function pressEnter(tabId) {
  const base = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: "Enter", code: "Enter" };
  await dbgSend(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await dbgSend(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** content로 필드 클릭 요청 */
async function clickField(tabId, field) {
  const r = await sendTab(tabId, { type: "CLICK_FIELD", field });
  return !!(r && r.ok);
}

/** 구분선/인용구 등 툴바 버튼 클릭 후 컴포넌트 증가로 검증 */
async function insertToolbarComponent(tabId, key, rec, idx, content) {
  const typeKey = key === "quote" ? "quote" : "divider"; // COUNT_COMPONENTS 키
  const before = await sendTab(tabId, { type: "COUNT_COMPONENTS" });
  const c = await sendTab(tabId, { type: "CLICK_TOOLBAR", key });
  if (!c || !c.ok) {
    rec(`[${idx}] ${key}`, false, (c && c.error) || "버튼 클릭 실패");
    return false;
  }
  await sleep(350);
  // 인용구는 생성 후 텍스트 입력 (기존 빈 문단을 인용구로 변환하므로 total은 안 늘 수 있음)
  if (content) {
    await typeAtCaret(tabId, content);
    await sleep(200);
  }
  const after = await sendTab(tabId, { type: "COUNT_COMPONENTS" });
  const bType = (before && before[typeKey]) || 0;
  const aType = (after && after[typeKey]) || 0;
  const bTotal = (before && before.total) || 0;
  const aTotal = (after && after.total) || 0;
  const ok = aType > bType || aTotal > bTotal; // 해당 타입 증가 or 전체 증가
  rec(`[${idx}] ${key}`, ok, `${typeKey} ${bType}→${aType}, total ${bTotal}→${aTotal}`);
  return ok;
}

/**
 * Block Engine: 임의의 block 배열을 에디터에 순서대로 입력한다.
 * block: { type: "text"|"heading"|"quote"|"image", content?, path? }
 * (heading/quote 스타일 적용은 다음 빌드에서 추가; 현재는 텍스트로 입력)
 *
 * 입력 위치 상태기계:
 *   - 첫 텍스트 블록: 본문 첫 문단 클릭
 *   - 이미지 뒤 텍스트: 이미지가 만든 빈 마지막 문단 클릭
 *   - 텍스트 뒤 텍스트: Enter로 새 문단 생성
 *   - 이미지: 현재 caret 위치에 삽입 (자체적으로 뒤에 빈 문단 생성)
 */
async function runBlocks(tabId, data) {
  const steps = [];
  const rec = (step, ok, detail) => {
    steps.push({ step, ok, detail });
    console.log(LOG, ok ? "✅" : "❌", step, detail || "");
  };

  let attached = false;
  try {
    await dbgAttach(tabId);
    attached = true;
    rec("디버거 연결", true);

    if (data.title) await fillField(tabId, "title", data.title, rec);

    const blocks = data.blocks || [];
    let prevType = null; // null | "text" | "image"

    // 텍스트 계열 입력 위치 잡기
    const positionForText = async () => {
      if (prevType === null) await clickField(tabId, "body");
      else if (prevType === "block") await clickField(tabId, "bodyLast");
      else await pressEnter(tabId);
      await sleep(150);
    };

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];

      if (b.type === "text") {
        await positionForText();
        await typeAtCaret(tabId, b.content || "");
        await sleep(200);
        const r = await sendTab(tabId, { type: "READ_FIELD", field: "bodyLast" });
        const got = r && r.text ? r.text : "";
        rec(`[${i}] text`, got.includes((b.content || "").slice(0, 5)), got.slice(0, 20));
        prevType = "text";
      } else if (b.type === "heading") {
        await positionForText();
        await typeAtCaret(tabId, b.content || "");
        await sleep(200);
        // 서식 적용 전에 텍스트 검증 (서식 적용 후엔 문단 클래스가 바뀜)
        const r = await sendTab(tabId, { type: "READ_FIELD", field: "bodyLast" });
        const got = r && r.text ? r.text : "";
        const typedOk = got.includes((b.content || "").slice(0, 5));
        const fmt = await sendTab(tabId, { type: "APPLY_HEADING" }); // 소제목 서식
        await sleep(200);
        rec(
          `[${i}] heading(소제목)`,
          typedOk && fmt && fmt.ok,
          (fmt && fmt.ok ? "서식OK " : "서식실패 ") + got.slice(0, 16)
        );
        // 다음 블록을 위해 소제목 문단 뒤에 새 문단 확보
        await clickField(tabId, "bodyLast");
        await pressEnter(tabId);
        prevType = "block";
      } else if (b.type === "image") {
        // 실제 이미지 경로가 없으면(AI 이미지 미생성) 건너뛴다. (Phase 8에서 채움)
        if (!b.path) {
          rec(`[${i}] image(건너뜀·이미지없음)`, true, b.prompt || "");
          continue;
        }
        if (prevType === null) await clickField(tabId, "body");
        const ok = await insertImage(tabId, b.path, (s, o, d) => rec(`[${i}] image · ${s}`, o, d));
        prevType = "block"; // 이미지 뒤에는 빈 문단이 생김
        if (!ok) rec(`[${i}] image 실패`, false);
      } else if (b.type === "divider") {
        if (prevType === null) await clickField(tabId, "body");
        const style = b.style || "line1"; // 기본: 전체폭
        const before = await sendTab(tabId, { type: "COUNT_COMPONENTS" });
        const r = await sendTab(tabId, { type: "INSERT_DIVIDER_STYLE", value: style });
        await sleep(400);
        const after = await sendTab(tabId, { type: "COUNT_COMPONENTS" });
        const ok = r && r.ok && (after.divider || 0) > (before.divider || 0);
        rec(
          `[${i}] divider(${style})`,
          ok,
          `divider ${before.divider}→${after.divider}` + (r && r.error ? " " + r.error : "")
        );
        prevType = "block";
      } else if (b.type === "quote") {
        if (prevType === null) await clickField(tabId, "body");
        else if (prevType === "text") await pressEnter(tabId);
        await insertToolbarComponent(tabId, "quote", rec, i, b.content || "");
        prevType = "block";
      } else {
        rec(`[${i}] ${b.type} (미지원)`, false, "지원되지 않는 타입");
      }
    }

    const allOk = steps.every((s) => s.ok);
    return { success: allOk, steps };
  } catch (e) {
    const hint = /already attached|Another debugger/i.test(e.message)
      ? " (F12 개발자도구를 닫고 다시 시도하세요)"
      : "";
    rec("오류", false, e.message + hint);
    return { success: false, steps, error: e.message + hint };
  } finally {
    if (attached) await dbgDetach(tabId);
  }
}

/** 새 글쓰기 탭에서 에디터(content script PING)가 준비될 때까지 대기 */
async function waitEditorReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const r = await sendTab(tabId, { type: "PING" });
    if (r && r.ok) return true;
  }
  return false;
}

/**
 * 자동 작성 오케스트레이션 (빌드 #22~#23):
 * 열려 있는 네이버 글쓰기 탭을 찾고, 없으면 writeUrl 로 백그라운드 탭을 자동으로 연다.
 * 그 탭에 draft(blocks)를 자동 입력하고, 옵션에 따라 임시저장.
 */
async function runAutoWrite(draft, save, writeUrl) {
  const steps = [];
  const tabs = await chrome.tabs.query({ url: "https://blog.naver.com/*" });
  let writeTab = tabs.find((t) => /Write|PostWrite|postwrite/i.test(t.url || "")) || tabs[0];

  // 열린 글쓰기 탭이 없으면 자동으로 연다 (백그라운드 탭)
  if (!writeTab) {
    if (!writeUrl) {
      return {
        success: false,
        steps: [
          {
            step: "글쓰기 탭",
            ok: false,
            detail: "열린 글쓰기 탭이 없습니다. 설정에 '블로그 글쓰기 주소'를 입력하세요.",
          },
        ],
      };
    }
    writeTab = await chrome.tabs.create({ url: writeUrl, active: false });
    steps.push({ step: "글쓰기 탭 자동 열기", ok: true, detail: "백그라운드" });
    const ready = await waitEditorReady(writeTab.id, 25000);
    steps.push({ step: "에디터 로딩 대기", ok: ready, detail: ready ? "" : "시간초과(25s)" });
    if (!ready) return { success: false, steps };
    await sleep(600);
  }

  const result = await runBlocks(writeTab.id, draft);
  result.steps = steps.concat(result.steps);

  if (save) {
    const s = await sendTab(writeTab.id, { type: "CLICK_SAVE" });
    result.steps.push({
      step: "임시저장",
      ok: !!(s && s.ok),
      detail: s && s.ok ? `저장수 ${s.before}→${s.after}` : s && s.error ? s.error : "실패",
    });
    if (!(s && s.ok)) result.success = false;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 발행 요청 캡처 (빌드 #24) — RabbitWrite 방식 전환을 위한 리버싱 진단
//
// chrome.debugger 의 Network 도메인으로, 사용자가 "수동으로" 임시저장/발행을 눌렀을 때
// 네이버로 나가는 실제 요청(RabbitTempPostWrite.naver / RabbitWrite.naver / PrePostList.naver)의
// URL·메서드·postData(=documentModel 포함)를 그대로 캡처한다.
// 이 postData 가 우리 블로그 기준의 정확한 파라미터/문서모델 스키마의 정답지가 된다.
// ---------------------------------------------------------------------------
const CAPTURE_URL_RE = /RabbitWrite\.naver|RabbitTempPostWrite\.naver|PrePostList\.naver/i;
const CAPTURE_FINAL_RE = /RabbitWrite\.naver|RabbitTempPostWrite\.naver/i;

async function runCapturePublish(tabId, timeoutMs = 120000) {
  const captures = [];
  let attached = false;
  let onEvent = null;

  try {
    await dbgAttach(tabId);
    attached = true;
    await dbgSend(tabId, "Network.enable");

    const done = new Promise((resolve) => {
      onEvent = async (source, method, params) => {
        if (!source || source.tabId !== tabId) return;
        if (method !== "Network.requestWillBeSent") return;
        const req = params.request || {};
        const url = req.url || "";
        if (!CAPTURE_URL_RE.test(url)) return;

        let postData = req.postData || "";
        if (!postData && req.hasPostData) {
          try {
            const r = await dbgSend(tabId, "Network.getRequestPostData", {
              requestId: params.requestId,
            });
            postData = (r && r.postData) || "";
          } catch (e) {
            postData = "(postData 조회 실패: " + e.message + ")";
          }
        }
        captures.push({ url, method: req.method || "POST", postData });
        console.log(LOG, "📥 요청 캡처", url, "postData " + postData.length + "B");
        if (CAPTURE_FINAL_RE.test(url)) resolve(true); // 최종 저장/발행 요청 잡으면 종료
      };
      chrome.debugger.onEvent.addListener(onEvent);
    });

    // 사용자가 에디터에서 수동으로 [임시저장]/[발행]을 누를 때까지 대기
    await Promise.race([done, sleep(timeoutMs)]);
    return { success: captures.some((c) => CAPTURE_FINAL_RE.test(c.url)), captures };
  } catch (e) {
    const hint = /already attached|Another debugger/i.test(e.message)
      ? " (F12 개발자도구를 닫고 다시 시도하세요)"
      : "";
    return { success: false, captures, error: e.message + hint };
  } finally {
    if (onEvent) chrome.debugger.onEvent.removeListener(onEvent);
    if (attached) await dbgDetach(tabId);
  }
}

// ---------------------------------------------------------------------------
// 에디터 내부 진단 (빌드 #26) — 다계정 자동화를 위한 리버싱
//
// chrome.debugger 의 Runtime 도메인으로 페이지의 "메인 월드"에 접근한다.
// (content script 는 isolated world 라 window.SmartEditor 등 페이지 전역에 못 닿음)
// 모든 실행 컨텍스트(프레임)에서 SmartEditor 에디터 객체 / editorSource / 저장 메서드를
// 찾아, 길 A(직접 재구성) vs 길 B(에디터에게 맡기기) 중 어느 쪽이 가능한지 판단한다.
// ---------------------------------------------------------------------------
async function runProbeEditor(tabId) {
  let attached = false;
  let onEvent = null;
  const contexts = [];
  try {
    await dbgAttach(tabId);
    attached = true;

    onEvent = (source, method, params) => {
      if (!source || source.tabId !== tabId) return;
      if (method === "Runtime.executionContextCreated" && params && params.context) {
        const c = params.context;
        contexts.push({ id: c.id, origin: c.origin, name: c.name });
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    // Runtime.enable 하면 기존 컨텍스트들에 대해 executionContextCreated 가 일괄 발생
    await dbgSend(tabId, "Runtime.enable");
    await sleep(600);

    const expr = `(function(){
      try {
        var out = { url: location.href, hasSmartEditor: false };
        var SE = window.SmartEditor;
        if (SE && SE._editors) {
          out.hasSmartEditor = true;
          var keys = Object.keys(SE._editors);
          out.editorKeys = keys;
          var ed = SE._editors[keys[0]];
          if (ed) {
            var proto = Object.getPrototypeOf(ed) || {};
            out.editorMethods = Object.getOwnPropertyNames(proto)
              .filter(function(n){ return /save|document|source|publish|temp|populat/i.test(n); });
            out.editorProps = Object.keys(ed)
              .filter(function(n){ return /source|config|option|document|populat|blog/i.test(n); });
            out.hasSetDocumentData = typeof ed.setDocumentData === 'function';
            out.hasGetDocumentData = typeof ed.getDocumentData === 'function';
          }
        }
        // editorSource 후보: 전역 키 스캔
        var g = {};
        try {
          for (var k in window) {
            if (/editorSource|editor_source|blogId|g_blogId/i.test(k)) {
              try { g[k] = String(window[k]).slice(0,60); } catch(e){}
            }
          }
        } catch(e){}
        out.globalCandidates = g;
        return JSON.stringify(out);
      } catch(err){ return JSON.stringify({error:String(err)}); }
    })()`;

    const results = [];
    for (const c of contexts) {
      try {
        const r = await dbgSend(tabId, "Runtime.evaluate", {
          expression: expr,
          contextId: c.id,
          returnByValue: true,
        });
        const val = r && r.result ? r.result.value : undefined;
        results.push({ origin: c.origin, name: c.name, value: val });
      } catch (e) {
        results.push({ origin: c.origin, name: c.name, error: e.message });
      }
    }
    return { success: true, results };
  } catch (e) {
    const hint = /already attached|Another debugger/i.test(e.message)
      ? " (F12 개발자도구를 닫고 다시 시도하세요)"
      : "";
    return { success: false, error: e.message + hint };
  } finally {
    if (onEvent) chrome.debugger.onEvent.removeListener(onEvent);
    if (attached) await dbgDetach(tabId);
  }
}

// ---------------------------------------------------------------------------
// 백그라운드 API 임시저장 (빌드 #30) — 글쓰기 페이지를 미리 열어둘 필요 없음
//
// 열린 글쓰기 탭이 있으면 그걸 쓰고, 없으면 writeUrl 로 "보이지 않는 백그라운드 탭"을
// 자동으로 열어 content script 준비를 기다린 뒤 API_PUBLISH(캡처 없이 자체 조립)로 저장한다.
// 우리가 연 탭이면 저장 후 자동으로 닫는다. (타이핑/창 전환/캡처 전부 없음)
// ---------------------------------------------------------------------------
async function runApiWrite(draft, writeUrl, mode = "temp") {
  const steps = [];
  const rec = (step, ok, detail) => {
    steps.push({ step, ok, detail });
    console.log(LOG, ok ? "✅" : "❌", step, detail || "");
  };

  // 로그인만 돼 있으면 이 URL 이 그 사용자의 글쓰기 페이지로 자동 리다이렉트된다.
  // (blogId 를 미리 몰라도 됨 → 설정 없이 다계정 동작)
  const DEFAULT_WRITE_URL = "https://blog.naver.com/GoBlogWrite.naver";

  const tabs = await chrome.tabs.query({ url: "https://blog.naver.com/*" });
  let writeTab = tabs.find((t) => /PostWriteForm|Redirect=Write|postwrite/i.test(t.url || ""));
  let openedByUs = false;

  if (!writeTab) {
    const url = writeUrl || DEFAULT_WRITE_URL;
    writeTab = await chrome.tabs.create({ url, active: false });
    openedByUs = true;
    rec("글쓰기 탭 자동 열기", true, "백그라운드(비활성)");
    const ready = await waitEditorReady(writeTab.id, 25000);
    rec("content script 준비", ready, ready ? "" : "시간초과(25s)");
    if (!ready) {
      if (openedByUs) await chrome.tabs.remove(writeTab.id).catch(() => {});
      return { success: false, steps };
    }
    await sleep(500);
  } else {
    rec("기존 글쓰기 탭 사용", true, "");
  }

  const res = await sendTab(writeTab.id, { type: "API_PUBLISH", mode, draft });
  const ok = !!(res && res.ok);
  const label = mode === "publish" ? "API 발행" : "API 임시저장";
  rec(label, ok, res ? res.body || res.error || "" : "응답 없음");

  if (openedByUs) {
    await chrome.tabs.remove(writeTab.id).catch(() => {});
    rec("백그라운드 탭 닫기", true, "");
  }
  return { success: ok, steps, serverBody: res && res.body };
}

// popup → background
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "RUN_API_WRITE") {
    runApiWrite(msg.draft, msg.writeUrl, msg.mode).then((result) => {
      const data = { ...result, build: BUILD, ts: Date.now() };
      chrome.storage.local.set({ lastAutofill: data });
      sendResponse(data);
    });
    return true; // 비동기 응답
  }

  if (msg && msg.type === "PROBE_EDITOR") {
    runProbeEditor(msg.tabId).then((result) => {
      const data = { ...result, build: BUILD, ts: Date.now() };
      chrome.storage.local.set({ lastProbeEditor: data });
      sendResponse(data);
    });
    return true; // 비동기 응답
  }

  if (msg && msg.type === "CAPTURE_PUBLISH") {
    runCapturePublish(msg.tabId).then((result) => {
      const data = { ...result, build: BUILD, ts: Date.now() };
      chrome.storage.local.set({ lastCapture: data });
      sendResponse(data);
    });
    return true; // 비동기 응답
  }

  if (msg && msg.type === "RUN_AUTO_WRITE") {
    runAutoWrite(msg.draft, msg.save, msg.writeUrl).then((result) => {
      const data = { ...result, build: BUILD, ts: Date.now() };
      chrome.storage.local.set({ lastAutofill: data });
      sendResponse(data);
    });
    return true;
  }

  if (msg && msg.type === "RUN_BLOCKS") {
    runBlocks(msg.tabId, msg.data).then((result) => {
      const data = { ...result, build: BUILD, ts: Date.now() };
      chrome.storage.local.set({ lastAutofill: data });
      sendResponse(data);
    });
    return true; // 비동기 응답
  }

  if (msg && msg.type === "RUN_SEQUENCE") {
    runSequence(msg.tabId, msg.seq).then((result) => {
      const data = { ...result, build: BUILD, ts: Date.now() };
      chrome.storage.local.set({ lastAutofill: data });
      sendResponse(data);
    });
    return true; // 비동기 응답
  }

  if (msg && msg.type === "RUN_AUTOFILL") {
    runAutofill(msg.tabId, msg.payload).then((result) => {
      const data = { ...result, build: BUILD, ts: Date.now() };
      chrome.storage.local.set({ lastAutofill: data }); // 팝업이 닫혀도 확인 가능
      sendResponse(data);
    });
    return true; // 비동기 응답
  }

  if (msg && msg.type === "RUN_INSERT_IMAGE") {
    runInsertImage(msg.tabId, msg.filePath).then((result) => {
      const data = { ...result, build: BUILD, ts: Date.now() };
      chrome.storage.local.set({ lastAutofill: data });
      sendResponse(data);
    });
    return true; // 비동기 응답
  }

  // 팝업 등에서 데스크톱 앱 연결 상태 조회
  if (msg && msg.type === "BRIDGE_STATUS") {
    sendResponse({
      connected: !!(bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN),
      url: BRIDGE_URL,
      lastEvent: bridgeLastEvent,
    });
    return true;
  }
});

// ===========================================================================
// 데스크톱 앱(exe) 브리지 — 로컬 WebSocket (빌드 #35)
//
// 판매용 Electron 데스크톱 앱이 localhost 에 WS 서버를 연다. 이 확장은 거기에
// 접속해 "발행 작업"을 받아 기존 runApiWrite(RabbitWrite) 로 실행하고 결과를 보고한다.
// 로그인은 사용자의 실제 Chrome 세션을 그대로 쓴다(앱은 계정정보를 다루지 않음).
//
// 프로토콜(JSON):
//   앱→확장:  { type:"PING" }                                        (생존 유지)
//            { type:"PUBLISH", jobId, draft:{title,blocks}, mode, writeUrl }
//   확장→앱:  { type:"HELLO", role:"extension", build }              (접속 직후)
//            { type:"PONG", ts }
//            { type:"JOB_ACK", jobId }                               (작업 접수)
//            { type:"PUBLISH_RESULT", jobId, success, steps, serverBody, error }
// ===========================================================================
const BRIDGE_URL = "ws://127.0.0.1:8765";
let bridgeSocket = null;
let bridgeReconnectTimer = null;
let bridgeLastEvent = "";

function bridgeLog(...a) {
  console.log(LOG, "🔌", ...a);
}

function bridgeSend(obj) {
  if (bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
    bridgeSocket.send(JSON.stringify(obj));
  }
}

function scheduleBridgeReconnect() {
  if (bridgeReconnectTimer) return;
  bridgeReconnectTimer = setTimeout(() => {
    bridgeReconnectTimer = null;
    bridgeConnect();
  }, 3000);
}

function bridgeConnect() {
  if (
    bridgeSocket &&
    (bridgeSocket.readyState === WebSocket.OPEN || bridgeSocket.readyState === WebSocket.CONNECTING)
  ) {
    return; // 이미 연결/연결중
  }
  let sock;
  try {
    sock = new WebSocket(BRIDGE_URL);
  } catch (e) {
    scheduleBridgeReconnect();
    return;
  }
  bridgeSocket = sock;

  sock.onopen = () => {
    bridgeLastEvent = "connected " + new Date().toISOString();
    bridgeLog("데스크톱 앱 연결됨", BRIDGE_URL);
    bridgeSend({ type: "HELLO", role: "extension", build: BUILD });
  };

  sock.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "PING") {
      bridgeSend({ type: "PONG", ts: Date.now() });
      return;
    }
    if (msg.type === "PUBLISH") {
      bridgeLastEvent = "job " + msg.jobId + " @ " + new Date().toISOString();
      bridgeSend({ type: "JOB_ACK", jobId: msg.jobId });
      let result;
      try {
        result = await runApiWrite(msg.draft, msg.writeUrl, msg.mode || "publish");
      } catch (e) {
        result = { success: false, steps: [], error: e.message };
      }
      chrome.storage.local.set({ lastAutofill: { ...result, build: BUILD, ts: Date.now() } });
      bridgeSend({ type: "PUBLISH_RESULT", jobId: msg.jobId, ...result });
    }
  };

  sock.onclose = () => {
    if (bridgeSocket === sock) bridgeSocket = null;
    bridgeLastEvent = "closed " + new Date().toISOString();
    scheduleBridgeReconnect();
  };

  sock.onerror = () => {
    try {
      sock.close();
    } catch {}
  };
}

// 접속 트리거: 시작/설치 시 + 알람으로 주기 재접속(서비스워커가 죽어도 되살아남)
chrome.runtime.onStartup.addListener(bridgeConnect);
chrome.runtime.onInstalled.addListener(bridgeConnect);
chrome.alarms.create("bridge-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "bridge-keepalive") bridgeConnect();
});
bridgeConnect();
