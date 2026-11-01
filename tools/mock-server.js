/*
 * mock-server.js — 브릿지 API 규격을 흉내 내는 테스트용 서버 (의존성 없음)
 *
 * 실행:  node tools/mock-server.js            (기본 포트 8787, 토큰 test-token)
 * 확장 설정:  API 주소 = http://localhost:8787/api/naver-bridge,  토큰 = test-token
 *
 * 실제 웹 서비스를 만들 때 이 파일의 동작(상태 전이)을 그대로 참고하면 된다.
 */
const http = require("http");

const PORT = Number(process.env.PORT) || 8787;
const TOKEN = process.env.TOKEN || "test-token";
const BASE = "/api/naver-bridge";

// "DB" — 실제 서비스에서는 테이블 한 개 (status: pending → processing → done/failed)
const posts = [
  {
    id: "post-1",
    title: "[테스트] 브릿지 자동 발행 글",
    mode: "temp", // 테스트라 임시저장
    status: "pending",
    blocks: [
      { type: "heading", content: "소제목입니다" },
      { type: "text", content: "첫 번째 문단입니다.\n두 번째 줄입니다." },
      { type: "quote", content: "인용구 블록" },
      { type: "divider", style: "line1" },
      { type: "text", content: "마지막 문단입니다." },
    ],
  },
];

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.headers.authorization !== "Bearer " + TOKEN) return json(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && url.pathname === BASE + "/pending") {
      const limit = Math.max(0, parseInt(url.searchParams.get("limit") || "1", 10));
      const due = posts.filter((p) => p.status === "pending").slice(0, limit);
      due.forEach((p) => (p.status = "processing")); // 가져간 글은 잠금 (중복 발행 방지)
      console.log(`GET pending limit=${limit} → ${due.map((p) => p.id).join(", ") || "(없음)"}`);
      return json(res, 200, {
        posts: due.map(({ id, title, blocks, mode }) => ({ id, title, blocks, mode })),
      });
    }

    if (req.method === "POST" && url.pathname === BASE + "/result") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let r;
        try {
          r = JSON.parse(body);
        } catch {
          return json(res, 400, { error: "bad json" });
        }
        const p = posts.find((x) => x.id === r.id);
        if (p) Object.assign(p, { status: r.success ? "done" : "failed", result: r });
        console.log("POST result", JSON.stringify(r));
        json(res, 200, { ok: true });
      });
      return;
    }

    json(res, 404, { error: "not found" });
  })
  .listen(PORT, () => {
    console.log(`mock bridge API: http://localhost:${PORT}${BASE}  (token: ${TOKEN})`);
  });
