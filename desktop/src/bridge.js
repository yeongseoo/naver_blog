/*
 * bridge.js — Chrome 확장과 통신하는 로컬 WebSocket 서버
 *
 * 확장(background.js)이 ws://127.0.0.1:<port> 로 접속한다. 앱은 발행 작업을
 * push 하고, 확장이 RabbitWrite 로 실행한 결과를 받는다.
 * 로그인/자동화는 확장(사용자의 실제 Chrome 세션)이 담당하므로 앱은 계정정보를 다루지 않는다.
 */
const { WebSocketServer } = require("ws");
const { EventEmitter } = require("events");

class Bridge extends EventEmitter {
  constructor() {
    super();
    this.wss = null;
    this.client = null; // 연결된 확장 소켓 (1개만 사용)
    this.port = null;
    this.pingTimer = null;
    this.pending = new Map(); // jobId -> {resolve, timer}
  }

  get connected() {
    return !!(this.client && this.client.readyState === 1);
  }

  start(port) {
    this.stop();
    this.port = port;
    try {
      this.wss = new WebSocketServer({ host: "127.0.0.1", port });
    } catch (e) {
      this.emit("error", e);
      return;
    }

    this.wss.on("connection", (ws) => {
      this.client = ws;
      this.emit("status", this.statusObject("확장 연결됨"));

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this.handle(ws, msg);
      });

      ws.on("close", () => {
        if (this.client === ws) this.client = null;
        this.emit("status", this.statusObject("확장 연결 끊김"));
      });
      ws.on("error", () => {});
    });

    this.wss.on("error", (e) => this.emit("error", e));

    // 확장 서비스워커 생존 유지용 주기 ping
    this.pingTimer = setInterval(() => {
      if (this.connected) {
        try {
          this.client.send(JSON.stringify({ type: "PING" }));
        } catch {}
      }
    }, 20000);

    this.emit("status", this.statusObject("서버 대기중"));
  }

  stop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.wss) {
      try {
        this.wss.close();
      } catch {}
    }
    this.wss = null;
    this.client = null;
  }

  handle(ws, msg) {
    if (msg.type === "HELLO") {
      this.emit("status", this.statusObject("확장 연결됨 (빌드 " + (msg.build || "?") + ")"));
      return;
    }
    if (msg.type === "PONG") return;
    if (msg.type === "JOB_ACK") {
      this.emit("job-ack", msg.jobId);
      return;
    }
    if (msg.type === "PUBLISH_RESULT") {
      const p = this.pending.get(msg.jobId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.jobId);
        p.resolve(msg);
      }
      this.emit("publish-result", msg);
      return;
    }
  }

  statusObject(text) {
    return { connected: this.connected, text, port: this.port };
  }

  /** 발행 작업을 확장으로 보내고 결과를 기다린다 (Promise) */
  publish({ jobId, title, blocks, mode, writeUrl }, timeoutMs = 90000) {
    return new Promise((resolve) => {
      if (!this.connected) {
        resolve({ jobId, success: false, error: "확장이 연결되어 있지 않습니다." });
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(jobId);
        resolve({ jobId, success: false, error: "확장 응답 시간 초과" });
      }, timeoutMs);
      this.pending.set(jobId, { resolve, timer });
      try {
        this.client.send(
          JSON.stringify({
            type: "PUBLISH",
            jobId,
            draft: { title, blocks },
            mode: mode || "publish",
            writeUrl,
          })
        );
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(jobId);
        resolve({ jobId, success: false, error: e.message });
      }
    });
  }
}

module.exports = new Bridge();
