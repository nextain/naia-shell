import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const adkPath = process.env.NAIA_E2E_ADK_PATH;

async function tauriInvoke<T>(command: string): Promise<T> {
	return (await browser.execute(async (cmd: string) => {
		const w = window as unknown as {
			__TAURI_INTERNALS__?: { invoke: (name: string, value: unknown) => Promise<unknown> };
			__TAURI__?: { core?: { invoke: (name: string, value: unknown) => Promise<unknown> } };
		};
		const invoke = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
		if (!invoke) throw new Error("Tauri invoke unavailable");
		return invoke(cmd, {});
	}, command)) as T;
}

/** 에이전트가 파일을 잠깐 쥐고 있으면(EBUSY/EPERM) 조금 기다렸다 다시 쓴다. */
function writeWithRetry(path: string, content: Buffer): void {
	for (let attempt = 1; ; attempt += 1) {
		try {
			writeFileSync(path, content, { mode: 0o600 });
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (attempt >= 10 || (code !== "EBUSY" && code !== "EPERM")) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
		}
	}
}

describe("Naia Memory ADK settings storage boundary", () => {
	it("reads Agent's exact store through the real native Shell IPC", async () => {
		if (!adkPath) throw new Error("NAIA_E2E_ADK_PATH is required");

		const storePath = resolve(adkPath, "naia-settings", "memory", "store.json");
		const legacyPath = resolve(adkPath, "naia-settings", ".memory", "alpha-memory.json");
		// 격리 ADK 는 실행 내내 하나다. 여기서 심는 최소 store.json 은 에이전트의
		// LocalAdapter 가 읽지 못하는 모양이라, 남겨 두면 뒤 스펙의 메모리 다시
		// 읽기(온보딩 완료·나이아 로그인)가 전부 "Failed to load LocalAdapter
		// store" 로 실패했다. 끝나면 두 파일을 원래대로 돌린다.
		const previous = [storePath, legacyPath].map((path) => ({
			path,
			content: existsSync(path) ? readFileSync(path) : null,
		}));
		try {
			mkdirSync(resolve(storePath, ".."), { recursive: true });
			mkdirSync(resolve(legacyPath, ".."), { recursive: true });
			writeFileSync(storePath, JSON.stringify({
				version: 1,
				facts: [{ id: "new-boundary", content: "memory/store.json", importance: 1 }],
			}), { mode: 0o600 });
			writeFileSync(legacyPath, JSON.stringify({
				version: 1,
				facts: [{ id: "legacy-boundary", content: ".memory/alpha-memory.json" }],
			}), { mode: 0o600 });

			const facts = await tauriInvoke<Array<{ id: string; content: string }>>("memory_get_all_facts");
			expect(facts.map((fact) => fact.id)).toEqual(["new-boundary"]);
			expect(facts[0]?.content).toBe("memory/store.json");
			expect(existsSync(storePath)).toBe(true);
			expect(JSON.parse(readFileSync(storePath, "utf8")).facts).toHaveLength(1);
		} finally {
			// 한 파일의 복구가 잠금(EBUSY/EPERM)으로 실패해도 다른 파일은 돌린다.
			const failures: string[] = [];
			for (const { path, content } of previous) {
				try {
					if (content === null) {
						rmSync(path, { force: true, maxRetries: 10, retryDelay: 200 });
					} else {
						writeWithRetry(path, content);
					}
				} catch (error) {
					failures.push(`${path}: ${String(error)}`);
				}
			}
			if (failures.length) {
				throw new Error(`96 could not restore memory files — ${failures.join("; ")}`);
			}
		}
	});
});
