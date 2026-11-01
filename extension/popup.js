/*
 * popup.js - 팝업 UI 로직 (Phase 1 POC) · 빌드 #3
 *
 * 중요: 자동 입력 시 페이지에 포커스가 넘어가면 Chrome 확장 팝업은 자동으로 닫힌다.
 *       (Chrome 기본 동작) 따라서 실행 결과를 팝업에서 직접 보지 못할 수 있다.
 *       → content script 가 결과를 chrome.storage 에 저장하고,
 *         팝업을 다시 열면 마지막 결과를 자동으로 보여준다.
 */

const BUILD = 34; // content.js / background.js 와 동일하게 유지

const $ = (id) => document.getElementById(id);
const statusEl = () => $("status");

function setStatus(text) {
  statusEl().textContent = text;
}
function appendStatus(text) {
  statusEl().textContent += "\n" + text;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isNaverBlog(tab) {
  return tab && tab.url && tab.url.startsWith("https://blog.naver.com/");
}

function sendToContent(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ __error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("ko-KR");
}

// ---------------------------------------------------------------------------
// 저장된 결과 렌더링 (팝업 열릴 때마다 자동 호출)
// ---------------------------------------------------------------------------
function renderAutofill(res) {
  const lines = [`[자동입력 결과 · 빌드 #${res.build} · ${fmtTime(res.ts)}]`];
  (res.steps || []).forEach((s) =>
    lines.push(`${s.ok ? "✅" : "❌"} ${s.step}${s.detail ? " · " + s.detail : ""}`)
  );
  lines.unshift(res.success ? "🎉 완료" : "⚠️ 일부 실패");
  if (res.error) lines.push("오류: " + res.error);
  return lines.join("\n");
}

function renderDiagnose(res) {
  const lines = [
    `[DOM 진단 · 빌드 #${res.build} · ${fmtTime(res.ts)}]`,
    "프레임: " + res.frameUrl,
    "에디터프레임: " + res.isEditorFrame,
  ];
  for (const [key, val] of Object.entries(res.found || {})) {
    if (!val) {
      lines.push(`${key}: ❌ 없음`);
      continue;
    }
    lines.push(
      `${key}: ✅ ${val.selector}\n   text: '${val.text}'\n   문단자체editable: ${val.paragraphIsEditable}\n   editable조상: ${val.editableAncestor}`
    );
    lines.push("   HTML: " + (val.outerHTML || "").replace(/\s+/g, " "));
  }
  if (res.probe) {
    const p = res.probe;
    lines.push("── PROBE (입력 타깃 탐색) ──");
    lines.push("클릭 전 active: " + p.activeBeforeClick);
    lines.push("본문 클릭 후 active: " + (p.activeAfterBodyClick || "-"));
    lines.push("클릭 후 본문editable: " + p.bodyEditableAfterClick);
    lines.push("contenteditable(클릭전): " + JSON.stringify(p.contentEditables));
    lines.push("contenteditable(클릭후): " + JSON.stringify(p.contentEditablesAfterClick));
    lines.push("textarea/input: " + JSON.stringify(p.textareas));
  }
  if (res.imageProbe) {
    const ip = res.imageProbe;
    lines.push("── 이미지 프로브 (Phase 2) ──");
    lines.push("사진버튼 후보:");
    (ip.imageButtons || []).forEach((b, i) =>
      lines.push(
        `  [${i}] cls=${b.cls} aria='${b.aria}' data-name='${b.dataName}' data-log='${b.dataLog}' text='${b.text}'`
      )
    );
    if (!ip.imageButtons || !ip.imageButtons.length) lines.push("  (없음)");
    lines.push("file input: " + JSON.stringify(ip.fileInputs));
    if (ip.toolbarButtons) {
      lines.push("툴바 버튼(heading/divider/quote 찾기용):");
      ip.toolbarButtons.forEach((b) =>
        lines.push(`  name='${b.name}' log='${b.log}' text='${b.text}'`)
      );
    }
  }
  return lines.join("\n");
}

async function loadLastResults() {
  const store = await chrome.storage.local.get(["lastAutofill", "lastDiagnose", "lastCapture"]);
  // 최근순으로 정렬해 가장 최근 결과를 맨 위에 표시
  const items = [
    store.lastAutofill && { ts: store.lastAutofill.ts, text: renderAutofill(store.lastAutofill) },
    store.lastDiagnose && { ts: store.lastDiagnose.ts, text: renderDiagnose(store.lastDiagnose) },
    store.lastCapture && { ts: store.lastCapture.ts, text: renderCapture(store.lastCapture) },
  ].filter(Boolean);

  if (!items.length) {
    setStatus("글쓰기 페이지에서 [자동 입력] / [DOM 진단] / [발행요청 캡처]를 실행하세요.");
    return;
  }
  items.sort((a, b) => b.ts - a.ts);
  setStatus(items.map((i) => i.text).join("\n\n----\n"));
}

// ---------------------------------------------------------------------------
// 자동 입력
// ---------------------------------------------------------------------------
$("run").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그(blog.naver.com) 글쓰기 페이지에서 실행하세요.");
    return;
  }
  const payload = { title: $("title").value, body: $("body").value };
  setStatus(
    "⏳ 입력 중... (상단에 '디버깅 중' 알림바가 뜨는 건 정상입니다)\n" +
      "팝업이 닫히면 다시 열어 결과를 확인하세요."
  );

  // 실제 타이핑은 background(debugger)가 담당한다.
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "RUN_AUTOFILL", tabId: tab.id, payload });
  } catch (e) {
    res = { __error: e.message };
  }
  if (res && res.__error) setStatus("❌ 오류: " + res.__error);
  else if (res) setStatus(renderAutofill(res));
});

// ---------------------------------------------------------------------------
// 이미지 삽입 테스트 (Phase 2)
// ---------------------------------------------------------------------------
$("insertImage").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그 글쓰기 페이지에서 실행하세요.");
    return;
  }
  const filePath = $("imgpath").value.trim();
  if (!filePath) {
    setStatus("❌ 이미지 파일 경로를 입력하세요.");
    return;
  }
  setStatus(
    "⏳ 이미지 업로드 중... (F12는 닫혀 있어야 함, '디버깅 중' 배너 정상)\n" +
      "팝업이 닫히면 다시 열어 결과를 확인하세요."
  );
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "RUN_INSERT_IMAGE", tabId: tab.id, filePath });
  } catch (e) {
    res = { __error: e.message };
  }
  if (res && res.__error) setStatus("❌ 오류: " + res.__error);
  else if (res) setStatus(renderAutofill(res));
});

// ---------------------------------------------------------------------------
// 스타일 진단 (소제목/구분선 드롭다운 옵션 덤프)
// ---------------------------------------------------------------------------
$("probeStyles").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그 글쓰기 페이지에서 실행하세요.");
    return;
  }
  setStatus("⏳ 소제목/구분선 드롭다운 여는 중...");
  const res = await sendToContent(tab.id, { type: "PROBE_STYLES" });
  if (!res || res.__error) {
    setStatus("❌ 응답 없음: " + (res && res.__error ? res.__error : ""));
    return;
  }
  const lines = ["[스타일 진단]", res.note || "", "── 소제목(문단서식) 패널 HTML ──"];
  (res.textFormatHTML || []).forEach((h, i) => lines.push(`[TF${i}] ${h}`));
  if (!res.textFormatHTML || !res.textFormatHTML.length) lines.push("  (못 찾음)");
  lines.push("── 구분선 스타일 패널 HTML ──");
  (res.dividerHTML || []).forEach((h, i) => lines.push(`[DV${i}] ${h}`));
  if (!res.dividerHTML || !res.dividerHTML.length) lines.push("  (못 찾음)");
  setStatus(lines.join("\n"));
});

// ---------------------------------------------------------------------------
// Block Engine 실행 (Phase 3) — 임의 block 배열 순서대로 삽입
// ---------------------------------------------------------------------------
$("runBlocks").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그 글쓰기 페이지에서 실행하세요.");
    return;
  }
  let data;
  try {
    data = JSON.parse($("blocks").value);
  } catch (e) {
    setStatus("❌ JSON 형식 오류: " + e.message);
    return;
  }
  setStatus("⏳ Block Engine 실행 중...\n팝업이 닫히면 다시 열어 결과 확인.");
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "RUN_BLOCKS", tabId: tab.id, data });
  } catch (e) {
    res = { __error: e.message };
  }
  if (res && res.__error) setStatus("❌ 오류: " + res.__error);
  else if (res) setStatus(renderAutofill(res));
});

// ---------------------------------------------------------------------------
// 순서 삽입 테스트: 제목 → 텍스트 → 이미지 → 텍스트 (STEP 6)
// ---------------------------------------------------------------------------
$("runSequence").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그 글쓰기 페이지에서 실행하세요.");
    return;
  }
  const seq = {
    title: $("title").value,
    text1: $("body").value,
    imagePath: $("imgpath").value.trim(),
    text2: $("body2").value,
  };
  setStatus("⏳ 순서 삽입 중 (제목→글→이미지→글)...\n팝업이 닫히면 다시 열어 결과 확인.");
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "RUN_SEQUENCE", tabId: tab.id, seq });
  } catch (e) {
    res = { __error: e.message };
  }
  if (res && res.__error) setStatus("❌ 오류: " + res.__error);
  else if (res) setStatus(renderAutofill(res));
});

// ---------------------------------------------------------------------------
// DOM 진단
// ---------------------------------------------------------------------------
$("diagnose").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그 글쓰기 페이지에서 실행하세요.");
    return;
  }
  setStatus("⏳ DOM 진단 중...");
  const res = await sendToContent(tab.id, { type: "DIAGNOSE" });
  if (!res || res.__error) {
    setStatus("❌ 응답 없음: " + (res && res.__error ? res.__error : "페이지 로딩 후 재시도"));
    return;
  }
  setStatus(renderDiagnose({ ...res, build: BUILD, ts: Date.now() }));
});

// ---------------------------------------------------------------------------
// 임시저장 / 발행하기 (빌드 #18)
// ---------------------------------------------------------------------------
$("saveDraft").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그 글쓰기 페이지에서 실행하세요.");
    return;
  }
  setStatus("⏳ 임시저장 중...");
  const res = await sendToContent(tab.id, { type: "CLICK_SAVE" });
  if (!res || res.__error) setStatus("❌ " + (res && res.__error ? res.__error : "응답 없음"));
  else if (!res.ok) setStatus("❌ " + res.error);
  else setStatus(`✅ 임시저장 클릭됨 (저장수 ${res.before} → ${res.after})`);
});

$("publishPost").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그 글쓰기 페이지에서 실행하세요.");
    return;
  }
  if (!confirm("실제로 블로그에 '발행'합니다. 진행할까요?")) return;
  setStatus("⏳ 발행 중... (설정창 열고 최종 발행)");
  const res = await sendToContent(tab.id, { type: "PUBLISH_POST" });
  if (!res || res.__error) setStatus("❌ " + (res && res.__error ? res.__error : "응답 없음"));
  else if (!res.ok) setStatus("❌ " + res.error);
  else setStatus("🎉 발행 실행됨 (발행 완료 페이지로 이동했는지 확인하세요)");
});

// ---------------------------------------------------------------------------
// 발행 UI 진단 (저장/발행 버튼 + 발행설정 레이어 찾기)
// ---------------------------------------------------------------------------
$("probePublish").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그 글쓰기 페이지에서 실행하세요.");
    return;
  }
  setStatus("⏳ 발행 UI 진단 중... (발행 설정창이 잠깐 열릴 수 있습니다)");
  const res = await sendToContent(tab.id, { type: "PROBE_PUBLISH" });
  if (!res || res.__error) {
    setStatus("❌ 응답 없음: " + (res && res.__error ? res.__error : ""));
    return;
  }
  const lines = ["[발행 UI 진단]", "── 저장/발행 버튼 후보 ──"];
  (res.candidates || []).forEach((c, i) =>
    lines.push(`  [${i}] <${c.tag}> text='${c.text}' cls=${c.cls}`)
  );
  if (!res.candidates || !res.candidates.length) lines.push("  (없음)");
  lines.push(`── 발행설정 레이어 HTML (발행버튼 클릭: ${res.publishClicked}) ──`);
  (res.layerHTML || []).forEach((h, i) => lines.push(`[L${i}] ${h}`));
  if (!res.layerHTML || !res.layerHTML.length) lines.push("  (레이어 못 잡음)");
  setStatus(lines.join("\n"));
});

// ---------------------------------------------------------------------------
// 발행요청 캡처 (빌드 #24) — RabbitWrite 리버싱용
// 버튼을 누르면 Network 캡처를 켜고, 사용자가 에디터에서 직접 [임시저장]/[발행]을
// 누르면 그 요청(URL/postData/documentModel)을 잡아 저장한다.
// ---------------------------------------------------------------------------
function renderCapture(res) {
  const lines = [`[발행요청 캡처 · 빌드 #${res.build} · ${fmtTime(res.ts)}]`];
  lines.unshift(res.success ? "🎉 최종 저장/발행 요청 캡처됨" : "⚠️ 최종 요청 못 잡음(타임아웃?)");
  if (res.error) lines.push("오류: " + res.error);
  (res.captures || []).forEach((c, i) => {
    lines.push(`\n[${i}] ${c.method} ${c.url}`);
    lines.push("postData(" + (c.postData || "").length + "B):");
    lines.push((c.postData || "(없음)").slice(0, 4000));
  });
  if (!res.captures || !res.captures.length) lines.push("캡처된 요청 없음");
  return lines.join("\n");
}

$("capturePublish").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그 글쓰기 페이지에서 실행하세요.");
    return;
  }
  setStatus(
    "📥 캡처 대기 중... (최대 2분)\n" +
      "이제 에디터에서 직접 [임시저장] 또는 [발행]을 누르세요.\n" +
      "F12는 닫혀 있어야 하고, '디버깅 중' 배너는 정상입니다.\n" +
      "요청이 잡히면 팝업을 다시 열어 결과를 확인하세요."
  );
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "CAPTURE_PUBLISH", tabId: tab.id });
  } catch (e) {
    res = { __error: e.message };
  }
  if (res && res.__error) setStatus("❌ 오류: " + res.__error);
  else if (res) setStatus(renderCapture(res));
});

// ---------------------------------------------------------------------------
// API 임시저장 (빌드 #24) — 창 안 열고 RabbitTempPostWrite 로 직접 저장
// 위 Block Engine JSON 을 documentModel 로 변환해, 마지막으로 캡처한 실제 요청
// 템플릿에 얹어 POST 한다. (사전에 [발행요청 캡처]로 임시저장 요청 1회 캡처 필요)
// ---------------------------------------------------------------------------
$("apiTempSave").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그 글쓰기 페이지에서 실행하세요.");
    return;
  }
  const store = await chrome.storage.local.get("lastCapture");
  const cap = store.lastCapture;
  const tmpl =
    cap && (cap.captures || []).find((c) => /RabbitTempPostWrite\.naver/i.test(c.url));
  if (!tmpl || !tmpl.postData) {
    setStatus(
      "❌ 캡처 템플릿이 없습니다.\n먼저 [📥 발행요청 캡처] → 에디터에서 수동 [임시저장] 을 한 번 해서\n" +
        "RabbitTempPostWrite 요청을 캡처하세요."
    );
    return;
  }
  let draft;
  try {
    draft = JSON.parse($("blocks").value);
  } catch (e) {
    setStatus("❌ Block JSON 형식 오류: " + e.message);
    return;
  }
  setStatus("⏳ API 임시저장 중... (창 열지 않음, 타이핑 없음)");
  let res;
  try {
    res = await sendToContent(tab.id, {
      type: "API_PUBLISH",
      mode: "temp",
      templatePostData: tmpl.postData,
      draft,
    });
  } catch (e) {
    res = { __error: e.message };
  }
  if (!res || res.__error) {
    setStatus("❌ " + (res && res.__error ? res.__error : "응답 없음"));
    return;
  }
  const lines = [
    res.ok ? "🎉 API 임시저장 요청 성공" : "❌ 실패",
    `HTTP status: ${res.status}`,
    res.error ? "오류: " + res.error : "",
    `컴포넌트 ${res.componentCount}개 전송`,
    "── 서버 응답 ──",
    res.body || "(없음)",
  ].filter(Boolean);
  setStatus(lines.join("\n"));
});

// ---------------------------------------------------------------------------
// API 임시저장 (캡처 없이·다계정 자동, 빌드 #27)
// templatePostData 없이 호출 → content 가 blogId(URL) + editorSource(즉석 난수) +
// populationParams(기본값) 를 스스로 조립해 POST. editorSource 난수 가설 검증.
// ---------------------------------------------------------------------------
$("apiTempSaveAuto").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그 글쓰기 페이지에서 실행하세요.");
    return;
  }
  let draft;
  try {
    draft = JSON.parse($("blocks").value);
  } catch (e) {
    setStatus("❌ Block JSON 형식 오류: " + e.message);
    return;
  }
  setStatus("⏳ API 임시저장 중 (캡처 없이 자체 조립)...");
  let res;
  try {
    res = await sendToContent(tab.id, { type: "API_PUBLISH", mode: "temp", draft });
  } catch (e) {
    res = { __error: e.message };
  }
  if (!res || res.__error) {
    setStatus("❌ " + (res && res.__error ? res.__error : "응답 없음"));
    return;
  }
  const lines = [
    res.ok ? "🎉 API 임시저장 성공 (캡처 없이!)" : "❌ 실패",
    `HTTP status: ${res.status}`,
    res.error ? "오류: " + res.error : "",
    "모드: " + (res.mode || ""),
    `컴포넌트 ${res.componentCount}개 전송`,
    "── 서버 응답 ──",
    res.body || "(없음)",
  ].filter(Boolean);
  setStatus(lines.join("\n"));
});

// ---------------------------------------------------------------------------
// 백그라운드 저장 (빌드 #30) — 글쓰기 페이지를 미리 열어둘 필요 없음
// 열린 글쓰기 탭이 없으면 설정의 writeUrl 로 백그라운드 탭을 몰래 열어 저장 후 닫는다.
// (활성 탭이 네이버가 아니어도 됨 → background 오케스트레이션)
// ---------------------------------------------------------------------------
$("bgApiSave").addEventListener("click", async () => {
  let draft;
  try {
    draft = JSON.parse($("blocks").value);
  } catch (e) {
    setStatus("❌ Block JSON 형식 오류: " + e.message);
    return;
  }
  const store = await chrome.storage.local.get("writeUrl");
  setStatus("⏳ 백그라운드 저장 중... (글쓰기 탭이 없으면 몰래 열고 저장 후 닫음)");
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: "RUN_API_WRITE",
      draft,
      writeUrl: store.writeUrl || "",
    });
  } catch (e) {
    res = { __error: e.message };
  }
  if (!res || res.__error) {
    setStatus("❌ " + (res && res.__error ? res.__error : "응답 없음"));
    return;
  }
  const lines = [res.success ? "🎉 백그라운드 임시저장 성공" : "⚠️ 실패"];
  (res.steps || []).forEach((s) =>
    lines.push(`${s.ok ? "✅" : "❌"} ${s.step}${s.detail ? " · " + String(s.detail).slice(0, 90) : ""}`)
  );
  setStatus(lines.join("\n"));
});

// ---------------------------------------------------------------------------
// 에디터 내부 진단 (빌드 #26) — 다계정 자동화용
// 페이지 메인 월드에서 SmartEditor 객체/editorSource/저장 메서드를 탐색해,
// 캡처 의존 없이 자동화하는 길(A 직접 재구성 / B 에디터 저장 호출)을 판단한다.
// ---------------------------------------------------------------------------
$("probeEditor").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!isNaverBlog(tab)) {
    setStatus("❌ 네이버 블로그 글쓰기 페이지에서 실행하세요.");
    return;
  }
  setStatus("⏳ 에디터 내부 진단 중... (F12 닫혀 있어야 함, '디버깅 중' 배너 정상)");
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "PROBE_EDITOR", tabId: tab.id });
  } catch (e) {
    res = { __error: e.message };
  }
  if (!res || res.__error) {
    setStatus("❌ " + (res && res.__error ? res.__error : "응답 없음"));
    return;
  }
  const lines = [`[에디터 내부 진단 · 빌드 #${res.build} · ${fmtTime(res.ts)}]`];
  if (res.error) lines.push("오류: " + res.error);
  (res.results || []).forEach((r, i) => {
    let v = r.value;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {}
    }
    lines.push(`\n[ctx ${i}] ${r.name || ""} ${r.origin || ""}`);
    if (r.error) {
      lines.push("  err: " + r.error);
      return;
    }
    if (!v) {
      lines.push("  (값 없음)");
      return;
    }
    lines.push("  url: " + (v.url || "").slice(0, 80));
    lines.push("  SmartEditor: " + v.hasSmartEditor);
    if (v.hasSmartEditor) {
      lines.push("  editorKeys: " + JSON.stringify(v.editorKeys));
      lines.push("  setDocumentData: " + v.hasSetDocumentData + " / getDocumentData: " + v.hasGetDocumentData);
      lines.push("  저장관련 메서드: " + JSON.stringify(v.editorMethods));
      lines.push("  관련 속성: " + JSON.stringify(v.editorProps));
    }
    if (v.globalCandidates && Object.keys(v.globalCandidates).length)
      lines.push("  전역후보: " + JSON.stringify(v.globalCandidates));
    if (v.error) lines.push("  page err: " + v.error);
  });
  if (!res.results || !res.results.length) lines.push("컨텍스트 없음");
  setStatus(lines.join("\n"));
});

// ---------------------------------------------------------------------------
// 키워드 확장 도구 열기 (새 탭)
// ---------------------------------------------------------------------------
$("openKeywords").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("keywords.html") });
});

// ---------------------------------------------------------------------------
// 초기화: 빌드 번호 표시 + 마지막 결과 자동 로드
// ---------------------------------------------------------------------------
$("build").textContent = "빌드 #" + BUILD;
loadLastResults();
