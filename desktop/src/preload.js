/*
 * preload.js — 렌더러에 안전한 API 만 노출 (contextIsolation)
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  init: () => ipcRenderer.invoke("app:init"),

  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),

  listJobs: () => ipcRenderer.invoke("jobs:list"),
  saveJob: (job) => ipcRenderer.invoke("jobs:save", job),
  removeJob: (id) => ipcRenderer.invoke("jobs:remove", id),
  runJobNow: (id) => ipcRenderer.invoke("jobs:runNow", id),
  publishNow: (draft) => ipcRenderer.invoke("jobs:publishNow", draft),

  bridgeStatus: () => ipcRenderer.invoke("bridge:status"),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),

  // 메인 → 렌더러 이벤트 구독
  onBridgeStatus: (cb) => ipcRenderer.on("bridge:status", (_e, s) => cb(s)),
  onBridgeError: (cb) => ipcRenderer.on("bridge:error", (_e, m) => cb(m)),
  onJobsChanged: (cb) => ipcRenderer.on("jobs:changed", (_e, jobs) => cb(jobs)),
});
