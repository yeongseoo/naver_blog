/*
 * main.js — Electron 메인 프로세스
 * 창 생성 + 로컬 WS 서버(확장 연동) + 예약 스케줄러 + IPC(렌더러 UI 연결)
 */
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const crypto = require("crypto");

const store = require("./store");
const bridge = require("./bridge");
const scheduler = require("./scheduler");

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: "#0f1115",
    title: "블로그 오토포스터",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  if (process.argv.includes("--dev")) win.webContents.openDevTools({ mode: "detach" });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

app.whenReady().then(() => {
  store.load();
  createWindow();

  // WS 서버 시작
  bridge.start(store.getSettings().wsPort);
  bridge.on("status", (s) => send("bridge:status", s));
  bridge.on("error", (e) => send("bridge:error", String(e && e.message)));
  bridge.on("publish-result", () => send("jobs:changed", store.getJobs()));

  // 스케줄러 시작 (작업 상태가 바뀌면 렌더러에 알림)
  scheduler.start(() => send("jobs:changed", store.getJobs()));

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  bridge.stop();
  scheduler.stop();
});

// ---------------------------------------------------------------------------
// IPC — 렌더러 ↔ 메인
// ---------------------------------------------------------------------------
ipcMain.handle("app:init", () => ({
  settings: store.getSettings(),
  jobs: store.getJobs(),
  bridge: { connected: bridge.connected, port: store.getSettings().wsPort },
}));

ipcMain.handle("settings:get", () => store.getSettings());

ipcMain.handle("settings:set", (_e, patch) => {
  const prevPort = store.getSettings().wsPort;
  const next = store.setSettings(patch);
  if (patch.wsPort && patch.wsPort !== prevPort) {
    bridge.start(next.wsPort); // 포트 바뀌면 서버 재시작
  }
  return next;
});

ipcMain.handle("jobs:list", () => store.getJobs());

ipcMain.handle("jobs:save", (_e, job) => {
  const id = job.id || "job_" + crypto.randomUUID();
  const now = Date.now();
  const saved = store.upsertJob({
    id,
    title: job.title || "",
    blocks: Array.isArray(job.blocks) ? job.blocks : [],
    mode: job.mode || store.getSettings().defaultMode,
    scheduledAt: job.scheduledAt || now,
    status: "queued",
    createdAt: job.createdAt || now,
    log: "",
    result: null,
  });
  send("jobs:changed", store.getJobs());
  return saved;
});

ipcMain.handle("jobs:remove", (_e, id) => {
  store.removeJob(id);
  send("jobs:changed", store.getJobs());
  return true;
});

ipcMain.handle("jobs:runNow", async (_e, id) => {
  await scheduler.runJob(id);
  return store.getJobs().find((j) => j.id === id);
});

// "지금 발행" — 큐에 넣지 않고 곧바로 실행 (임시 작업 생성 후 실행)
ipcMain.handle("jobs:publishNow", async (_e, draft) => {
  const id = "job_" + crypto.randomUUID();
  const now = Date.now();
  store.upsertJob({
    id,
    title: draft.title || "",
    blocks: Array.isArray(draft.blocks) ? draft.blocks : [],
    mode: draft.mode || store.getSettings().defaultMode,
    scheduledAt: now,
    status: "queued",
    createdAt: now,
    log: "",
    result: null,
  });
  send("jobs:changed", store.getJobs());
  await scheduler.runJob(id);
  return store.getJobs().find((j) => j.id === id);
});

ipcMain.handle("bridge:status", () => ({
  connected: bridge.connected,
  port: store.getSettings().wsPort,
}));

ipcMain.handle("open:external", (_e, url) => {
  shell.openExternal(url);
  return true;
});
