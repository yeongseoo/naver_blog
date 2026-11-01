/* app.js — 렌더러 UI 로직 (preload 의 window.api 사용) */
"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  jobs: [],
  settings: {},
  bridge: { connected: false },
  blocks: [], // 작성중인 블록 [{type, content, style}]
  queueFilter: "all",
};

const BLOCK_META = {
  heading: { tag: "소제목", placeholder: "소제목 텍스트" },
  text: { tag: "본문", placeholder: "본문 내용을 입력하세요" },
  quote: { tag: "인용구", placeholder: "인용할 문장" },
  divider: { tag: "구분선", placeholder: "" },
};

// ---------------------------------------------------------------------------
// 초기화
// ---------------------------------------------------------------------------
async function boot() {
  const init = await window.api.init();
  state.settings = init.settings;
  state.jobs = init.jobs;
  state.bridge = init.bridge || { connected: false };

  bindNav();
  bindCompose();
  bindQueue();
  bindSettings();

  applySettingsToUI();
  renderAll();

  // 실시간 이벤트
  window.api.onJobsChanged((jobs) => {
    state.jobs = jobs;
    renderAll();
  });
  window.api.onBridgeStatus((s) => {
    state.bridge.connected = s.connected;
    renderConn(s);
  });
  window.api.onBridgeError((m) => console.warn("bridge error:", m));

  // 연결 상태 주기 확인 (이벤트 누락 대비)
  setInterval(async () => {
    const s = await window.api.bridgeStatus();
    state.bridge.connected = s.connected;
    renderConn(s);
  }, 3000);
  renderConn({ connected: state.bridge.connected });
}

// ---------------------------------------------------------------------------
// 내비게이션
// ---------------------------------------------------------------------------
function bindNav() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.goto));
  });
}
function switchView(view) {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view)
  );
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("active", v.id === "view-" + view)
  );
}

// ---------------------------------------------------------------------------
// 연결 상태
// ---------------------------------------------------------------------------
function renderConn(s) {
  const connected = s.connected;
  $("connDot").className = "conn-dot " + (connected ? "on" : "off");
  $("connTitle").textContent = connected ? "확장 연결됨" : "확장 연결 안됨";
  $("connSub").textContent = connected
    ? "포트 " + (s.port || state.settings.wsPort)
    : "Chrome에서 확장을 켜주세요";
  $("statConn").textContent = connected ? "연결됨" : "끊김";
  $("statConn").className = "stat-value " + (connected ? "ok" : "bad");
}

// ---------------------------------------------------------------------------
// 대시보드 + 큐 렌더
// ---------------------------------------------------------------------------
function renderAll() {
  renderStats();
  renderUpcoming();
  renderJobs();
  $("queueBadge").textContent = state.jobs.filter((j) => j.status === "queued").length;
}

function renderStats() {
  const c = (st) => state.jobs.filter((j) => j.status === st).length;
  $("statQueued").textContent = c("queued");
  $("statDone").textContent = c("done");
  $("statFailed").textContent = c("failed");
}

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

function renderUpcoming() {
  const list = $("upcomingList");
  const items = state.jobs
    .filter((j) => j.status === "queued")
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .slice(0, 5);
  if (!items.length) {
    list.innerHTML = '<div class="empty">예약된 글이 없습니다.</div>';
    return;
  }
  list.innerHTML = items
    .map(
      (j) => `
    <div class="job-card">
      <div class="job-top">
        <span class="job-title">${esc(j.title) || "(제목 없음)"}</span>
        <span class="status queued">예약</span>
      </div>
      <div class="job-meta">
        <span>◷ ${fmtTime(j.scheduledAt)}</span>
        <span>${j.blocks.length}개 블록</span>
        <span>${j.mode === "publish" ? "실제 발행" : "임시저장"}</span>
      </div>
    </div>`
    )
    .join("");
}

function renderJobs() {
  const list = $("jobList");
  let items = [...state.jobs].sort((a, b) => (b.scheduledAt || 0) - (a.scheduledAt || 0));
  if (state.queueFilter !== "all") {
    items = items.filter((j) => j.status === state.queueFilter);
  }
  if (!items.length) {
    list.innerHTML = '<div class="empty">해당하는 작업이 없습니다.</div>';
    return;
  }
  const statusLabel = { queued: "예약 대기", publishing: "발행중", done: "완료", failed: "실패" };
  list.innerHTML = items
    .map(
      (j) => `
    <div class="job-card">
      <div class="job-top">
        <span class="job-title">${esc(j.title) || "(제목 없음)"}</span>
        <span class="status ${j.status}">${statusLabel[j.status] || j.status}</span>
      </div>
      <div class="job-meta">
        <span>◷ ${fmtTime(j.scheduledAt)}</span>
        <span>${j.blocks.length}개 블록</span>
        <span>${j.mode === "publish" ? "실제 발행" : "임시저장"}</span>
      </div>
      ${j.log ? `<div class="job-log">${esc(j.log)}</div>` : ""}
      <div class="job-actions">
        ${
          j.status === "queued" || j.status === "failed"
            ? `<button class="btn ghost sm" data-run="${j.id}">지금 실행</button>`
            : ""
        }
        <button class="btn danger sm" data-del="${j.id}">삭제</button>
      </div>
    </div>`
    )
    .join("");

  list.querySelectorAll("[data-run]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      b.textContent = "실행중…";
      await window.api.runJobNow(b.dataset.run);
    })
  );
  list.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", () => window.api.removeJob(b.dataset.del))
  );
}

function bindQueue() {
  $("queueFilter")
    .querySelectorAll(".seg-btn")
    .forEach((b) =>
      b.addEventListener("click", () => {
        state.queueFilter = b.dataset.filter;
        $("queueFilter")
          .querySelectorAll(".seg-btn")
          .forEach((x) => x.classList.toggle("active", x === b));
        renderJobs();
      })
    );
}

// ---------------------------------------------------------------------------
// 글 작성 (블록 에디터)
// ---------------------------------------------------------------------------
function bindCompose() {
  document.querySelectorAll("[data-add]").forEach((b) =>
    b.addEventListener("click", () => addBlock(b.dataset.add))
  );
  $("clearSchedule").addEventListener("click", () => {
    $("scheduleAt").value = toLocalInput(Date.now() + 60000);
  });
  $("btnSchedule").addEventListener("click", onSchedule);
  $("btnPublishNow").addEventListener("click", onPublishNow);

  $("scheduleAt").value = toLocalInput(Date.now() + 5 * 60000);
  $("modeSelect").value = state.settings.defaultMode || "publish";
  renderBlocks();
}

function addBlock(type) {
  state.blocks.push({ type, content: "", style: type === "divider" ? "line1" : undefined });
  renderBlocks();
}

function renderBlocks() {
  const list = $("blockList");
  if (!state.blocks.length) {
    list.innerHTML = '<div class="empty">위 버튼으로 블록을 추가하세요.</div>';
    return;
  }
  list.innerHTML = state.blocks
    .map((b, i) => {
      const meta = BLOCK_META[b.type];
      const body =
        b.type === "divider"
          ? `<div class="block-divider-note">── 구분선 ──</div>`
          : `<textarea data-i="${i}" placeholder="${meta.placeholder}">${esc(
              b.content
            )}</textarea>`;
      return `
      <div class="block-item">
        <span class="block-tag ${b.type === "divider" ? "divider" : ""}">${meta.tag}</span>
        <div class="block-body">${body}</div>
        <div class="block-ctrl">
          <button class="icon-btn" data-up="${i}" title="위로">▲</button>
          <button class="icon-btn" data-down="${i}" title="아래로">▼</button>
          <button class="icon-btn del" data-rm="${i}" title="삭제">✕</button>
        </div>
      </div>`;
    })
    .join("");

  list.querySelectorAll("textarea[data-i]").forEach((t) =>
    t.addEventListener("input", (e) => {
      state.blocks[Number(e.target.dataset.i)].content = e.target.value;
    })
  );
  list.querySelectorAll("[data-up]").forEach((b) =>
    b.addEventListener("click", () => moveBlock(Number(b.dataset.up), -1))
  );
  list.querySelectorAll("[data-down]").forEach((b) =>
    b.addEventListener("click", () => moveBlock(Number(b.dataset.down), 1))
  );
  list.querySelectorAll("[data-rm]").forEach((b) =>
    b.addEventListener("click", () => {
      state.blocks.splice(Number(b.dataset.rm), 1);
      renderBlocks();
    })
  );
}

function moveBlock(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.blocks.length) return;
  [state.blocks[i], state.blocks[j]] = [state.blocks[j], state.blocks[i]];
  renderBlocks();
}

function collectDraft() {
  const title = $("titleInput").value.trim();
  const blocks = state.blocks
    .filter((b) => b.type === "divider" || (b.content || "").trim())
    .map((b) =>
      b.type === "divider"
        ? { type: "divider", style: b.style || "line1" }
        : { type: b.type, content: b.content.trim() }
    );
  return { title, blocks, mode: $("modeSelect").value };
}

function validateDraft(d, msgEl) {
  if (!d.title) {
    showMsg(msgEl, "제목을 입력하세요.", "err");
    return false;
  }
  if (!d.blocks.length) {
    showMsg(msgEl, "내용 블록을 하나 이상 추가하세요.", "err");
    return false;
  }
  return true;
}

async function onSchedule() {
  const d = collectDraft();
  if (!validateDraft(d, "composeMsg")) return;
  const at = $("scheduleAt").value ? new Date($("scheduleAt").value).getTime() : Date.now();
  await window.api.saveJob({ ...d, scheduledAt: at });
  showMsg("composeMsg", "예약 등록됨 · " + fmtTime(at), "ok");
  resetCompose();
  switchView("queue");
}

async function onPublishNow() {
  const d = collectDraft();
  if (!validateDraft(d, "composeMsg")) return;
  if (!state.bridge.connected) {
    showMsg("composeMsg", "확장이 연결되어 있지 않습니다. Chrome 확장을 켜주세요.", "err");
    return;
  }
  $("btnPublishNow").disabled = true;
  $("btnPublishNow").textContent = "발행중…";
  const res = await window.api.publishNow(d);
  $("btnPublishNow").disabled = false;
  $("btnPublishNow").textContent = "지금 발행";
  if (res && res.status === "done") {
    showMsg("composeMsg", "발행 완료 🎉", "ok");
    resetCompose();
  } else {
    showMsg("composeMsg", "발행 실패 — 예약 큐에서 로그를 확인하세요.", "err");
    switchView("queue");
  }
}

function resetCompose() {
  $("titleInput").value = "";
  state.blocks = [];
  renderBlocks();
  $("scheduleAt").value = toLocalInput(Date.now() + 5 * 60000);
}

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------
function bindSettings() {
  $("btnSaveSettings").addEventListener("click", async () => {
    const patch = {
      wsPort: Number($("setPort").value) || 8765,
      writeUrl: $("setWriteUrl").value.trim(),
      defaultMode: $("setMode").value,
    };
    state.settings = await window.api.setSettings(patch);
    showMsg("settingsMsg", "저장됨 ✓", "ok");
    $("modeSelect").value = state.settings.defaultMode;
  });
}
function applySettingsToUI() {
  $("setPort").value = state.settings.wsPort;
  $("setWriteUrl").value = state.settings.writeUrl || "";
  $("setMode").value = state.settings.defaultMode || "publish";
}

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------
function showMsg(elOrId, text, kind) {
  const el = typeof elOrId === "string" ? $(elOrId) : elOrId;
  el.textContent = text;
  el.className = "msg " + (kind || "");
  if (el.classList.contains("inline")) el.className = "msg inline " + (kind || "");
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function toLocalInput(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

boot();
