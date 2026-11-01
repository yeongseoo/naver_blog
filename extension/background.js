/*
 * background.js — 네이버 블로그 브릿지 (Service Worker)
 *
 * 글 생성 웹 서비스(DB)와 네이버 블로그 사이를 이어주는 다리 역할.
 *
 *   [글 생성 웹 서비스]  ──(1) GET  {apiBase}/pending ──▶  [이 확장]
 *                       ◀─(3) POST {apiBase}/result ──    │
 *                                                         │ (2) 네이버 발행 API 호출
 *                                                         ▼    (사용자의 로그인 세션 사용)
 *                                                    [네이버 블로그]
 *
 * 정해진 주기(chrome.alarms)마다:
 *   1) 웹 서비스에서 발행 대기 글을 가져오고
 *   2) 네이버 글쓰기 페이지를 백그라운드 탭으로 열어 RabbitWrite API 로 발행한 뒤
 *   3) 결과(성공/실패, 글 주소)를 웹 서비스에 다시 보고한다.
 *
 * API 규격은 README.md 참고.
 */

const LOG = "[네이버브릿지 BG]";
const ALARM = "bridge-sync";
const WRITE_URL = "https://blog.naver.com/GoBlogWrite.naver"; // 로그인 사용자의 글쓰기로 리다이렉트
const EDITOR_READY_TIMEOUT = 30000;
const DELAY_BETWEEN_POSTS_MS = 5000;
const MAX_LOG = 50;
const MAX_HANDLED = 300;

const DEFAULT_SETTINGS = {
  enabled: false, // 자동 동기화 켜기/끄기
  apiBase: "", // 예: https://my-service.com/api/naver-bridge
  token: "", // Authorization: Bearer <token>
  intervalMin: 10, // 확인 주기(분)
  batchSize: 1, // 한 번에 발행할 최대 글 수
  defaultMode: "publish", // "publish"(발행) | "temp"(임시저장) — 글에 mode 가 없을 때
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 저장소
// ---------------------------------------------------------------------------
async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function addLog(level, message, extra) {
  const { syncLog = [] } = await chrome.storage.local.get("syncLog");
  syncLog.unshift({ at: Date.now(), level, message, ...(extra || {}) });
  await chrome.storage.local.set({ syncLog: syncLog.slice(0, MAX_LOG) });
  console.log(LOG, level, message, extra || "");
}

/** 처리한 글 기록 — 같은 글을 두 번 발행하지 않기 위한 장치 */
async function getHandled() {
  const { handled = {} } = await chrome.storage.local.get("handled");
  return handled;
}
async function saveHandled(handled) {
  const entries = Object.entries(handled).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  await chrome.storage.local.set({ handled: Object.fromEntries(entries.slice(0, MAX_HANDLED)) });
}

// ---------------------------------------------------------------------------
// 웹 서비스 API
// ---------------------------------------------------------------------------
function apiUrl(settings, path) {
  return settings.apiBase.replace(/\/+$/, "") + path;
}

async function apiFetch(settings, path, options = {}) {
  const headers = { Accept: "application/json", ...(options.headers || {}) };
  if (settings.token) headers.Authorization = "Bearer " + settings.token;
  const res = await fetch(apiUrl(settings, path), { ...options, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`웹 서비스 응답 HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error("웹 서비스 응답이 JSON 이 아닙니다: " + text.slice(0, 200));
  }
}

async function fetchPending(settings, limit) {
  const data = await apiFetch(settings, `/pending?limit=${encodeURIComponent(limit)}`);
  const posts = Array.isArray(data) ? data : data.posts;
  if (!Array.isArray(posts)) throw new Error("응답에 posts 배열이 없습니다.");
  return posts;
}

async function reportResult(settings, report) {
  await apiFetch(settings, "/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });
}

// ---------------------------------------------------------------------------
// 네이버 발행
// ---------------------------------------------------------------------------
function sendTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (r) => {
      if (chrome.runtime.lastError) resolve({ __error: chrome.runtime.lastError.message });
      else resolve(r);
    });
  });
}

async function waitEditorReady(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const r = await sendTab(tabId, { type: "PING" });
    if (r && r.ok) return true;
  }
  return false;
}

/** 글쓰기 페이지를 보이지 않는 탭으로 연다. 로그인이 안 돼 있으면 에디터가 안 떠서 실패한다. */
async function openWriteTab() {
  const tab = await chrome.tabs.create({ url: WRITE_URL, active: false });
  const ready = await waitEditorReady(tab.id, EDITOR_READY_TIMEOUT);
  if (!ready) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error(
      "네이버 글쓰기 페이지가 열리지 않았습니다. Chrome 에서 네이버에 로그인돼 있는지 확인하세요."
    );
  }
  await sleep(500);
  return tab.id;
}

/** 네이버 응답 해석 → { success, logNo, postUrl, error } */
function parseNaverResponse(res) {
  if (!res || res.__error) return { success: false, error: (res && res.__error) || "응답 없음" };
  if (!res.ok && !res.status) return { success: false, error: res.error || "요청 실패" };

  const body = res.body || "";
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {}

  const logNoMatch = body.match(/logNo["'=:\s]*"?(\d{6,})/i);
  const logNo = logNoMatch ? logNoMatch[1] : null;
  const postUrl = logNo && res.blogId ? `https://blog.naver.com/${res.blogId}/${logNo}` : null;

  if (!res.ok) return { success: false, logNo, postUrl, error: `네이버 HTTP ${res.status}` };
  if (/^\s*</.test(body)) {
    return { success: false, error: "네이버가 HTML 을 반환했습니다 (로그인 만료 가능성)" };
  }
  if (json && json.isSuccess === false) {
    const msg =
      (json.result && (json.result.message || json.result.errorMessage)) ||
      json.message ||
      json.errorMessage ||
      body.slice(0, 200);
    return { success: false, error: "네이버 거부: " + msg };
  }
  return { success: true, logNo, postUrl };
}

async function publishOnTab(tabId, post, mode) {
  const draft = { title: post.title, blocks: post.blocks, categoryId: post.categoryId };
  const res = await sendTab(tabId, { type: "API_PUBLISH", mode, draft });
  const parsed = parseNaverResponse(res);
  return {
    ...parsed,
    blogId: res && res.blogId,
    skippedImages: (res && res.skippedImages) || 0,
    naverBody: res && res.body ? res.body.slice(0, 1000) : undefined,
  };
}

// ---------------------------------------------------------------------------
// 동기화 1회 실행
// ---------------------------------------------------------------------------
function validatePost(p) {
  if (!p || p.id == null || p.id === "") return "id 가 없습니다";
  if (!p.title || typeof p.title !== "string") return "title 이 없습니다";
  if (!Array.isArray(p.blocks) || p.blocks.length === 0) return "blocks 가 비어 있습니다";
  return null;
}

function isDue(p) {
  if (p.scheduledAt == null || p.scheduledAt === "") return true;
  const t = typeof p.scheduledAt === "number" ? p.scheduledAt : Date.parse(p.scheduledAt);
  return !Number.isFinite(t) || t <= Date.now();
}

/** 보고 실패했던 결과를 다시 보낸다 (발행은 다시 하지 않음) */
async function retryUnreported(settings, handled) {
  for (const [id, h] of Object.entries(handled)) {
    if (h.reported || !h.report) continue;
    try {
      await reportResult(settings, h.report);
      h.reported = true;
      await addLog("info", `결과 재보고 완료: ${id}`);
    } catch (e) {
      await addLog("warn", `결과 재보고 실패: ${id}`, { error: e.message });
    }
  }
  await saveHandled(handled);
}

let syncing = null;

function runSync(trigger) {
  if (syncing) return syncing; // 이미 실행 중이면 그 결과를 기다린다
  syncing = doSync(trigger).finally(() => {
    syncing = null;
  });
  return syncing;
}

async function doSync(trigger) {
  const settings = await getSettings();
  const summary = { trigger, at: Date.now(), fetched: 0, published: 0, failed: 0, skipped: 0 };

  if (!settings.apiBase) {
    summary.error = "웹 서비스 주소(apiBase)가 설정되지 않았습니다.";
    await chrome.storage.local.set({ lastSync: summary });
    return summary;
  }

  const handled = await getHandled();
  let tabId = null;

  try {
    await retryUnreported(settings, handled);

    const posts = await fetchPending(settings, settings.batchSize);
    summary.fetched = posts.length;

    for (const post of posts) {
      const id = String(post && post.id);
      const prev = handled[id];

      // 이미 발행 성공한 글 → 다시 발행하지 않고 결과만 다시 보고
      if (prev && prev.success) {
        summary.skipped++;
        try {
          await reportResult(settings, prev.report);
          prev.reported = true;
        } catch {}
        continue;
      }

      const invalid = validatePost(post);
      if (invalid) {
        summary.failed++;
        const report = { id, success: false, error: "잘못된 글 데이터: " + invalid };
        await addLog("error", `[${id}] ${report.error}`);
        try {
          await reportResult(settings, report);
        } catch {}
        continue;
      }

      if (!isDue(post)) {
        summary.skipped++;
        continue;
      }

      const mode = post.mode === "temp" || post.mode === "publish" ? post.mode : settings.defaultMode;
      let result;
      try {
        if (tabId == null) tabId = await openWriteTab();
        else await sleep(DELAY_BETWEEN_POSTS_MS);
        result = await publishOnTab(tabId, post, mode);
      } catch (e) {
        result = { success: false, error: e.message };
      }

      const report = {
        id,
        success: result.success,
        mode,
        postUrl: result.postUrl || null,
        logNo: result.logNo || null,
        blogId: result.blogId || null,
        skippedImages: result.skippedImages || 0,
        error: result.error || null,
        processedAt: new Date().toISOString(),
      };

      handled[id] = { success: result.success, reported: false, report, at: Date.now() };
      await saveHandled(handled);

      if (result.success) {
        summary.published++;
        await addLog("ok", `[${id}] ${mode === "temp" ? "임시저장" : "발행"} 성공: ${post.title}`, {
          postUrl: report.postUrl,
        });
      } else {
        summary.failed++;
        await addLog("error", `[${id}] 실패: ${result.error}`, { naverBody: result.naverBody });
      }

      try {
        await reportResult(settings, report);
        handled[id].reported = true;
        await saveHandled(handled);
      } catch (e) {
        await addLog("warn", `[${id}] 결과 보고 실패 (다음 주기에 재시도)`, { error: e.message });
      }

      // 로그인 문제 등으로 탭 자체가 안 열리면 남은 글도 실패하므로 중단
      if (!result.success && tabId == null) break;
    }
  } catch (e) {
    summary.error = e.message;
    await addLog("error", "동기화 실패: " + e.message);
  } finally {
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
  }

  await chrome.storage.local.set({ lastSync: summary });
  return summary;
}

// ---------------------------------------------------------------------------
// 주기 실행 (알람)
// ---------------------------------------------------------------------------
/**
 * force=false: 서비스워커가 깨어날 때마다 호출되므로, 같은 주기의 알람이 이미 있으면 그대로 둔다.
 * force=true : 설정이 바뀌었을 때 — 알람을 새로 만들고 곧바로 1회 실행한다.
 */
async function scheduleAlarm(force = false) {
  const s = await getSettings();
  const period = Math.max(1, Number(s.intervalMin) || DEFAULT_SETTINGS.intervalMin);
  const existing = await chrome.alarms.get(ALARM);
  const want = s.enabled && s.apiBase;
  if (!force && want && existing && existing.periodInMinutes === period) return;

  await chrome.alarms.clear(ALARM);
  if (want) {
    chrome.alarms.create(ALARM, { delayInMinutes: force ? 0.1 : period, periodInMinutes: period });
    console.log(LOG, `자동 동기화 켜짐: ${period}분마다`);
  } else {
    console.log(LOG, "자동 동기화 꺼짐");
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) runSync("schedule");
});

chrome.runtime.onInstalled.addListener(() => scheduleAlarm(false));
chrome.runtime.onStartup.addListener(() => scheduleAlarm(false));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) scheduleAlarm(true);
});

// ---------------------------------------------------------------------------
// popup / options → background
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "SYNC_NOW") {
    runSync("manual").then(sendResponse);
    return true;
  }

  if (msg.type === "TEST_API") {
    (async () => {
      try {
        const settings = await getSettings();
        if (!settings.apiBase) throw new Error("웹 서비스 주소를 먼저 저장하세요.");
        // limit=0 → 글을 가져가지 않고 연결/인증만 확인
        const posts = await fetchPending(settings, 0);
        sendResponse({ ok: true, message: `연결 성공 (응답 posts ${posts.length}개)` });
      } catch (e) {
        sendResponse({ ok: false, message: e.message });
      }
    })();
    return true;
  }

  if (msg.type === "TEST_NAVER") {
    // 네이버 로그인/발행 경로 점검: 테스트 글을 '임시저장'만 한다 (공개 발행 안 함)
    (async () => {
      let tabId = null;
      try {
        tabId = await openWriteTab();
        const r = await publishOnTab(
          tabId,
          {
            title: "[브릿지 테스트] 임시저장 확인용",
            blocks: [{ type: "text", content: "네이버 블로그 브릿지 연결 테스트입니다. 삭제해도 됩니다." }],
          },
          "temp"
        );
        sendResponse({
          ok: r.success,
          message: r.success
            ? `임시저장 성공 (블로그: ${r.blogId}) — 글쓰기 > 임시저장 목록에서 확인 후 삭제하세요.`
            : "실패: " + r.error,
        });
      } catch (e) {
        sendResponse({ ok: false, message: e.message });
      } finally {
        if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
      }
    })();
    return true;
  }

  if (msg.type === "GET_STATUS") {
    (async () => {
      const [settings, data, alarm] = await Promise.all([
        getSettings(),
        chrome.storage.local.get(["lastSync", "syncLog"]),
        chrome.alarms.get(ALARM),
      ]);
      sendResponse({
        settings: { ...settings, token: settings.token ? "••••" : "" },
        lastSync: data.lastSync || null,
        syncLog: data.syncLog || [],
        nextRunAt: alarm ? alarm.scheduledTime : null,
        syncing: !!syncing,
      });
    })();
    return true;
  }
});

scheduleAlarm(false);
