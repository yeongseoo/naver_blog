/* popup.js — 상태 확인 + 수동 동기화 */
const $ = (id) => document.getElementById(id);

function fmt(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function summaryText(s) {
  if (!s) return "-";
  if (s.error) return "❌ " + s.error;
  return `가져옴 ${s.fetched} · 성공 ${s.published} · 실패 ${s.failed}` + (s.skipped ? ` · 건너뜀 ${s.skipped}` : "");
}

const ICON = { ok: "✅", error: "❌", warn: "⚠️", info: "ℹ️" };

function render(st) {
  const s = st.settings;
  $("st-enabled").textContent = s.enabled ? `켜짐 (${s.intervalMin}분마다)` : "꺼짐";
  $("st-api").textContent = s.apiBase || "미설정";
  $("st-api").title = s.apiBase || "";
  $("st-last").textContent = st.syncing ? "실행 중..." : fmt(st.lastSync && st.lastSync.at);
  $("st-result").textContent = summaryText(st.lastSync);
  $("st-next").textContent = st.nextRunAt ? fmt(st.nextRunAt) : "-";

  const ul = $("log");
  ul.innerHTML = "";
  if (!st.syncLog.length) {
    ul.innerHTML = '<li class="empty">기록 없음</li>';
    return;
  }
  for (const e of st.syncLog.slice(0, 15)) {
    const li = document.createElement("li");
    li.className = e.level;
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = fmt(e.at);
    li.append(time, document.createTextNode(` ${ICON[e.level] || ""} ${e.message}`));
    if (e.postUrl) {
      const a = document.createElement("a");
      a.href = e.postUrl;
      a.target = "_blank";
      a.textContent = " [글 보기]";
      li.append(a);
    }
    ul.append(li);
  }
}

async function refresh() {
  const st = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (st) render(st);
}

$("btn-sync").addEventListener("click", async () => {
  $("btn-sync").disabled = true;
  $("msg").textContent = "동기화 중... (글 발행 시 백그라운드 탭이 잠시 열립니다)";
  const r = await chrome.runtime.sendMessage({ type: "SYNC_NOW" });
  $("msg").textContent = summaryText(r);
  $("btn-sync").disabled = false;
  refresh();
});

$("btn-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh();
