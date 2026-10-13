import { createServer, type Server } from "node:http";
import { ensureAppReady } from "../helpers/settings.js";

type RuntimeSnapshot = {
	serverState: string;
	reservation: {
		kind: string | null;
		status: string;
		bytes: number | null;
		reasonCode?: string | null;
	};
};

async function tauriInvoke<T>(
	command: string,
	args: Record<string, unknown> = {},
): Promise<T> {
	const raw = (await browser.execute(
		async (name: string, payload: Record<string, unknown>) => {
			const shell = window as unknown as {
				__TAURI_INTERNALS__?: {
					invoke: (command: string, value: unknown) => Promise<unknown>;
				};
			};
			if (!shell.__TAURI_INTERNALS__?.invoke) {
				return JSON.stringify({ ok: false, error: "Tauri invoke unavailable" });
			}
			try {
				const value = await shell.__TAURI_INTERNALS__.invoke(name, payload);
				return JSON.stringify({ ok: true, value: value ?? null });
			} catch (error) {
				return JSON.stringify({
					ok: false,
					error: typeof error === "string" ? error : String(error),
				});
			}
		},
		command,
		args,
	)) as string;
	const result = JSON.parse(raw) as {
		ok: boolean;
		value?: T;
		error?: string;
	};
	if (!result.ok) throw new Error(result.error ?? `${command} failed`);
	return result.value as T;
}

describe("97 — Ollama runtime reservation IPC", () => {
	let fixture: Server;
	let host = "";
	let requestCount = 0;

	before(async () => {
		if (process.env.NAIA_SHELL_E2E_FAKE_ACCELERATOR !== "1") {
			throw new Error("This spec requires the injected fake accelerator inventory");
		}
		fixture = createServer((request, response) => {
			requestCount += 1;
			if (request.url === "/api/tags") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ models: [{ name: "fixture-model" }] }));
				return;
			}
			response.writeHead(404, { "content-type": "application/json" });
			response.end("{}");
		});
		await new Promise<void>((resolve, reject) => {
			fixture.once("error", reject);
			fixture.listen(0, "127.0.0.1", resolve);
		});
		const address = fixture.address();
		if (!address || typeof address === "string") {
			throw new Error("Could not bind the local Ollama fixture");
		}
		host = `http://127.0.0.1:${address.port}`;
		await ensureAppReady();
	});

	after(async () => {
		try {
			await tauriInvoke("ollama_runtime_stop");
		} catch {
			// The test may have already released its session lease.
		}
		if (fixture?.listening) {
			await new Promise<void>((resolve) => fixture.close(() => resolve()));
		}
	});

	it("reserves one fake local session lease and never signals its external server", async () => {
		const first = await tauriInvoke<RuntimeSnapshot>("ollama_runtime_status", {
			host,
			deviceId: null,
		});
		expect(first.serverState).toBe("ready_external_local");
		expect(first.reservation).toEqual({
			kind: "local_llm",
			status: "running",
			bytes: null,
		});

		const repeated = await tauriInvoke<RuntimeSnapshot>("ollama_runtime_status", {
			host,
			deviceId: null,
		});
		expect(repeated.serverState).toBe("ready_external_local");
		expect(repeated.reservation.status).toBe("running");

		await tauriInvoke("ollama_runtime_stop");
		const response = await fetch(`${host}/api/tags`);
		expect(response.status).toBe(200);
		expect(requestCount).toBeGreaterThanOrEqual(3);
	});
});
