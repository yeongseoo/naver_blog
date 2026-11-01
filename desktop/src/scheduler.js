/*
 * scheduler.js — 예약 큐를 주기적으로 확인해 발행 시각이 도래한 작업을 실행한다.
 * 실행은 bridge.publish() 로 확장에 위임한다.
 */
const store = require("./store");
const bridge = require("./bridge");

let timer = null;
let onChange = () => {};
let running = new Set(); // 중복 실행 방지

function start(changeCallback) {
  onChange = changeCallback || (() => {});
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 10000); // 10초마다 확인
  tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick() {
  const now = Date.now();
  const due = store
    .getJobs()
    .filter(
      (j) => j.status === "queued" && j.scheduledAt <= now && !running.has(j.id)
    );
  for (const job of due) {
    runJob(job.id);
  }
}

/** 특정 작업을 즉시 실행 (예약 시각과 무관하게 '지금 실행'도 이걸 씀) */
async function runJob(id) {
  const job = store.getJobs().find((j) => j.id === id);
  if (!job || running.has(id)) return;

  if (!bridge.connected) {
    store.updateJob(id, {
      status: "failed",
      log: "확장이 연결되어 있지 않습니다. Chrome에서 확장을 켜고 네이버에 로그인하세요.",
      finishedAt: Date.now(),
    });
    onChange();
    return;
  }

  running.add(id);
  store.updateJob(id, { status: "publishing", startedAt: Date.now() });
  onChange();

  const settings = store.getSettings();
  const res = await bridge.publish({
    jobId: id,
    title: job.title,
    blocks: job.blocks,
    mode: job.mode || settings.defaultMode,
    writeUrl: settings.writeUrl,
  });

  const steps = (res.steps || [])
    .map((s) => `${s.ok ? "✅" : "❌"} ${s.step}${s.detail ? " · " + s.detail : ""}`)
    .join("\n");

  store.updateJob(id, {
    status: res.success ? "done" : "failed",
    log: res.success
      ? "발행 완료\n" + steps
      : "실패: " + (res.error || "") + (steps ? "\n" + steps : ""),
    result: res,
    finishedAt: Date.now(),
  });
  running.delete(id);
  onChange();
}

module.exports = { start, stop, runJob };
