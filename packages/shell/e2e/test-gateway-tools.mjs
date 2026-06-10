/**
 * Gateway tool execution E2E test.
 * Tests: connect → hello → challenge → connect(token) → node.invoke(system.run)
 *
 * Usage: node shell/e2e/test-gateway-tools.mjs
 */

// Uses Node.js native WebSocket (Node 22+)

const PORT = 18789;
const TOKEN = "57e2ad5473652d231cd530a613762be5adb147a022b92215";
const WS_URL = `ws://127.0.0.1:${PORT}`;

function send(ws, obj) {
	const msg = JSON.stringify(obj);
	ws.send(msg);
}

function waitForMessage(ws, predicate, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Timeout waiting for message")),
			timeoutMs,
		);
		const handler = (event) => {
			const frame = JSON.parse(
				typeof event.data === "string" ? event.data : event.data.toString(),
			);
			if (predicate(frame)) {
				clearTimeout(timer);
				ws.removeEventListener("message", handler);
				resolve(frame);
			}
		};
		ws.addEventListener("message", handler);
	});
}

async function main() {
	console.log("=== Gateway Tool Execution E2E ===\n");

	// 1. Health check
	try {
		const res = await fetch(`http://127.0.0.1:${PORT}/health`);
		const health = await res.json();
		console.log(`1. Health: ${health.ok ? "PASS" : "FAIL"} (${health.status})`);
		if (!health.ok) process.exit(1);
	} catch (e) {
		console.log(`1. Health: FAIL (${e.message})`);
		process.exit(1);
	}

	// 2. WebSocket connect + handshake
	const ws = new WebSocket(WS_URL);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve);
		ws.addEventListener("error", reject);
	});

	// Debug: log all messages
	ws.addEventListener("message", (event) => {
		const frame = JSON.parse(event.data);
		console.log(
			"  << ",
			frame.type,
			frame.id || "",
			frame.method || "",
			JSON.stringify(frame).slice(0, 120),
		);
	});

	// Wait for connect.challenge event (server sends this first)
	const challenge = await waitForMessage(
		ws,
		(f) => f.type === "event" && f.event === "connect.challenge",
	);
	console.log("2. Challenge received");

	// Send connect request with auth token (protocol: challenge → connect → res)
	send(ws, {
		type: "req",
		id: "e2e-connect",
		method: "connect",
		params: {
			auth: { token: TOKEN },
			minProtocol: 3,
			maxProtocol: 3,
			client: {
				id: "cli",
				platform: "linux",
				mode: "cli",
				version: "0.1.1",
			},
			role: "operator",
			scopes: ["operator.read", "operator.write"],
		},
	});

	const connectRes = await waitForMessage(
		ws,
		(f) => f.type === "res" && f.id === "e2e-connect",
	);
	if (!connectRes.ok) {
		console.log(`3. Connect: FAIL (${connectRes.error?.message || "unknown"})`);
		ws.close();
		process.exit(1);
	}

	const payload = connectRes.payload || {};
	const methods = payload.features?.methods || payload.methods || [];
	const methodCount = Array.isArray(methods) ? methods.length : 0;
	console.log(`3. Connect+Auth: PASS (${methodCount} methods)`);

	// Get node list to find connected nodes
	send(ws, {
		type: "req",
		id: "e2e-nodelist",
		method: "node.list",
		params: {},
	});
	const nodeListRes = await waitForMessage(
		ws,
		(f) => f.type === "res" && f.id === "e2e-nodelist",
	);
	const nodes = nodeListRes.payload?.nodes || [];
	const connectedNode = nodes.find((n) => n.connected);
	const nodeId = connectedNode?.nodeId || "";
	console.log(
		`4. Nodes: ${nodes.length} total, connected: ${
			nodes
				.filter((n) => n.connected)
				.map((n) => n.displayName)
				.join(", ") || "none"
		}, nodeId=${nodeId ? `${nodeId.slice(0, 12)}...` : "none"}`,
	);

	// 3. Test node.invoke with system.run (echo test)
	console.log("\n--- Tool Execution Tests ---");

	if (!nodeId) {
		console.log("  No node registered — skipping tool tests");
		ws.close();
		process.exit(1);
	}

	let idCounter = 0;
	const mkParams = (command, params) => ({
		nodeId,
		idempotencyKey: `e2e-${Date.now()}-${idCounter++}`,
		command,
		params,
	});

	const tests = [
		{
			name: "execute_command (echo hello)",
			method: "node.invoke",
			params: mkParams("system.run", { command: ["echo", "hello-from-e2e"] }),
		},
		{
			name: "execute_command (date)",
			method: "node.invoke",
			params: mkParams("system.run", { command: ["date"] }),
		},
		{
			name: "execute_command (uname -a)",
			method: "node.invoke",
			params: mkParams("system.run", { command: ["uname", "-a"] }),
		},
	];

	let passed = 0;
	let failed = 0;

	for (let i = 0; i < tests.length; i++) {
		const t = tests[i];
		const reqId = `e2e-tool-${i}`;
		send(ws, {
			type: "req",
			id: reqId,
			method: t.method,
			params: t.params,
		});

		try {
			const res = await waitForMessage(
				ws,
				(f) => f.type === "res" && f.id === reqId,
				10000,
			);
			if (res.ok) {
				// Unwrap: res.payload.payloadJSON contains the stringified result
				const p = res.payload || {};
				const inner = p.payloadJSON ? JSON.parse(p.payloadJSON) : p;
				const stdout =
					inner?.stdout?.trim() || JSON.stringify(inner).slice(0, 80);
				console.log(`  ${i + 3}. ${t.name}: PASS → ${stdout}`);
				passed++;
			} else {
				console.log(
					`  ${i + 3}. ${t.name}: FAIL → ${res.error?.message || "unknown"}`,
				);
				failed++;
			}
		} catch (e) {
			console.log(`  ${i + 3}. ${t.name}: FAIL → ${e.message}`);
			failed++;
		}
	}

	ws.close();

	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
	process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error("Fatal:", e.message);
	process.exit(1);
});
