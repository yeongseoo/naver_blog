/*
 * 네이버 블로그 자동 입력 - Content Script (Phase 1 POC)
 *
 * 목표: 네이버 블로그 글쓰기 페이지(SmartEditor ONE)를 감지하고
 *       제목/본문을 자동으로 입력한다.
 *
 * 설계 원칙:
 *  - 에디터가 로딩되기 전에 실행되지 않도록 "감지 후 입력" 흐름 사용.
 *  - 무한 polling 금지. timeout + 최대 재시도 횟수로 제한.
 *  - selector 는 상단 SELECTORS 에 모아 관리 (네이버 DOM 변경 대응).
 *  - 모든 단계에 로그를 남긴다.
 *
 * 주의: 네이버 에디터는 iframe(mainFrame) 안에서 동작할 수 있어
 *       manifest 에서 all_frames:true 로 모든 프레임에 주입한다.
 *       실제 에디터가 있는 프레임만 동작하고 나머지는 무시한다.
 */

(() => {
  "use strict";

  const BUILD = 34; // 수정할 때마다 +1
  const LOG_PREFIX = `[네이버자동입력 #${BUILD}]`;
  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  /** 결과를 storage 에 저장 (팝업이 닫혀도 다시 열면 볼 수 있도록) */
  function saveResult(key, data) {
    try {
      chrome.storage.local.set({ [key]: { ...data, build: BUILD, ts: Date.now() } });
    } catch (e) {
      warn("storage 저장 실패", e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Selector 관리 (DOM 변경 시 여기만 수정)
  // SmartEditor ONE(SE3) 기준. 여러 후보를 두어 안정성을 높인다.
  // ---------------------------------------------------------------------------
  const SELECTORS = {
    // 에디터 전체 컨테이너 (존재 여부로 "에디터 프레임"인지 판단)
    editorRoot: [
      ".se-container",
      ".se-canvas",
      "#SE-",
      ".se-main-container",
    ],
    // 제목 입력 영역 (contenteditable)
    title: [
      ".se-documentTitle .se-text-paragraph",
      ".se-title-text .se-text-paragraph",
      ".se-section-documentTitle .se-text-paragraph",
    ],
    // 본문 첫 문단 (contenteditable)
    body: [
      ".se-component.se-text .se-text-paragraph",
      ".se-section-text .se-text-paragraph",
      ".se-module-text .se-text-paragraph",
    ],
    // 사진(이미지) 버튼 — 툴바 우선, 삽입메뉴 fallback
    imageButton: [
      "button.se-image-toolbar-button",
      'button[data-name="image"][data-log="dot.img"]',
      "button.se-insert-menu-button-image",
      'button[data-name="image"]',
    ],
    // 삽입된 이미지 컴포넌트 (검증용)
    imageComponent: [".se-component.se-image", ".se-image-resource"],
    // 인용구 버튼
    quoteButton: ['button[data-name="quotation"][data-log="dot.quota"]'],
    // 구분선 버튼
    dividerButton: ['button[data-name="horizontal-line"][data-log="dot.horizt"]'],
    // 발행/저장 버튼 (클래스 해시는 변하므로 prefix 매칭)
    saveButton: ['button[class*="save_btn__"]'],
    saveCount: ['button[class*="save_count_btn__"]'],
    publishOpenButton: ['button[class*="publish_btn__"]'],
    publishConfirmButton: ['button[class*="confirm_btn__"]'],
  };

  // 감지 설정 (무한 polling 방지)
  const DETECT = {
    intervalMs: 500, // 재시도 간격
    timeoutMs: 15000, // 최대 대기 시간
  };

  // ---------------------------------------------------------------------------
  // 유틸
  // ---------------------------------------------------------------------------

  /** 후보 selector 배열에서 처음 발견되는 요소 반환 */
  function queryFirst(selectorList, root = document) {
    for (const sel of selectorList) {
      try {
        const el = root.querySelector(sel);
        if (el) return { el, selector: sel };
      } catch (e) {
        /* 잘못된 selector 무시 */
      }
    }
    return null;
  }

  /** 이 프레임이 에디터 프레임인지 (에디터 root 존재 여부) */
  function isEditorFrame() {
    return queryFirst(SELECTORS.editorRoot) !== null;
  }

  /**
   * 요소가 나타날 때까지 timeout/interval 기반으로 대기.
   * 무한 반복 아님 — timeout 초과 시 reject.
   */
  function waitForElement(selectorList, { intervalMs, timeoutMs }) {
    return new Promise((resolve, reject) => {
      const started = Date.now();

      const found = queryFirst(selectorList);
      if (found) return resolve(found);

      const timer = setInterval(() => {
        const hit = queryFirst(selectorList);
        if (hit) {
          clearInterval(timer);
          return resolve(hit);
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(
            new Error(
              `요소를 찾지 못했습니다 (timeout ${timeoutMs}ms): ${selectorList.join(", ")}`
            )
          );
        }
      }, intervalMs);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 실제 마우스 클릭 시뮬레이션 (에디터가 편집 컨텍스트를 활성화하도록) */
  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + Math.min(rect.width / 2, 10);
    const cy = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  /** 진짜 편집 가능한 contenteditable 요소를 찾는다 (paragraph 자신 또는 조상) */
  function resolveEditable(el) {
    if (el.isContentEditable) {
      // 가장 가까운 contenteditable="true" 경계를 찾는다
      return el.closest('[contenteditable="true"]') || el;
    }
    return el;
  }

  /** paragraph 안 placeholder(span.se-placeholder) 제외한 실제 입력 텍스트 */
  function readEditableText(paragraphEl) {
    const clone = paragraphEl.cloneNode(true);
    clone.querySelectorAll(".se-placeholder, .__se_placeholder").forEach((n) => n.remove());
    return (clone.textContent || "").trim();
  }

  /**
   * SmartEditor ONE 문단에 텍스트 입력.
   * 핵심: 단순 focus 가 아니라 "실제 클릭"으로 편집 컨텍스트를 활성화한 뒤
   *       execCommand('insertText') 로 입력해야 에디터 내부 모델에 반영된다.
   *
   * @param paragraphEl selector 로 찾은 .se-text-paragraph
   */
  async function typeIntoEditable(paragraphEl, text) {
    paragraphEl.scrollIntoView({ block: "center" });

    // 1) 실제 클릭으로 편집 시작 (placeholder 제거 + 캐럿 배치)
    simulateClick(paragraphEl);
    await sleep(80);

    const editable = resolveEditable(paragraphEl);
    editable.focus();
    await sleep(50);

    // 2) 캐럿을 문단 끝으로 이동
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(paragraphEl);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      warn("selection 설정 실패", e.message);
    }

    // 3) 입력 (beforeinput → execCommand insertText)
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch (e) {
      ok = false;
    }
    await sleep(80);

    let current = readEditableText(paragraphEl);

    // 4) 미반영 시 fallback: paste 이벤트 시뮬레이션 (에디터 모델을 통해 삽입)
    if (!current.includes(text.slice(0, 5))) {
      warn("execCommand 미반영 → paste 이벤트 fallback");
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        editable.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt })
        );
      } catch (e) {
        warn("paste fallback 실패", e.message);
      }
      await sleep(80);
      current = readEditableText(paragraphEl);
    }

    const success = current.includes(text.slice(0, 5));
    log("입력 후 문단 텍스트:", JSON.stringify(current));
    return success;
  }

  // ---------------------------------------------------------------------------
  // 메인 동작
  // ---------------------------------------------------------------------------

  /** 제목/본문 자동 입력 실행 */
  async function runAutoFill(payload) {
    const steps = [];
    const record = (step, ok, detail) => {
      steps.push({ step, ok, detail });
      log(`${ok ? "✅" : "❌"} ${step}`, detail || "");
    };

    try {
      // 1) 제목 요소 대기
      const titleHit = await waitForElement(SELECTORS.title, DETECT);
      record("제목 요소 감지", true, titleHit.selector);

      // 2) 제목 입력
      const titleOk = await typeIntoEditable(titleHit.el, payload.title);
      record("제목 입력", titleOk, payload.title);

      // 3) 본문 요소 대기
      const bodyHit = await waitForElement(SELECTORS.body, DETECT);
      record("본문 요소 감지", true, bodyHit.selector);

      // 4) 본문 입력
      const bodyOk = await typeIntoEditable(bodyHit.el, payload.body);
      record("본문 입력", bodyOk, payload.body.slice(0, 20) + "...");

      const success = titleOk && bodyOk;
      return { success, steps };
    } catch (err) {
      record("실행 오류", false, err.message);
      return { success: false, steps, error: err.message };
    }
  }

  /** 요소를 사람이 읽을 수 있는 한 줄로 요약 */
  function describeEl(el) {
    if (!el) return "null";
    const tag = el.tagName ? el.tagName.toLowerCase() : "?";
    const id = el.id ? "#" + el.id : "";
    const cls = el.className && typeof el.className === "string"
      ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".")
      : "";
    const ce = el.getAttribute && el.getAttribute("contenteditable");
    return `${tag}${id}${cls}${ce ? " [contenteditable=" + ce + "]" : ""}`;
  }

  /**
   * 프로브: 본문 문단을 "실제 클릭"한 뒤 무엇이 편집 대상이 되는지 관찰.
   * SmartEditor ONE 의 실제 입력 타깃(숨은 editable/textarea)을 찾기 위함.
   */
  async function probeEditor() {
    const probe = {};
    probe.activeBeforeClick = describeEl(document.activeElement);

    // 문서 전체에서 편집 가능한 요소/입력 요소 스캔
    probe.contentEditables = Array.from(
      document.querySelectorAll('[contenteditable="true"], [contenteditable=""]')
    )
      .slice(0, 10)
      .map(describeEl);
    probe.textareas = Array.from(document.querySelectorAll("textarea, input[type=text]"))
      .slice(0, 10)
      .map(describeEl);

    // 본문 문단 클릭 후 activeElement 변화 관찰
    const bodyHit = queryFirst(SELECTORS.body);
    if (bodyHit) {
      simulateClick(bodyHit.el);
      // 클릭이 span(placeholder)에 더 잘 먹을 수도 있어 첫 span 도 클릭
      const innerSpan = bodyHit.el.querySelector("span");
      if (innerSpan) simulateClick(innerSpan);
      await sleep(200);
      probe.activeAfterBodyClick = describeEl(document.activeElement);
      probe.bodyEditableAfterClick = bodyHit.el.isContentEditable;
      probe.contentEditablesAfterClick = Array.from(
        document.querySelectorAll('[contenteditable="true"]')
      )
        .slice(0, 10)
        .map(describeEl);
    }
    return probe;
  }

  /**
   * 이미지 프로브: 이미지 삽입에 필요한 요소 탐색.
   *  - 툴바의 "사진" 버튼 후보
   *  - 문서 내 file input (사진 업로드용 숨은 input 포함)
   */
  function probeImage() {
    const info = {};

    // 이미지/사진과 관련돼 보이는 버튼 수집
    const buttons = Array.from(document.querySelectorAll("button, a[role=button]"));
    info.imageButtons = buttons
      .map((b) => ({
        cls: (b.className || "").toString().slice(0, 60),
        aria: b.getAttribute("aria-label") || "",
        title: b.getAttribute("title") || "",
        dataName: b.getAttribute("data-name") || "",
        dataLog: b.getAttribute("data-log") || "",
        text: (b.textContent || "").trim().slice(0, 20),
      }))
      .filter((b) =>
        /이미지|사진|image|photo|picture/i.test(
          [b.cls, b.aria, b.title, b.dataName, b.dataLog, b.text].join(" ")
        )
      )
      .slice(0, 12);

    // file input 전부 (숨겨진 것 포함)
    info.fileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .slice(0, 10)
      .map((el) => ({
        desc: describeEl(el),
        accept: el.getAttribute("accept") || "",
        multiple: el.multiple,
        hidden: el.offsetParent === null,
      }));

    // 툴바/삽입메뉴 버튼 전부 요약 (heading/divider/quote 버튼 식별용)
    info.toolbarButtons = Array.from(
      document.querySelectorAll(
        ".se-toolbar button, .se-insert-menu button, button[class*='toolbar'], button[class*='menu-button']"
      )
    )
      .slice(0, 40)
      .map((b) => ({
        name: b.getAttribute("data-name") || "",
        log: b.getAttribute("data-log") || "",
        text: (b.textContent || "").trim().slice(0, 12),
      }))
      .filter((b) => b.name || b.log || b.text);

    return info;
  }

  /** 현재 프레임의 에디터 구조를 진단 (selector + 입력 타깃 확인용) */
  async function diagnose() {
    const report = {
      frameUrl: location.href,
      isEditorFrame: isEditorFrame(),
      found: {},
    };
    for (const [key, list] of Object.entries(SELECTORS)) {
      const hit = queryFirst(list);
      if (!hit) {
        report.found[key] = null;
        continue;
      }
      const editable = hit.el.closest('[contenteditable="true"]');
      report.found[key] = {
        selector: hit.selector,
        text: (hit.el.textContent || "").slice(0, 30),
        paragraphIsEditable: hit.el.isContentEditable,
        editableAncestor: editable ? describeEl(editable) : "없음",
        outerHTML: hit.el.outerHTML.slice(0, 400),
      };
    }

    // 입력 타깃 프로브
    report.probe = await probeEditor();
    // 이미지 삽입 프로브 (Phase 2)
    report.imageProbe = probeImage();

    log("진단 결과", report);
    console.log(LOG_PREFIX, "PROBE:", report.probe);
    return report;
  }

  /**
   * 입력 대상 문단 요소를 반환.
   *  - "title"    : 제목
   *  - "body"     : 본문 첫 문단
   *  - "bodyLast" : 본문 마지막 문단 (이미지 뒤 새 문단 등)
   */
  function getFieldEl(field) {
    if (field === "title") return queryFirst(SELECTORS.title);
    if (field === "bodyLast") {
      const ps = document.querySelectorAll(".se-component.se-text .se-text-paragraph");
      if (ps.length) return { el: ps[ps.length - 1], selector: "body[last]" };
      return null;
    }
    return queryFirst(SELECTORS.body); // 기본: 본문 첫 문단
  }

  // ---------------------------------------------------------------------------
  // Block → documentModel 변환 (빌드 #24) — RabbitWrite API 발행용
  //
  // 실제 캡처한 RabbitTempPostWrite.naver 의 documentModel 스키마(version 2.10.2)를 따른다.
  //   documentTitle: { title:[paragraph], subTitle, align, @ctype }
  //   text:          { value:[paragraph], @ctype }
  //   paragraph:     { nodes:[textNode], @ctype:"paragraph" }
  //   textNode:      { value, @ctype:"textNode" }
  // (heading/quote/image/divider 정식 스키마는 각각 캡처 확보 후 확장 예정.
  //  현재 MVP: heading/quote 는 일반 text 문단으로, image/divider 는 건너뜀)
  // ---------------------------------------------------------------------------
  function seId() {
    const uuid =
      (crypto.randomUUID && crypto.randomUUID()) ||
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
    return "SE-" + uuid;
  }
  function seDocId() {
    // 26자 Crockford base32 (ULID 형태)
    const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let s = "";
    for (let i = 0; i < 26; i++) s += A[(Math.random() * 32) | 0];
    return s;
  }
  function seTextNode(value) {
    return { id: seId(), value: String(value == null ? "" : value), "@ctype": "textNode" };
  }
  function seParagraph(value) {
    return { id: seId(), nodes: [seTextNode(value)], "@ctype": "paragraph" };
  }
  function buildDocumentModel(draft) {
    const components = [];
    components.push({
      id: seId(),
      layout: "default",
      title: [seParagraph(draft.title || "")],
      subTitle: null,
      align: "left",
      "@ctype": "documentTitle",
    });

    const DIVIDER_LAYOUTS = ["default", "line1", "line5", "line6", "line7"];

    for (const b of draft.blocks || []) {
      if (b.type === "text") {
        components.push({
          id: seId(),
          layout: "default",
          value: [seParagraph(b.content || "")],
          "@ctype": "text",
        });
      } else if (b.type === "heading") {
        // 소제목: documentTitle 처럼 value 가 아니라 title 배열을 쓴다
        components.push({
          id: seId(),
          layout: "default",
          title: [seParagraph(b.content || "")],
          "@ctype": "sectionTitle",
        });
      } else if (b.type === "quote") {
        components.push({
          id: seId(),
          layout: "default",
          value: [seParagraph(b.content || "")],
          source: null,
          "@ctype": "quotation",
        });
      } else if (b.type === "divider") {
        const layout = DIVIDER_LAYOUTS.includes(b.style) ? b.style : "default";
        components.push({ id: seId(), layout, "@ctype": "horizontalLine" });
      } else if (b.type === "image") {
        // 완전한 image 스키마(src/path/domain/dimensions)는 업로드 후에만 확보 가능 → 현재 생략
        // (업로드 서비스 연결 단계에서 채움)
      }
    }

    return {
      documentId: "",
      document: {
        version: "2.10.2",
        theme: "default",
        language: "ko-KR",
        id: seDocId(),
        components,
        di: { dif: false, dio: [{ dis: "N", dia: { t: 0, p: 0, st: 12, sk: 1 } }] },
      },
    };
  }

  /** editorSource 후보: 16바이트 난수의 base64 (클라이언트 생성 nonce 가설 검증용) */
  function b64Random16() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    let s = "";
    for (const b of a) s += String.fromCharCode(b);
    return btoa(s);
  }

  /** populationParams 기본값 조립 (캡처 없이 다계정). 캡처값 스키마를 따름. */
  function buildPopulationParams() {
    return {
      configuration: {
        openType: 2,
        commentYn: true,
        searchYn: true,
        sympathyYn: true,
        scrapType: 2,
        outSideAllowYn: true,
        twitterPostingYn: false,
        facebookPostingYn: false,
        cclYn: false,
      },
      populationMeta: {
        categoryId: 0, // 기본 카테고리 (사용자마다 다르므로 0). 필요시 라이브로 교체
        logNo: null,
        directorySeq: 0,
        directoryDetail: null,
        mrBlogTalkCode: null,
        postWriteTimeType: "now",
        tags: null,
        moviePanelParticipation: false,
        greenReviewBannerYn: false,
        continueSaved: false,
        noticePostYn: false,
        autoByCategoryYn: false,
        postLocationSupportYn: false,
        postLocationJson: null,
        thisDayPostInfo: null,
        scrapYn: false,
        autoSaveNo: Date.now(),
      },
      editorSource: b64Random16(),
    };
  }

  // ---------------------------------------------------------------------------
  // popup 과의 메시지 통신
  // 에디터가 없는 프레임은 응답하지 않는다 (editor 프레임만 처리).
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === "PING") {
      // 에디터 프레임만 응답
      if (isEditorFrame()) {
        sendResponse({ ok: true, frameUrl: location.href });
      }
      return; // 비에디터 프레임은 무응답
    }

    if (message.type === "DIAGNOSE") {
      if (!isEditorFrame()) return;
      diagnose().then((report) => {
        saveResult("lastDiagnose", report); // 팝업이 닫혀도 볼 수 있게 저장
        sendResponse(report);
      });
      return true; // 비동기 응답
    }

    if (message.type === "AUTOFILL") {
      if (!isEditorFrame()) return; // 에디터 프레임만 처리
      runAutoFill(message.payload).then((result) => {
        saveResult("lastAutofill", result); // 팝업이 닫혀도 볼 수 있게 저장
        sendResponse(result);
      });
      return true; // 비동기 응답
    }

    // --- 빌드 #24: RabbitWrite API 발행 (창 안 열고, 타이핑 없이) ---
    // 캡처한 실제 요청(templatePostData)을 재사용하고 documentModel 만 우리 글로 교체해
    // blog.naver.com 컨텍스트에서 그대로 POST 한다. (쿠키는 credentials:include 로 자동 첨부)
    if (message.type === "API_PUBLISH") {
      if (!isEditorFrame()) return;
      (async () => {
        try {
          const documentModel = buildDocumentModel(message.draft || {});
          let params;
          let mode;
          if (message.templatePostData) {
            // (구) 캡처 재사용 경로: documentModel 만 교체
            params = new URLSearchParams(message.templatePostData);
            params.set("documentModel", JSON.stringify(documentModel));
            mode = "template";
          } else {
            // (신) 캡처 없이 자체 조립 경로 — 다계정: blogId=URL, editorSource=즉석 난수
            const blogId = new URLSearchParams(location.search).get("blogId");
            if (!blogId) {
              sendResponse({ ok: false, error: "URL 에서 blogId 를 찾지 못함" });
              return;
            }
            params = new URLSearchParams();
            params.set("blogId", blogId);
            params.set("documentModel", JSON.stringify(documentModel));
            params.set(
              "mediaResources",
              JSON.stringify({ image: [], video: [], file: [] })
            );
            params.set("populationParams", JSON.stringify(buildPopulationParams()));
            params.set("productApiVersion", "v1");
            mode = "selfContained(blogId=" + blogId + ")";
          }

          const endpoint =
            message.mode === "publish" ? "/RabbitWrite.naver" : "/RabbitTempPostWrite.naver";
          const res = await fetch("https://blog.naver.com" + endpoint, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
            body: params.toString(),
          });
          const text = await res.text();
          log("API_PUBLISH", mode, endpoint, res.status, text.slice(0, 200));
          sendResponse({
            ok: res.ok,
            status: res.status,
            body: text.slice(0, 1500),
            mode,
            componentCount: documentModel.document.components.length,
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    // --- 빌드 #5: background(debugger) 방식 지원 ---
    // 필드를 실제 클릭해 에디터의 입력 위치를 지정한다. (실제 타이핑은 background가 담당)
    if (message.type === "CLICK_FIELD") {
      if (!isEditorFrame()) return;
      const hit = getFieldEl(message.field);
      if (!hit) {
        sendResponse({ ok: false, error: "요소 없음" });
        return;
      }
      hit.el.scrollIntoView({ block: "center" });
      simulateClick(hit.el);
      const inner = hit.el.querySelector("span.__se-node") || hit.el.querySelector("span");
      if (inner) simulateClick(inner);
      const r = hit.el.getBoundingClientRect();
      setTimeout(
        () => sendResponse({ ok: true, rect: { x: r.left + 10, y: r.top + r.height / 2 } }),
        120
      );
      return true; // 비동기 응답 (클릭 반영 대기)
    }

    // 입력 결과(placeholder 제외 실제 텍스트) 읽어 검증에 사용
    if (message.type === "READ_FIELD") {
      if (!isEditorFrame()) return;
      const hit = getFieldEl(message.field);
      sendResponse({ text: hit ? readEditableText(hit.el) : "" });
      return;
    }

    // --- 빌드 #7: 이미지 삽입 ---
    // 사진 버튼 클릭 → (background가 debugger로 파일 선택창을 가로채 파일 지정)
    if (message.type === "CLICK_IMAGE_BUTTON") {
      if (!isEditorFrame()) return;
      const hit = queryFirst(SELECTORS.imageButton);
      if (!hit) {
        sendResponse({ ok: false, error: "사진 버튼 없음" });
        return;
      }
      hit.el.scrollIntoView({ block: "center" });
      simulateClick(hit.el);
      sendResponse({ ok: true, selector: hit.selector });
      return;
    }

    // 삽입된 이미지 개수 (업로드 성공 검증용)
    if (message.type === "COUNT_IMAGES") {
      if (!isEditorFrame()) return;
      sendResponse({
        seImage: document.querySelectorAll(".se-component.se-image").length,
        imgInMain: document.querySelectorAll(
          ".se-main-container img, .se-content img, .se-viewer img"
        ).length,
      });
      return;
    }

    // --- 빌드 #17: 저장/발행 UI 진단 ---
    // 저장/발행 버튼 후보 + 발행 버튼 클릭 시 열리는 발행설정 레이어 HTML 덤프
    if (message.type === "PROBE_PUBLISH") {
      if (!isEditorFrame()) return;
      (async () => {
        const out = { candidates: [], layerHTML: [], publishClicked: false };
        const clickable = Array.from(document.querySelectorAll("button, a, [role='button']"));

        // 저장/발행 관련 후보 버튼
        out.candidates = clickable
          .filter((el) => {
            const t = (el.textContent || "").trim();
            const c = (el.className || "").toString();
            return /발행|저장/.test(t) || /publish|save/i.test(c);
          })
          .slice(0, 25)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || "").toString().slice(0, 70),
            text: (el.textContent || "").trim().slice(0, 24),
          }));

        // "발행" 버튼(짧은 텍스트) 클릭 → 발행설정 레이어 캡처
        const pub = clickable.find((el) => {
          const t = (el.textContent || "").trim();
          return t === "발행" || (/발행/.test(t) && t.length <= 6);
        });
        if (pub) {
          const panelSel =
            "[class*='layer'],[class*='popup'],[class*='publish'],[class*='option'],[role='dialog']";
          const before = new Set(
            Array.from(document.querySelectorAll(panelSel)).filter((e) => e.offsetParent !== null)
          );
          simulateClick(pub);
          await sleep(600);
          const opened = Array.from(document.querySelectorAll(panelSel)).filter(
            (e) => e.offsetParent !== null && !before.has(e)
          );
          out.layerHTML = opened
            .map((e) => e.outerHTML.replace(/\s+/g, " ").slice(0, 1400))
            .slice(0, 3);
          out.publishClicked = true;
        }
        console.log(LOG_PREFIX, "PROBE_PUBLISH", out);
        sendResponse(out);
      })();
      return true;
    }

    // --- 빌드 #18: 임시저장 ---
    if (message.type === "CLICK_SAVE") {
      if (!isEditorFrame()) return;
      (async () => {
        const btn = queryFirst(SELECTORS.saveButton);
        if (!btn) {
          sendResponse({ ok: false, error: "저장 버튼 없음" });
          return;
        }
        const countEl = queryFirst(SELECTORS.saveCount);
        const before = countEl ? countEl.el.textContent.trim() : "?";
        simulateClick(btn.el);
        await sleep(1200);
        const countEl2 = queryFirst(SELECTORS.saveCount);
        const after = countEl2 ? countEl2.el.textContent.trim() : "?";
        sendResponse({ ok: true, before, after });
      })();
      return true;
    }

    // --- 빌드 #18: 발행 (설정창 열기 → 최종 발행) ---
    if (message.type === "PUBLISH_POST") {
      if (!isEditorFrame()) return;
      (async () => {
        const open = queryFirst(SELECTORS.publishOpenButton);
        if (!open) {
          sendResponse({ ok: false, error: "발행 버튼 없음" });
          return;
        }
        simulateClick(open.el); // 발행 설정창 열기
        await sleep(800);
        const confirm = queryFirst(SELECTORS.publishConfirmButton);
        if (!confirm) {
          sendResponse({ ok: false, error: "최종 발행 버튼 없음(설정창 미개방)" });
          return;
        }
        simulateClick(confirm.el); // 최종 발행
        await sleep(500);
        sendResponse({ ok: true });
      })();
      return true;
    }

    // --- 빌드 #10: 툴바 버튼 클릭 (구분선/인용구) ---
    if (message.type === "CLICK_TOOLBAR") {
      if (!isEditorFrame()) return;
      const map = { quote: SELECTORS.quoteButton, divider: SELECTORS.dividerButton };
      const list = map[message.key];
      const hit = list ? queryFirst(list) : null;
      if (!hit) {
        sendResponse({ ok: false, error: message.key + " 버튼 없음" });
        return;
      }
      hit.el.scrollIntoView({ block: "center" });
      simulateClick(hit.el);
      sendResponse({ ok: true, selector: hit.selector });
      return;
    }

    // 소제목(문단서식) + 구분선 스타일 드롭다운을 열어, "새로 나타난 패널"의 HTML을 덤프
    if (message.type === "PROBE_STYLES") {
      if (!isEditorFrame()) return;
      (async () => {
        const out = { textFormatHTML: [], dividerHTML: [], note: "" };

        // 드롭다운이 활성화되도록 본문에 먼저 caret
        const bodyHit = queryFirst(SELECTORS.body);
        if (bodyHit) {
          simulateClick(bodyHit.el);
          await sleep(250);
        }

        // 후보 패널 요소들 (열리면 offsetParent 가 생김)
        const panelEls = () =>
          Array.from(
            document.querySelectorAll(
              "[class*='layer'],[class*='panel'],[class*='option'],[class*='dropdown'],[role='menu'],ul"
            )
          );
        const visibleSet = () => new Set(panelEls().filter((el) => el.offsetParent !== null));

        // 클릭 전/후 비교로 "새로 열린 패널" HTML 추출
        async function openAndCapture(btn) {
          if (!btn) return [];
          const before = visibleSet();
          simulateClick(btn);
          await sleep(500);
          const opened = panelEls().filter(
            (el) => el.offsetParent !== null && !before.has(el)
          );
          const html = opened
            .map((el) => el.outerHTML.replace(/\s+/g, " ").slice(0, 700))
            .slice(0, 4);
          simulateClick(btn); // 닫기
          await sleep(250);
          return html;
        }

        const tf = queryFirst(['button[data-name="text-format"]']);
        out.textFormatHTML = await openAndCapture(tf ? tf.el : null);

        const hbs = Array.from(document.querySelectorAll('button[data-name="horizontal-line"]'));
        const dd =
          hbs.find((b) => (b.getAttribute("data-log") || "") === "") || hbs[hbs.length - 1];
        out.dividerHTML = await openAndCapture(dd || null);

        if (!out.textFormatHTML.length && !out.dividerHTML.length)
          out.note = "새 패널을 못 잡음 (드롭다운 미개방 가능)";
        console.log(LOG_PREFIX, "PROBE_STYLES", out);
        sendResponse(out);
      })();
      return true; // 비동기
    }

    // --- 빌드 #14: 소제목 서식 적용 ---
    // 현재 문단에 "소제목(sectionTitle)" 문단서식 적용
    if (message.type === "APPLY_HEADING") {
      if (!isEditorFrame()) return;
      (async () => {
        const opener = document.querySelector('button[data-name="text-format"][data-log="prt.fmt"]');
        if (!opener) {
          sendResponse({ ok: false, error: "text-format opener 없음" });
          return;
        }
        simulateClick(opener);
        await sleep(400);
        const opt = document.querySelector('button[data-name="text-format"][data-value="sectionTitle"]');
        if (!opt) {
          simulateClick(opener); // 닫기
          sendResponse({ ok: false, error: "sectionTitle 옵션 없음" });
          return;
        }
        simulateClick(opt);
        await sleep(200);
        sendResponse({ ok: true });
      })();
      return true;
    }

    // --- 빌드 #14: 스타일 지정 구분선 삽입 ---
    // value: "default" | "line1" | "line2" ...
    if (message.type === "INSERT_DIVIDER_STYLE") {
      if (!isEditorFrame()) return;
      (async () => {
        const hbs = Array.from(document.querySelectorAll('button[data-name="horizontal-line"]'));
        const opener = hbs.find((b) => (b.getAttribute("data-log") || "") === "") || hbs[hbs.length - 1];
        if (!opener) {
          sendResponse({ ok: false, error: "구분선 선택 opener 없음" });
          return;
        }
        simulateClick(opener);
        await sleep(400);
        const opt = document.querySelector(
          `button[data-name="horizontal-line"][data-value="${message.value}"]`
        );
        if (!opt) {
          simulateClick(opener); // 닫기
          sendResponse({ ok: false, error: message.value + " 스타일 없음" });
          return;
        }
        simulateClick(opt);
        await sleep(200);
        sendResponse({ ok: true });
      })();
      return true;
    }

    // 컴포넌트 개수 (구분선/인용구 삽입 검증용)
    if (message.type === "COUNT_COMPONENTS") {
      if (!isEditorFrame()) return;
      const q = (s) => document.querySelectorAll(s).length;
      sendResponse({
        total: q(".se-component"),
        image: q(".se-component.se-image"),
        quote: q(".se-component.se-quotation"),
        divider: q(".se-component.se-horizontalLine"),
        text: q(".se-component.se-text"),
      });
      return;
    }
  });

  log("content script 로드됨", location.href, "에디터프레임:", isEditorFrame());
})();
