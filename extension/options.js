/* options.js — 설정 저장 + 연결 점검 */
const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  enabled: false,
  apiBase: "",
  token: "",
  intervalMin: 10,
  batchSize: 1,
  defaultMode: "publish",
};

function show(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.className = "msg " + (ok === true ? "ok" : ok === false ? "err" : "");
}

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULTS, ...(settings || {}) };
  $("apiBase").value = s.apiBase;
  $("token").value = s.token;
  $("intervalMin").value = s.intervalMin;
  $("batchSize").value = s.batchSize;
  $("defaultMode").value = s.defaultMode;
  $("enabled").checked = s.enabled;
}

/** 웹 서비스 주소에 접근할 권한을 사용자에게 요청 (최초 1회 팝업) */
async function ensurePermission(apiBase) {
  const origin = new URL(apiBase).origin + "/*";
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  return chrome.permissions.request({ origins: [origin] });
}

$("btn-save").addEventListener("click", async () => {
  const apiBase = $("apiBase").value.trim().replace(/\/+$/, "");
  if (apiBase) {
    let url;
    try {
      url = new URL(apiBase);
    } catch {
      return show("save-msg", "API 주소 형식이 올바르지 않습니다.", false);
    }
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !local) {
      return show("save-msg", "보안을 위해 https 주소만 사용할 수 있습니다 (localhost 제외).", false);
    }
    // 권한 요청은 클릭 직후(사용자 동작 안)에 해야 한다
    const granted = await ensurePermission(apiBase).catch(() => false);
    if (!granted) return show("save-msg", "웹 서비스 주소 접근 권한이 거부되었습니다.", false);
  }

  const settings = {
    apiBase,
    token: $("token").value.trim(),
    intervalMin: Math.max(1, parseInt($("intervalMin").value, 10) || DEFAULTS.intervalMin),
    batchSize: Math.min(20, Math.max(1, parseInt($("batchSize").value, 10) || 1)),
    defaultMode: $("defaultMode").value === "temp" ? "temp" : "publish",
    enabled: $("enabled").checked && !!apiBase,
  };
  await chrome.storage.local.set({ settings });
  await load();
  show(
    "save-msg",
    settings.enabled
      ? `저장됨 — ${settings.intervalMin}분마다 자동 동기화합니다. (곧 첫 실행)`
      : "저장됨 — 자동 동기화는 꺼져 있습니다.",
    true
  );
});

async function runTest(type, btnId) {
  $(btnId).disabled = true;
  show("test-msg", "확인 중...");
  const r = await chrome.runtime.sendMessage({ type });
  show("test-msg", r ? r.message : "응답 없음", r ? r.ok : false);
  $(btnId).disabled = false;
}

$("btn-test-api").addEventListener("click", () => runTest("TEST_API", "btn-test-api"));
$("btn-test-naver").addEventListener("click", () => runTest("TEST_NAVER", "btn-test-naver"));

load();
