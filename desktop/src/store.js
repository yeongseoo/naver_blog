/*
 * store.js — 아주 단순한 JSON 파일 저장소 (userData 폴더)
 * 외부 의존성 없이 설정/글 초안/예약 큐를 영구 저장한다.
 */
const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULTS = {
  settings: {
    wsPort: 8765,
    // 로그인만 돼 있으면 사용자 블로그 글쓰기로 자동 리다이렉트되는 URL
    writeUrl: "https://blog.naver.com/GoBlogWrite.naver",
    defaultMode: "publish", // "publish"(실제 발행) | "temp"(임시저장)
  },
  jobs: [], // 예약 큐 { id, title, blocks, mode, scheduledAt, status, createdAt, result, log }
};

let filePath = null;
let data = null;

function load() {
  filePath = path.join(app.getPath("userData"), "autoposter-data.json");
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    data = {
      settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch {
    data = JSON.parse(JSON.stringify(DEFAULTS));
    save();
  }
  return data;
}

function save() {
  if (!filePath) return;
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error("store save 실패:", e.message);
  }
}

function getSettings() {
  return data.settings;
}
function setSettings(patch) {
  data.settings = { ...data.settings, ...patch };
  save();
  return data.settings;
}

function getJobs() {
  return data.jobs;
}
function upsertJob(job) {
  const i = data.jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) data.jobs[i] = { ...data.jobs[i], ...job };
  else data.jobs.push(job);
  save();
  return job;
}
function removeJob(id) {
  data.jobs = data.jobs.filter((j) => j.id !== id);
  save();
}
function updateJob(id, patch) {
  const j = data.jobs.find((x) => x.id === id);
  if (!j) return null;
  Object.assign(j, patch);
  save();
  return j;
}

module.exports = {
  load,
  save,
  getSettings,
  setSettings,
  getJobs,
  upsertJob,
  removeJob,
  updateJob,
};
