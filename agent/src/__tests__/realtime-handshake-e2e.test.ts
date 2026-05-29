/**
 * realtime handshake E2E — REPRODUCE the device 4001 "Invalid API key".
 *
 * Mirrors naia-omni.ts ws.onopen: connects to /v1/realtime and sends
 *   { setup: { apiKey: <naiaKey>, backend, locale } }
 * then inspects the WS close code:
 *   - 4001  → invalid API key (server auth NOT fixed) ❌ — the bug
 *   - 4503  → backend (VLLM_API_BASE) not configured — auth PASSED, pod missing
 *   - session.created → full success
 *   - 503 pod-starting JSON → cold start (auth passed, pod warming)
 *
 * The same naiaKey authenticates /v1/chat/completions (200), so a 4001 here
 * means the realtime auth path rejects a key chat accepts (server v16 target).
 *
 * Run:
 *   NAIA_TEST_KEY=gw-... pnpm exec vitest run src/__tests__/realtime-handshake-e2e.test.ts
 */
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { GATEWAY_URL, loadNaiaKey } from "./helpers/naia-test-key.js";

const naiaKey = loadNaiaKey();
const WS_URL = `${GATEWAY_URL.replace(/^http/, "ws")}/v1/realtime?model=naia-0.9-omni-24g`;

interface HandshakeResult {
	type: "session.created" | "error" | "close" | "timeout" | "wserror";
	code?: number;
	detail?: string;
}

function handshake(key: string): Promise<HandshakeResult> {
	return new Promise((resolve) => {
		const ws = new WebSocket(WS_URL);
		let settled = false;
		const done = (r: HandshakeResult) => {
			if (settled) return;
			settled = true;
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			resolve(r);
		};
		const timer = setTimeout(() => done({ type: "timeout" }), 20000);

		ws.on("open", () => {
			// Identical shape to naia-omni.ts ws.onopen (incl. instanceId).
			ws.send(
				JSON.stringify({
					setup: {
						apiKey: key,
						backend: "runpod",
						locale: "ko",
						instanceId: "e2e-test:00000000-0000-0000-0000-000000000000",
					},
				}),
			);
		});
		ws.on("message", (data) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (msg.type === "session.created") {
				clearTimeout(timer);
				done({ type: "session.created" });
			} else if (msg.error) {
				clearTimeout(timer);
				done({ type: "error", detail: JSON.stringify(msg).slice(0, 200) });
			}
		});
		ws.on("close", (code, reason) => {
			clearTimeout(timer);
			done({ type: "close", code, detail: reason.toString().slice(0, 120) });
		});
		ws.on("error", (e) => {
			clearTimeout(timer);
			done({ type: "wserror", detail: String(e).slice(0, 200) });
		});
	});
}

/**
 * SERVER HANDOFF — auth delivery matrix.
 *
 * The client sends the key as `setup.apiKey` (a body message). The OpenAI
 * Realtime convention is the `Authorization: Bearer` handshake header. If the
 * gateway's `_verify_api_key_ws` reads the header (or a query param) instead
 * of `setup.apiKey`, the body key is ignored → "Invalid API key". This probe
 * tries each transport so the server team can see which one the gateway
 * actually accepts — and whether the fix is server-side (accept setup.apiKey)
 * or client-side (also send the header).
 */
interface ProbeOpts {
	url?: string;
	headers?: Record<string, string>;
	sendSetup?: boolean;
}
function probe(key: string, label: string, opts: ProbeOpts = {}): Promise<string> {
	const url = opts.url ?? WS_URL;
	const sendSetup = opts.sendSetup ?? true;
	return new Promise((resolve) => {
		const ws = new WebSocket(url, { headers: opts.headers ?? {} });
		let done = false;
		const fin = (r: string) => {
			if (done) return;
			done = true;
			try {
				ws.close();
			} catch {
				/* ignore */
			}
			resolve(`${label} → ${r}`);
		};
		const t = setTimeout(
			() => fin("TIMEOUT(12s) — no auth reject (auth likely PASSED; cold-start/backend)"),
			12000,
		);
		ws.on("open", () => {
			if (sendSetup) {
				ws.send(
					JSON.stringify({
						setup: { apiKey: key, backend: "runpod", locale: "ko", instanceId: "probe" },
					}),
				);
			}
		});
		ws.on("message", (data) => {
			let m: Record<string, unknown>;
			try {
				m = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (m.type === "session.created") {
				clearTimeout(t);
				fin("✅ session.created (AUTH OK)");
			} else if (m.error) {
				clearTimeout(t);
				fin(`❌ ${JSON.stringify(m.error).slice(0, 90)}`);
			}
		});
		ws.on("close", (c, r) => {
			clearTimeout(t);
			fin(`close ${c} ${r.toString().slice(0, 40)}`);
		});
		ws.on("error", (e) => {
			clearTimeout(t);
			fin(`wserror ${String(e).slice(0, 60)}`);
		});
	});
}

describe("realtime handshake E2E — reproduce device 4001", () => {
	it("naiaKey available (else inconclusive)", () => {
		if (!naiaKey) console.warn("[realtime-e2e] no naiaKey — repro skipped");
		expect(true).toBe(true);
	});

	// CONTROL — prove the SAME key is valid on this gateway via chat.
	// If chat=200 but realtime rejects, the realtime auth path is the bug.
	it.skipIf(!naiaKey)(
		"control: same key authenticates /v1/chat/completions (key is valid here)",
		async () => {
			const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AnyLLM-Key": `Bearer ${naiaKey}`,
				},
				body: JSON.stringify({
					model: "vertexai:gemini-2.5-flash",
					messages: [{ role: "user", content: "ok" }],
					max_tokens: 5,
					stream: true,
				}),
				signal: AbortSignal.timeout(15000),
			});
			console.log("[chat control] status=%d (200 == key valid on gateway)", res.status);
			expect(res.status).toBe(200);
		},
		20000,
	);

	it.skipIf(!naiaKey)(
		"WS /v1/realtime setup.apiKey → close code must NOT be 4001",
		async () => {
			const r = await handshake(naiaKey as string);
			console.log("[realtime handshake]", r);
			// AUTH REJECTED appears as either a 4001 close OR an
			// {"error":{"message":"Invalid API key"}} message — catch both.
			// The same key authenticates /v1/chat/completions + /v1/ref-audio,
			// so auth rejection here is a SERVER realtime-auth bug.
			// 4503 (backend missing) / cold-start 503 / session.created = AUTH OK.
			const authRejected =
				r.code === 4001 ||
				(r.type === "error" && (r.detail ?? "").includes("Invalid API key"));
			expect(authRejected).toBe(false);
		},
		25000,
	);

	// SERVER HANDOFF — print which key-transport the gateway accepts.
	// No assert: this is a diagnostic the server team reads from the log.
	it.skipIf(!naiaKey)(
		"diagnostic: auth delivery matrix (setup.apiKey vs header vs query)",
		async () => {
			const k = naiaKey as string;
			const results = [
				await probe(k, "A. setup.apiKey only (CURRENT client)"),
				await probe(k, "B. Authorization: Bearer header + setup", {
					headers: { Authorization: `Bearer ${k}` },
				}),
				await probe(k, "C. Authorization: Bearer header, NO setup body", {
					headers: { Authorization: `Bearer ${k}` },
					sendSetup: false,
				}),
				await probe(k, "D. ?api_key= query param, NO setup body", {
					url: `${WS_URL}&api_key=${encodeURIComponent(k)}`,
					sendSetup: false,
				}),
				await probe(k, "E. X-AnyLLM-Key: Bearer header + setup", {
					headers: { "X-AnyLLM-Key": `Bearer ${k}` },
				}),
			];
			console.log("\n===== REALTIME AUTH DELIVERY MATRIX =====");
			for (const line of results) console.log("  " + line);
			console.log("=========================================\n");
			// A '✅' on B/C/D but '❌' on A ⇒ client must send that transport.
			// All '❌' ⇒ pure server-side key-lookup bug (chat path accepts the
			// same key at 200, so the realtime verifier diverges).
			expect(results.length).toBe(5);
		},
		70000,
	);
});
