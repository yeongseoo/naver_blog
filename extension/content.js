/*
 * content.js — 네이버 블로그 글쓰기 페이지에서 동작하는 스크립트
 *
 * 하는 일은 딱 하나: background 가 보낸 글(title + blocks)을
 * 스마트에디터 문서 형식(documentModel)으로 바꿔 네이버 발행 API에 POST 한다.
 *   - 발행:     /RabbitWrite.naver
 *   - 임시저장: /RabbitTempPostWrite.naver
 * 요청은 blog.naver.com 페이지 안에서 보내므로 사용자의 로그인 쿠키가 자동으로 붙는다.
 *
 * 네이버 에디터는 iframe 안에서 동작하므로 manifest 에서 all_frames:true 로 주입하고,
 * 실제 에디터가 있는 프레임만 응답한다.
 */

(() => {
  "use strict";

  const LOG_PREFIX = "[네이버브릿지]";
  const log = (...args) => console.log(LOG_PREFIX, ...args);

  // 에디터 프레임 판별용 selector (네이버 DOM 이 바뀌면 여기에 후보 추가)
  const EDITOR_ROOT_SELECTORS = [".se-container", ".se-canvas", ".se-main-container"];

  function isEditorFrame() {
    return EDITOR_ROOT_SELECTORS.some((sel) => {
      try {
        return !!document.querySelector(sel);
      } catch {
        return false;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Block → documentModel 변환 (스마트에디터 문서 스키마 version 2.10.2)
  //   text    → "text"
  //   heading → "sectionTitle" (소제목)
  //   quote   → "quotation"   (인용구)
  //   divider → "horizontalLine" (구분선)
  //   image   → 아직 미지원 (건너뜀)
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

  function seParagraph(value) {
    return {
      id: seId(),
      nodes: [{ id: seId(), value: String(value == null ? "" : value), "@ctype": "textNode" }],
      "@ctype": "paragraph",
    };
  }

  /** 여러 줄 텍스트는 줄마다 문단 하나로 */
  function seParagraphs(content) {
    const lines = String(content == null ? "" : content).split(/\r?\n/);
    return lines.map(seParagraph);
  }

  const DIVIDER_LAYOUTS = ["default", "line1", "line5", "line6", "line7"];

  function buildDocumentModel(draft) {
    const components = [
      {
        id: seId(),
        layout: "default",
        title: [seParagraph(draft.title || "")],
        subTitle: null,
        align: "left",
        "@ctype": "documentTitle",
      },
    ];
    let skippedImages = 0;

    for (const b of draft.blocks || []) {
      if (!b || !b.type) continue;
      if (b.type === "text") {
        components.push({
          id: seId(),
          layout: "default",
          value: seParagraphs(b.content),
          "@ctype": "text",
        });
      } else if (b.type === "heading") {
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
          value: seParagraphs(b.content),
          source: null,
          "@ctype": "quotation",
        });
      } else if (b.type === "divider") {
        const layout = DIVIDER_LAYOUTS.includes(b.style) ? b.style : "default";
        components.push({ id: seId(), layout, "@ctype": "horizontalLine" });
      } else if (b.type === "image") {
        skippedImages++; // 이미지 업로드는 아직 미지원
      }
    }

    return {
      skippedImages,
      model: {
        documentId: "",
        document: {
          version: "2.10.2",
          theme: "default",
          language: "ko-KR",
          id: seDocId(),
          components,
          di: { dif: false, dio: [{ dis: "N", dia: { t: 0, p: 0, st: 12, sk: 1 } }] },
        },
      },
    };
  }

  function b64Random16() {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    let s = "";
    for (const b of a) s += String.fromCharCode(b);
    return btoa(s);
  }

  /** 발행 옵션 (공개/댓글/검색 허용 등) */
  function buildPopulationParams(draft) {
    return {
      configuration: {
        openType: 2, // 2 = 전체공개
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
        categoryId: Number.isFinite(Number(draft.categoryId)) ? Number(draft.categoryId) : 0,
        logNo: null,
        directorySeq: 0,
        directoryDetail: null,
        mrBlogTalkCode: null,
        postWriteTimeType: "now",
        tags: null, // 태그 형식은 아직 미검증 → 사용 안 함
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
  // background ↔ content 메시지
  // ---------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;

    // 에디터 준비 확인 (에디터 프레임만 응답)
    if (message.type === "PING") {
      if (isEditorFrame()) sendResponse({ ok: true, frameUrl: location.href });
      return;
    }

    if (message.type === "API_PUBLISH") {
      if (!isEditorFrame()) return;
      (async () => {
        try {
          const draft = message.draft || {};
          const blogId = new URLSearchParams(location.search).get("blogId");
          if (!blogId) {
            sendResponse({ ok: false, error: "글쓰기 페이지 URL 에서 blogId 를 찾지 못했습니다." });
            return;
          }
          const { model, skippedImages } = buildDocumentModel(draft);

          const params = new URLSearchParams();
          params.set("blogId", blogId);
          params.set("documentModel", JSON.stringify(model));
          params.set("mediaResources", JSON.stringify({ image: [], video: [], file: [] }));
          params.set("populationParams", JSON.stringify(buildPopulationParams(draft)));
          params.set("productApiVersion", "v1");

          const endpoint =
            message.mode === "temp" ? "/RabbitTempPostWrite.naver" : "/RabbitWrite.naver";
          const res = await fetch("https://blog.naver.com" + endpoint, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
            body: params.toString(),
          });
          const text = await res.text();
          log("API_PUBLISH", endpoint, res.status, text.slice(0, 200));
          sendResponse({
            ok: res.ok,
            status: res.status,
            body: text.slice(0, 3000),
            blogId,
            skippedImages,
            componentCount: model.document.components.length,
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true; // 비동기 응답
    }
  });

  if (isEditorFrame()) log("에디터 프레임 감지:", location.href);
})();
