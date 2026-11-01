/*
 * keywords.js - 키워드 확장 도구 (MVP v1)
 *
 * 원리: 네이버 자동완성 엔드포인트(ac.search.naver.com)에서 키워드 하단
 *       자동완성 10개를 받아온다. 응답 구조:
 *         { query:[...], items: [ [ ["실업급여조건","0"], ... ] ] }
 *       → items[0] 의 각 [키워드, "0"] 에서 키워드만 추출.
 *
 * 저장(DB): chrome.storage.local 의 kwDB (키워드→레코드 맵). MVP용, 추후 Supabase 승격 가능.
 *   레코드: { keyword, seed, level, parent, expanded, createdAt }
 *     level 0=시드, 1=시드의 자동완성, 2=1단계 키워드의 자동완성 ...
 */

const $ = (id) => document.getElementById(id);
const MAX_LEVEL = 2; // 무한 확장 방지
const DELAY_MS = 300; // 네이버 부담 방지용 요청 간 딜레이

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => ($("log").textContent = msg);

// --- 자동완성 조회 ---
async function fetchAutocomplete(keyword) {
  const url =
    "https://ac.search.naver.com/nx/ac?q=" +
    encodeURIComponent(keyword) +
    "&frm=nv&ans=2&r_format=json&r_enc=UTF-8&r_unicode=0&st=100&q_enc=UTF-8&run=2&rev=4";
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  const items = (data.items && data.items[0]) || [];
  // 각 항목의 첫 요소가 키워드
  return items.map((it) => (Array.isArray(it) ? it[0] : it)).filter(Boolean);
}

// --- DB ---
async function loadDB() {
  const s = await chrome.storage.local.get("kwDB");
  return s.kwDB || {};
}
async function saveDB(db) {
  await chrome.storage.local.set({ kwDB: db });
}

/** 키워드 목록을 DB에 추가 (중복 제외). 추가된 개수 반환 */
function addKeywords(db, list, meta) {
  let added = 0;
  for (const raw of list) {
    const k = (raw || "").trim();
    if (!k) continue;
    if (!db[k]) {
      db[k] = {
        keyword: k,
        seed: meta.seed,
        level: meta.level,
        parent: meta.parent ?? null,
        expanded: false,
        createdAt: Date.now(),
      };
      added++;
    }
  }
  return added;
}

// --- 액션: 시드 수집 ---
async function collectSeed() {
  const seed = $("seed").value.trim();
  if (!seed) return;
  $("collect").disabled = true;
  log("⏳ '" + seed + "' 자동완성 수집 중...");
  try {
    const db = await loadDB();
    // 시드 자체(레벨0) 저장
    addKeywords(db, [seed], { seed, level: 0, parent: null });
    db[seed].expanded = true; // 시드는 수집을 방금 했으므로 확장됨 처리

    const list = await fetchAutocomplete(seed);
    const added = addKeywords(db, list, { seed, level: 1, parent: seed });
    await saveDB(db);
    log("✅ 수집 완료: 자동완성 " + list.length + "개 중 신규 " + added + "개 저장");
    render();
  } catch (e) {
    log("❌ 오류: " + e.message);
  } finally {
    $("collect").disabled = false;
  }
}

// --- 액션: 특정 키워드 확장 ---
async function expandKeyword(keyword) {
  const db = await loadDB();
  const rec = db[keyword];
  if (!rec) return;
  if (rec.level >= MAX_LEVEL) {
    log("⚠️ '" + keyword + "' 는 최대 단계(" + MAX_LEVEL + ")라 확장하지 않음");
    return;
  }
  log("⏳ '" + keyword + "' 확장 중...");
  try {
    const list = await fetchAutocomplete(keyword);
    const added = addKeywords(db, list, {
      seed: rec.seed,
      level: rec.level + 1,
      parent: keyword,
    });
    rec.expanded = true;
    await saveDB(db);
    log("✅ '" + keyword + "' 확장: 신규 " + added + "개");
    render();
  } catch (e) {
    log("❌ 확장 오류: " + e.message);
  }
}

// --- 액션: 미확장 전부 확장(1 웨이브) ---
async function expandAllUnexpanded() {
  const db = await loadDB();
  // 시작 시점의 미확장 + 확장 가능(level<MAX) 스냅샷
  const targets = Object.values(db).filter((r) => !r.expanded && r.level < MAX_LEVEL);
  if (!targets.length) {
    log("확장할 키워드가 없습니다.");
    return;
  }
  $("expandAll").disabled = true;
  let done = 0;
  for (const rec of targets) {
    log(`⏳ 확장 ${done + 1}/${targets.length}: ${rec.keyword}`);
    try {
      const fresh = await loadDB();
      const list = await fetchAutocomplete(rec.keyword);
      addKeywords(fresh, list, { seed: rec.seed, level: rec.level + 1, parent: rec.keyword });
      if (fresh[rec.keyword]) fresh[rec.keyword].expanded = true;
      await saveDB(fresh);
    } catch (e) {
      log("❌ " + rec.keyword + " 오류: " + e.message);
    }
    done++;
    await sleep(DELAY_MS);
  }
  $("expandAll").disabled = false;
  log("✅ 일괄 확장 완료: " + done + "개 처리");
  render();
}

// --- 렌더링 ---
async function render() {
  const db = await loadDB();
  const all = Object.values(db);
  const seeds = [...new Set(all.map((r) => r.seed))];

  $("stats").textContent =
    `총 키워드 ${all.length}개 · 시드 ${seeds.length}개 · ` +
    `미확장 ${all.filter((r) => !r.expanded && r.level < MAX_LEVEL).length}개`;

  const listEl = $("list");
  if (!all.length) {
    listEl.innerHTML = '<div class="empty">아직 수집된 키워드가 없습니다. 시드를 입력해 수집하세요.</div>';
    return;
  }

  listEl.innerHTML = "";
  for (const seed of seeds) {
    const rows = all
      .filter((r) => r.seed === seed)
      .sort((a, b) => a.level - b.level || a.createdAt - b.createdAt);
    const childCount = (kw) => all.filter((r) => r.parent === kw).length;

    const group = document.createElement("div");
    group.className = "card seed-group";
    const trs = rows
      .map((r) => {
        const canExpand = !r.expanded && r.level < MAX_LEVEL;
        return `<tr>
          <td><span class="lvl lvl${r.level}">L${r.level}</span></td>
          <td>${escapeHtml(r.keyword)}</td>
          <td style="color:#aaa">${childCount(r.keyword) || ""}</td>
          <td>${
            canExpand
              ? `<button class="mini blue" data-expand="${escapeAttr(r.keyword)}">확장</button>`
              : r.expanded
                ? '<span style="color:#adb5bd;font-size:11px">확장됨</span>'
                : '<span style="color:#adb5bd;font-size:11px">-</span>'
          }</td>
        </tr>`;
      })
      .join("");
    group.innerHTML = `
      <div class="seed-title">🌱 ${escapeHtml(seed)} <span style="color:#aaa;font-weight:400">(${rows.length})</span></div>
      <table>
        <thead><tr><th>단계</th><th>키워드</th><th>자식</th><th></th></tr></thead>
        <tbody>${trs}</tbody>
      </table>`;
    listEl.appendChild(group);
  }

  // 확장 버튼 바인딩
  listEl.querySelectorAll("button[data-expand]").forEach((btn) => {
    btn.addEventListener("click", () => expandKeyword(btn.getAttribute("data-expand")));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}
function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

// --- 기타 액션 ---
async function copyJson() {
  const db = await loadDB();
  const arr = Object.values(db);
  await navigator.clipboard.writeText(JSON.stringify(arr, null, 2));
  log("📋 JSON " + arr.length + "개 항목 복사됨");
}
async function clearAll() {
  if (!confirm("저장된 키워드를 모두 삭제할까요?")) return;
  await chrome.storage.local.set({ kwDB: {} });
  log("🗑 전체 삭제 완료");
  render();
}

// ===========================================================================
// AI 글 생성 (Gemini)
// ===========================================================================
const DEFAULT_MODEL = "gemini-3.6-flash";

async function loadSettings() {
  const s = await chrome.storage.local.get([
    "geminiKey",
    "geminiModel",
    "writeUrl",
    "promptTemplate",
  ]);
  return {
    key: s.geminiKey || "",
    model: s.geminiModel || DEFAULT_MODEL,
    writeUrl: s.writeUrl || "",
    promptTemplate: s.promptTemplate || "", // 저장 override (없으면 빈 문자열)
  };
}
async function saveSettings() {
  await chrome.storage.local.set({
    geminiKey: $("geminiKey").value.trim(),
    geminiModel: $("geminiModel").value.trim() || DEFAULT_MODEL,
    writeUrl: $("writeUrl").value.trim(),
  });
  $("genLog").textContent = "✅ 설정 저장됨";
}

/**
 * 프롬프트는 확장 폴더의 prompt.md 파일에서 불러온다.
 * (코드에 하드코딩하지 않음 → prompt.md 만 편집하면 프롬프트가 바뀜)
 * 자리표시자 {keyword}, {imageCount} 는 생성 시 자동 치환된다.
 * 파일 로드 실패 시를 대비한 최소 폴백만 코드에 남긴다.
 */
const FALLBACK_PROMPT = `당신은 네이버 블로그 글을 쓰는 전문 작가입니다.
주제 키워드: "{keyword}"
아래 JSON 형식으로만 응답하세요(순수 JSON):
{ "title": "제목", "blocks": [ { "type": "text", "content": "문단" } ] }
- image 블록은 정확히 {imageCount}개. JSON 외 텍스트 금지.`;

// prompt.md 원본 내용 / 현재 사용 중인 템플릿(저장 override 반영)
let filePrompt = FALLBACK_PROMPT;
let promptTemplate = FALLBACK_PROMPT;

/** prompt.md 파일을 읽어온다 (확장 리소스, 같은 오리진이라 fetch 가능) */
async function loadFilePrompt() {
  try {
    const res = await fetch(chrome.runtime.getURL("prompt.md"));
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text) return text;
    }
  } catch (e) {
    console.warn("prompt.md 로드 실패:", e.message);
  }
  return FALLBACK_PROMPT;
}

/** 템플릿에 키워드/이미지수를 대입해 최종 프롬프트 생성 */
function buildPrompt(keyword, imageCount) {
  return promptTemplate
    .replace(/\{keyword\}/g, keyword)
    .replace(/\{imageCount\}/g, String(imageCount));
}

/** 프롬프트 코드창 저장(=storage override) / 리셋(=prompt.md 다시 불러오기) */
async function savePromptTemplate() {
  promptTemplate = $("promptTemplate").value.trim() || filePrompt;
  await chrome.storage.local.set({ promptTemplate });
  $("promptLog").textContent = "✅ 저장됨 (" + promptTemplate.length + "자) — prompt.md 대신 이 내용 사용";
}
async function resetPromptTemplate() {
  await chrome.storage.local.remove("promptTemplate");
  filePrompt = await loadFilePrompt();
  promptTemplate = filePrompt;
  $("promptTemplate").value = filePrompt;
  $("promptLog").textContent = "📄 prompt.md 에서 다시 불러옴 (저장 override 해제)";
}

/** Gemini 호출 → blocks JSON 반환 */
async function callGemini(keyword, imageCount) {
  const { key, model } = await loadSettings();
  if (!key) throw new Error("Gemini API 키를 먼저 입력/저장하세요.");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=` +
    encodeURIComponent(key);
  const body = {
    contents: [{ parts: [{ text: buildPrompt(keyword, imageCount) }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.8 },
  };

  // 일시적 과부하(503 / high demand) 시 자동 재시도
  const MAX_TRY = 3;
  let data, lastErr;
  for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    data = await res.json();
    if (res.ok) break;

    const msg = data.error?.message || String(res.status);
    const transient = res.status === 503 || /high demand|overload|unavailable|try again/i.test(msg);
    lastErr = msg;
    if (transient && attempt < MAX_TRY) {
      $("genLog").textContent = `⏳ 서버 혼잡, 재시도 ${attempt}/${MAX_TRY - 1}...`;
      await sleep(1500 * attempt);
      continue;
    }
    throw new Error("Gemini 오류: " + msg);
  }
  if (!data) throw new Error("Gemini 오류: " + (lastErr || "unknown"));

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("응답에 텍스트가 없습니다.");

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("JSON 파싱 실패: " + text.slice(0, 120));
  }
  const v = validateDraft(parsed);
  if (!v.ok) throw new Error("형식 오류: " + v.error);
  return parsed;
}

/** blocks 구조 검증 */
function validateDraft(obj) {
  if (!obj || typeof obj.title !== "string" || !obj.title.trim())
    return { ok: false, error: "title 없음" };
  if (!Array.isArray(obj.blocks) || !obj.blocks.length)
    return { ok: false, error: "blocks 배열 없음" };
  const allowed = ["heading", "text", "quote", "divider", "image"];
  for (let i = 0; i < obj.blocks.length; i++) {
    const b = obj.blocks[i];
    if (!b || !allowed.includes(b.type)) return { ok: false, error: `blocks[${i}] type 오류` };
    if (["heading", "text", "quote"].includes(b.type) && typeof b.content !== "string")
      return { ok: false, error: `blocks[${i}] content 없음` };
  }
  return { ok: true };
}

let lastDraft = null; // 마지막 생성 글 (자동 작성에 사용)

async function generateArticle() {
  const kw = $("genKeyword").value.trim();
  if (!kw) {
    $("genLog").textContent = "❌ 키워드를 입력하세요.";
    return;
  }
  const imageCount = Number($("genImages").value);
  $("genArticle").disabled = true;
  $("genLog").textContent = "⏳ Gemini 글 생성 중...";
  try {
    const draft = await callGemini(kw, imageCount);
    lastDraft = draft;
    $("genResult").style.display = "block";
    $("genResult").textContent = JSON.stringify(draft, null, 2);
    $("autoRow").style.display = "flex";
    $("genLog").textContent = `✅ 생성 완료: 블록 ${draft.blocks.length}개`;
  } catch (e) {
    $("genLog").textContent = "❌ " + e.message;
  } finally {
    $("genArticle").disabled = false;
  }
}

/**
 * 생성된 글을 백그라운드 API 로 임시저장한다 (빌드 #31~).
 * 타이핑/창 조작 없이 documentModel 을 조립해 RabbitTempPostWrite 로 저장.
 * 글쓰기 탭이 없으면 GoBlogWrite 로 백그라운드 탭을 몰래 열고 저장 후 닫는다.
 */
async function autoWrite() {
  if (!lastDraft) {
    $("genLog").textContent = "먼저 글을 생성하세요.";
    return;
  }
  $("autoWrite").disabled = true;
  $("genLog").textContent = "⏳ 백그라운드 API 저장 중... (창/타이핑 없음, 크롬+네이버 로그인만 있으면 됨)";
  try {
    const { writeUrl } = await loadSettings();
    const res = await chrome.runtime.sendMessage({
      type: "RUN_API_WRITE",
      draft: lastDraft,
      writeUrl,
    });
    if (!res) {
      $("genLog").textContent = "❌ 응답 없음";
      return;
    }
    const lines = (res.steps || []).map(
      (s) => `${s.ok ? "✅" : "❌"} ${s.step}${s.detail ? " · " + s.detail : ""}`
    );
    $("genLog").textContent =
      (res.success ? "🎉 백그라운드 임시저장 완료" : "⚠️ 실패") + "\n" + lines.join("\n");
  } catch (e) {
    $("genLog").textContent = "❌ " + e.message;
  } finally {
    $("autoWrite").disabled = false;
  }
}

async function initSettingsUI() {
  const { key, model, writeUrl, promptTemplate: savedOverride } = await loadSettings();
  $("geminiKey").value = key;
  $("geminiModel").value = model;
  $("writeUrl").value = writeUrl;

  // prompt.md 를 기본으로 불러오고, 저장 override 가 있으면 그걸 우선 사용
  filePrompt = await loadFilePrompt();
  promptTemplate = savedOverride || filePrompt;
  if ($("promptTemplate")) $("promptTemplate").value = promptTemplate;
  if ($("promptLog"))
    $("promptLog").textContent = savedOverride
      ? "저장된 프롬프트 사용 중 ([기본값으로] 누르면 prompt.md 로 복귀)"
      : "📄 prompt.md 에서 불러옴";
}

// --- 이벤트 ---
$("saveSettings").addEventListener("click", saveSettings);
$("savePrompt").addEventListener("click", savePromptTemplate);
$("resetPrompt").addEventListener("click", resetPromptTemplate);
$("genArticle").addEventListener("click", generateArticle);
$("autoWrite").addEventListener("click", autoWrite);
$("collect").addEventListener("click", collectSeed);
$("seed").addEventListener("keydown", (e) => e.key === "Enter" && collectSeed());
$("expandAll").addEventListener("click", expandAllUnexpanded);
$("copyJson").addEventListener("click", copyJson);
$("clearAll").addEventListener("click", clearAll);

initSettingsUI();
render();
