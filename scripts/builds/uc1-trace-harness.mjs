#!/usr/bin/env node
// uc1-trace-harness — Option C 헤드리스 trace. 새 core(dist)를 *실제 child_process stdio* 로 구동.
// 기본 = **fake agent**(chat_request→text+finish 에코, LLM·frozen 빌드 불요) 로 end-to-end 1턴 trace.
// 실 frozen agent 로 바꾸려면 AGENT_CMD 환경변수로 spawn 커맨드 지정(예: AGENT_CMD="node ../old-naia-os/agent/dist/index.js --stdio").
// 라이브 admin 무접촉(별 프로세스). 사용: node scripts/builds/uc1-trace-harness.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ChatService } from "../../dist/main/app/chat/chat-service.js";
import { InMemoryClientSession } from "../../dist/main/app/chat/client-session.js";
import { MessageRouter } from "../../dist/main/adapters/message-router.js";
import { makeChildStdioTransport } from "../../dist/main/adapters/child-stdio.js";

// fake agent: stdin chat_request → stdout text+finish (실 agent 와 동일 wire 프로토콜).
const FAKE_AGENT = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  let r; try { r = JSON.parse(l); } catch { return; }
  if (r.type === 'chat_request') {
    process.stdout.write(JSON.stringify({ type: 'text', requestId: r.requestId, text: '(fake) 안녕하세요, 나이아입니다.' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'usage', requestId: r.requestId, tokens: 7 }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'finish', requestId: r.requestId }) + '\\n');
  } else if (r.type === 'cancel_stream') {
    process.stdout.write(JSON.stringify({ type: 'finish', requestId: r.requestId }) + '\\n');
  }
});
`;

const agentCmd = process.env.AGENT_CMD;
const child = agentCmd
  ? spawn(agentCmd, { shell: true, stdio: ["pipe", "pipe", "inherit"] })
  : spawn(process.execPath, ["-e", FAKE_AGENT], { stdio: ["pipe", "pipe", "inherit"] });

console.log(`[UC1-TRACE] agent = ${agentCmd ? `실제(${agentCmd})` : "fake(에코)"} pid=${child.pid}`);

// child_process stdio → LineIO
const rl = createInterface({ input: child.stdout });
let lineCb = null;
const io = {
  writeLine: (line) => { child.stdin.write(line + "\n"); },
  onLine: (cb) => { lineCb = cb; return () => { lineCb = null; }; },
};
rl.on("line", (l) => lineCb?.(l));

// 새 core 결선(child-stdio transport)
const sessions = new InMemoryClientSession();
const transport = makeChildStdioTransport(io);
const chat = new ChatService(transport, sessions);
const router = new MessageRouter({
  transport, chat, sessions,
  pending: { pending: (m) => console.log("[UC1-TRACE] pending(비-chat):", m.type) },
  diagnostic: { diagnose: (m, why) => console.warn("[UC1-TRACE] diagnostic:", m.type, why) },
});
router.start();

// 1턴 trace
const rendered = [];
const { handle, sent } = chat.startTurn(
  { kind: "chat", requestId: "trace-1", clientId: "harness",
    provider: { provider: "ollama", model: "gemma4" },
    messages: [{ role: "user", content: "안녕 나이아" }] },
  (c) => { rendered.push(c.kind); console.log("[UC1-TRACE] 렌더 chunk:", c.kind, c.kind === "text" ? c.text : ""); },
);

sent.then(() => console.log("[UC1-TRACE] 송신 OK (stdin write)")).catch((e) => console.error("[UC1-TRACE] 송신 실패:", e));

// finish 까지 대기(최대 5s)
const deadline = Date.now() + 5000;
const poll = setInterval(() => {
  const done = rendered.includes("finish") || rendered.includes("error");
  if (done || Date.now() > deadline) {
    clearInterval(poll);
    const ownerReleased = sessions.ownerOf("trace-1") === undefined;
    const pass = rendered.includes("text") && rendered.includes("finish") && ownerReleased;
    console.log("[UC1-TRACE] 결과", JSON.stringify({ rendered, ownerReleased, verdict: pass ? "✅ PASS — 실 process stdio 1턴 end-to-end" : "⚠ 미완(타임아웃/누락)" }));
    void handle;
    child.kill();
    rl.close();
    process.exit(pass ? 0 : 1);
  }
}, 50);
