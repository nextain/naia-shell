/**
 * E2E: Spawn agent-core directly, send a tool_request via stdin,
 * verify tool execution flows through Gateway → Node Host → result.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

const AGENT_SCRIPT = join(import.meta.dirname, "../../agent/src/index.ts");
const GATEWAY_URL = "ws://127.0.0.1:18789";
const TOKEN = "57e2ad5473652d231cd530a613762be5adb147a022b92215";

const agent = spawn("npx", ["tsx", AGENT_SCRIPT], {
	stdio: ["pipe", "pipe", "pipe"],
	shell: true,
});

const rl = createInterface({ input: agent.stdout });
const results = [];
let done = false;

rl.on("line", (line) => {
	try {
		const msg = JSON.parse(line);
		results.push(msg);

		// Log relevant messages
		if (msg.type === "tool_result") {
			console.log("[agent] tool_result:", JSON.stringify(msg).slice(0, 200));
		} else if (msg.type === "approval_request") {
			console.log("[agent] approval_request for:", msg.toolName);
			// Auto-approve
			const approval = {
				type: "approval_response",
				requestId: msg.requestId,
				toolCallId: msg.toolCallId,
				decision: "once",
			};
			agent.stdin.write(`${JSON.stringify(approval)}\n`);
			console.log("[agent] Auto-approved:", msg.toolName);
		} else if (msg.type === "stream_end" || msg.type === "finish") {
			console.log(`[agent] ${msg.type} requestId:`, msg.requestId);
			done = true;
			checkResults();
		} else if (msg.type === "error") {
			console.log("[agent] ERROR:", msg.message || JSON.stringify(msg));
		} else {
			// Log other types briefly
			if (msg.type !== "stream_chunk") {
				console.log(`[agent] ${msg.type}:`, JSON.stringify(msg).slice(0, 120));
			}
		}
	} catch {
		// non-JSON line (npm warnings etc)
	}
});

agent.stderr.on("data", (data) => {
	const text = data.toString().trim();
	if (text) {
		console.log("[agent stderr]", text.slice(0, 300));
	}
});

// Wait for agent ready message, then send tool_request
function sendRequest() {
	console.log("\n=== Sending tool_request: execute_command ===\n");
	const request = {
		type: "tool_request",
		requestId: "e2e-tool-1",
		toolName: "execute_command",
		args: { command: "echo agent-gateway-e2e-ok" },
		gatewayUrl: GATEWAY_URL,
		gatewayToken: TOKEN,
	};
	agent.stdin.write(`${JSON.stringify(request)}\n`);
}

// Send after we see 'ready' or after 8s fallback
let sent = false;
const origPush = results.push.bind(results);
results.push = (...args) => {
	const r = origPush(...args);
	if (!sent && args[0]?.type === "ready") {
		sent = true;
		setTimeout(sendRequest, 500);
	}
	return r;
};
setTimeout(() => {
	if (!sent) {
		sent = true;
		sendRequest();
	}
}, 8000);

// Timeout
const timeout = setTimeout(() => {
	if (!done) {
		console.log("\n=== TIMEOUT (30s) — collected messages: ===");
		for (const r of results) {
			console.log(`  ${r.type}: ${JSON.stringify(r).slice(0, 150)}`);
		}
		console.log("\n=== FAIL: Timed out ===");
		agent.kill();
		process.exit(1);
	}
}, 30000);

function checkResults() {
	clearTimeout(timeout);
	const toolResult = results.find((r) => r.type === "tool_result");
	if (toolResult) {
		console.log("\n=== Tool Result ===");
		console.log(JSON.stringify(toolResult, null, 2));

		const output =
			toolResult.output ||
			toolResult.result?.stdout ||
			JSON.stringify(toolResult);
		if (output?.includes("agent-gateway-e2e-ok")) {
			console.log(
				"\n=== PASS: Agent → Gateway → Node Host → execute_command worked! ===",
			);
			agent.kill();
			process.exit(0);
		} else {
			console.log("\n=== FAIL: Unexpected output ===");
			agent.kill();
			process.exit(1);
		}
	} else {
		console.log("\n=== FAIL: No tool_result received ===");
		for (const r of results) {
			console.log(`  ${r.type}: ${JSON.stringify(r).slice(0, 150)}`);
		}
		agent.kill();
		process.exit(1);
	}
}
