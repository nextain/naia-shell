/**
 * ref-audio gateway E2E — REPRODUCE the device "Failed to fetch" / 401.
 *
 * On device (Tauri webview) the user sees:
 *   - GET  /v1/ref-audio/presets  → 200 OK (preset list renders)  ✅
 *   - GET  /v1/ref-audio          → "네트워크 오류" (Failed to fetch) ❌
 *   - POST /v1/ref-audio (upload) → "Failed to fetch"               ❌
 *
 * webview `fetch` is subject to CORS; node `fetch` is NOT. So this test
 * hits the SAME endpoints from node to separate the cause:
 *   - if status GET returns 200 here  → server fine → device fail = CORS
 *   - if it returns 401 license here  → account/license (server-side)
 *   - capture Access-Control-Allow-Origin on each response + the OPTIONS
 *     preflight for the tauri origin → confirms whether the webview origin
 *     is allowed and whether 4xx error responses carry CORS headers
 *     (a missing ACAO on the 401 makes the browser report "Failed to fetch").
 *
 * Run:
 *   NAIA_TEST_KEY=gw-... pnpm exec vitest run src/__tests__/ref-audio-e2e.test.ts
 */
import { describe, expect, it } from "vitest";
import { GATEWAY_URL, loadNaiaKey } from "./helpers/naia-test-key.js";

const naiaKey = loadNaiaKey();
// The Tauri webview origin (what the shell actually sends). NOT naia.nextain.io.
const TAURI_ORIGIN = "tauri://localhost";

function fmtHeaders(res: Response): Record<string, string | null> {
	return {
		acao: res.headers.get("access-control-allow-origin"),
		acam: res.headers.get("access-control-allow-methods"),
		acah: res.headers.get("access-control-allow-headers"),
		acac: res.headers.get("access-control-allow-credentials"),
	};
}

describe("ref-audio gateway E2E — reproduce device 'Failed to fetch'", () => {
	it("naiaKey is available (else this suite is inconclusive)", () => {
		if (!naiaKey) {
			console.warn(
				"[ref-audio-e2e] no naiaKey (set NAIA_TEST_KEY or DPAPI) — repro skipped",
			);
		}
		expect(true).toBe(true);
	});

	// CONTROL — this works on device. Confirms key + CORS for the /presets path.
	it.skipIf(!naiaKey)(
		"GET /v1/ref-audio/presets → 200 (control)",
		async () => {
			const res = await fetch(`${GATEWAY_URL}/v1/ref-audio/presets`, {
				headers: { Authorization: `Bearer ${naiaKey}`, Origin: TAURI_ORIGIN },
			});
			console.log(
				"[presets] status=%d headers=%o",
				res.status,
				fmtHeaders(res),
			);
			expect(res.status).toBe(200);
		},
	);

	// REPRO — status GET. Device = "Failed to fetch". Is it 401(license) or
	// a 2xx/4xx missing ACAO (CORS)? node fetch receives the response either way.
	it.skipIf(!naiaKey)(
		"GET /v1/ref-audio (status) — capture status + ACAO + body",
		async () => {
			const res = await fetch(`${GATEWAY_URL}/v1/ref-audio`, {
				headers: { Authorization: `Bearer ${naiaKey}`, Origin: TAURI_ORIGIN },
			});
			const body = await res.text();
			console.log(
				"[status GET] status=%d headers=%o body=%s",
				res.status,
				fmtHeaders(res),
				body.slice(0, 300),
			);
			// Diagnosis (no hard assert yet — we capture the truth first):
			//  - 200            → server fine; device "Failed to fetch" == CORS only
			//  - 401 + no ACAO  → license fail AND error response lacks CORS header
			//                     (browser hides the 401 as "Failed to fetch")
			expect(res.status).toBeGreaterThan(0);
		},
	);

	// REGRESSION (#31) — the ACTUAL root cause of "프리셋 안뜸" / device auth fail.
	// The pre-1ab7c7c7 client sent `X-AnyLLM-Key: Bearer <key>`, but the gateway
	// ref-audio routes (ref_audio.py _extract_bearer) read ONLY `Authorization`.
	// So the old build got 401 license-failed on every ref-audio call, while
	// node prod tests that only checked the 200 control looked "fine". This
	// pins the header contract: WRONG header → 401, RIGHT header → 200.
	it.skipIf(!naiaKey)(
		"header contract: X-AnyLLM-Key → 401 (old bug), Authorization → 200 (fix)",
		async () => {
			// (a) old client header — must be rejected (reproduces the device bug).
			const wrong = await fetch(`${GATEWAY_URL}/v1/ref-audio`, {
				headers: {
					"X-AnyLLM-Key": `Bearer ${naiaKey}`,
					Origin: TAURI_ORIGIN,
				},
			});
			console.log("[header contract] X-AnyLLM-Key status=%d (expect 401)", wrong.status);
			expect(wrong.status).toBe(401);

			// (b) fixed client header — must succeed (error is gone).
			const right = await fetch(`${GATEWAY_URL}/v1/ref-audio`, {
				headers: {
					Authorization: `Bearer ${naiaKey}`,
					Origin: TAURI_ORIGIN,
				},
			});
			console.log("[header contract] Authorization status=%d (expect 200)", right.status);
			expect(right.status).toBe(200);
		},
	);

	// REPRO — the actual CORS gate for upload: OPTIONS preflight from tauri origin.
	it.skipIf(!naiaKey)(
		"OPTIONS /v1/ref-audio (preflight for POST) — tauri origin allowed?",
		async () => {
			const res = await fetch(`${GATEWAY_URL}/v1/ref-audio`, {
				method: "OPTIONS",
				headers: {
					Origin: TAURI_ORIGIN,
					"Access-Control-Request-Method": "POST",
					"Access-Control-Request-Headers": "authorization,idempotency-key",
				},
			});
			console.log(
				"[preflight POST] status=%d headers=%o",
				res.status,
				fmtHeaders(res),
			);
			// If ACAO is absent or != tauri origin/*, the browser rejects the
			// actual POST → device "Failed to fetch" on upload.
			expect(res.status).toBeLessThan(500);
		},
	);
});
