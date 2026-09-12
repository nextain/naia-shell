import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname as dirnameOf, resolve as resolvePath } from "node:path";

// #582 UC-ENV-TOOL-RECOVER — 감독자 생명주기 (P04, native). 계약 4.8·4.9, 9절 S6b.
//
// 셸→IPC→Rust 를 실 백엔드로 돈다. 재는 것은 **Rust 의 회수 규칙**이다.
//   (a) Reset 뒤 marker 가 맞는 프로세스와 lease 가 남지 않는다
//   (b) marker 가 다른 프로세스는 살아남고 그 lease 도 지워지지 않는다 — PID 는 재사용된다
//   (c) 정상 종료 뒤 lease 가 정리된다
//
// ⚠️ 실제 Chromium 을 띄우지 않는다. 이 스펙이 답하는 질문은 "브라우저가 도는가" 가 아니라
//    "우리 표식이 붙은 프로세스만 골라 회수하는가" 다. 그래서 표식만 달고 자는 프로세스를 쓴다
//    (`packages/ego-host/test/helpers/marker-sleep.mjs` — S2b 가 같은 목적에 쓰던 것).
//    실 Chromium 을 지나는 회수는 ego-host 패키지의 lease·조정 테스트가 실 브라우저로 돈다.

const SPEC_ID = "packages/shell/e2e-tauri/specs/env-tool-browser-host-lifecycle.spec.ts";
const MARKER_FLAG = "--naia-ego-marker";
const MARKER_SLEEP = resolvePath(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"ego-host",
	"test",
	"helpers",
	"marker-sleep.mjs",
);

const ADK = (process.env.NAIA_E2E_ADK_PATH ?? "").trim();
const LEASE_DIR = ADK ? resolvePath(ADK, "ego-host") : "";
const LEASE = LEASE_DIR ? resolvePath(LEASE_DIR, "lease.json") : "";

interface Marked {
	readonly child: ChildProcess;
	readonly pid: number;
	readonly nonce: string;
	exited: boolean;
}

const spawned: Marked[] = [];

/** marker 를 명령줄에 달고 자는 프로세스 하나. 종료를 이벤트로 관측한다(좀비를 살아 있다고 읽지 않기 위해). */
function markedProcess(nonce: string): Marked {
	const child = spawn(process.execPath, [MARKER_SLEEP, `${MARKER_FLAG}=${nonce}`], {
		stdio: "ignore",
	});
	if (typeof child.pid !== "number") throw new Error("표식 프로세스를 띄우지 못했다");
	const marked: Marked = { child, pid: child.pid, nonce, exited: false };
	child.on("exit", () => {
		marked.exited = true;
	});
	spawned.push(marked);
	return marked;
}

/** 감독자가 쓰는 lease 형식 그대로 (packages/ego-host/src/supervisor/lease.mjs createLease). */
function writeLease(browser: Marked, supervisor?: Marked): void {
	mkdirSync(LEASE_DIR, { recursive: true });
	writeFileSync(
		LEASE,
		`${JSON.stringify(
			{
				nonce: browser.nonce,
				marker: `${MARKER_FLAG}=${browser.nonce}`,
				startedAt: new Date().toISOString(),
				pid: browser.pid,
				executable: process.execPath,
				profileDir: resolvePath(LEASE_DIR, "profile"),
				socketPath: resolvePath(LEASE_DIR, "socket"),
				supervisorPid: supervisor?.pid ?? process.pid,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

/** wdio 의 expect 는 메시지 인자를 받지 않는다. 실패 이유는 이 헬퍼가 던진다. */
function assertTrue(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
	predicate: () => boolean,
	{ timeoutMs = 15_000, stepMs = 100 } = {},
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(stepMs);
	}
	return predicate();
}

interface InvokeResult {
	readonly ok: boolean;
	readonly error: string;
}

/** 실 Rust 명령을 실 IPC 로 부른다. 대역이 아니다. */
async function invokeCommand(cmd: string, args: Record<string, unknown>): Promise<InvokeResult> {
	return (await browser.execute(
		(command: string, payload: Record<string, unknown>) => {
			const internals = (
				window as unknown as {
					__TAURI_INTERNALS__?: { invoke: (c: string, a: unknown) => Promise<unknown> };
				}
			).__TAURI_INTERNALS__;
			if (!internals?.invoke) {
				return Promise.resolve({ ok: false, error: "TAURI_INVOKE_MISSING" });
			}
			return internals.invoke(command, payload).then(
				() => ({ ok: true, error: "" }),
				(error: unknown) => ({ ok: false, error: typeof error === "string" ? error : String(error) }),
			);
		},
		cmd,
		args,
	)) as InvokeResult;
}

async function webviewReady(): Promise<void> {
	await browser.waitUntil(
		async () => {
			try {
				return (await browser.execute(() => document.location.href.startsWith("http"))) === true;
			} catch {
				return false;
			}
		},
		{ timeout: 90_000, timeoutMsg: "웹뷰가 http origin 에 도달하지 못했다" },
	);
}

const passedCases: string[] = [];

afterEach(function (this: Mocha.Context) {
	const t = this.currentTest;
	if (t && t.state === "passed" && t.title) passedCases.push(t.title);
});

/** 실환경 관측 증명서. 벤치는 이 파일이 있어야 native 영수증을 준다. */
function writeAttestationSync(touched: readonly string[]): void {
	const root = resolvePath(import.meta.dirname, "..", "..", "..", "..");
	const file = resolvePath(
		root,
		"benchmark",
		".attest",
		`${SPEC_ID.replace(/[^A-Za-z0-9]+/g, "_")}.json`,
	);
	mkdirSync(dirnameOf(file), { recursive: true });
	writeFileSync(
		file,
		`${JSON.stringify({ spec: SPEC_ID, kinds: ["native"], cases: passedCases, touched, at: Date.now() }, null, 2)}\n`,
		"utf8",
	);
}

describe("브라우저 호스트 생명주기 (#582 UC-ENV-TOOL-RECOVER)", () => {
	before(async () => {
		if (!ADK) {
			throw new Error(
				"NAIA_E2E_ADK_PATH 가 없다. 이 스펙은 ADK 안의 lease 를 다루므로 건너뛰지 않고 실패한다.",
			);
		}
		if (!existsSync(MARKER_SLEEP)) {
			throw new Error(`표식 프로세스 도우미가 없다: ${MARKER_SLEEP}`);
		}
		await webviewReady();
	});

	it("Reset 뒤 marker 가 맞는 감독자와 브라우저가 남지 않는다", async () => {
		const supervisor = markedProcess(randomUUID());
		const target = markedProcess(supervisor.nonce);
		writeLease(target, supervisor);
		expect(existsSync(LEASE)).toBe(true);

		const result = await invokeCommand("reset_naia_config_files", { adkPath: ADK });
		expect(result.error).not.toBe("TAURI_INVOKE_MISSING");
		assertTrue(result.ok, `reset 이 실패했다: ${result.error}`);

		assertTrue(await waitUntil(() => target.exited), "marker 가 맞는 브라우저 프로세스가 살아남았다");
		assertTrue(
			await waitUntil(() => supervisor.exited),
			"같은 marker 를 가진 감독자 프로세스가 살아남았다",
		);
		assertTrue(await waitUntil(() => !existsSync(LEASE)), "lease 가 남았다");
	});

	it("marker 가 다른 프로세스는 건드리지 않고 lease 도 지우지 않는다", async () => {
		// PID 는 재사용된다. lease 의 marker 와 실제 명령줄이 다르면 그것은 남의 프로세스다.
		const foreign = markedProcess("other");
		writeLease({ ...foreign, nonce: randomUUID() } as Marked, undefined);
		expect(existsSync(LEASE)).toBe(true);

		const result = await invokeCommand("reset_naia_config_files", { adkPath: ADK });
		assertTrue(result.ok, `reset 이 실패했다: ${result.error}`);

		// 판정에 시간이 필요하다. 죽지 않았다는 것을 확인하려면 죽을 시간을 준 뒤에 봐야 한다.
		await sleep(3_000);
		assertTrue(!foreign.exited, "marker 가 다른데 프로세스를 죽였다");
		assertTrue(existsSync(LEASE), "남의 프로세스인데 lease 를 지웠다");

		rmSync(LEASE, { force: true });
		foreign.child.kill("SIGKILL");
	});

	it("정상 종료 뒤 lease 가 정리된다", async () => {
		const target = markedProcess(randomUUID());
		writeLease(target);
		assertTrue(existsSync(LEASE), "lease 를 쓰지 못했다");

		// 창을 닫는다. 이것이 사람이 앱을 끄는 길이고, Rust 의 창 파괴 경로가 소유 런타임 정리를 돈다.
		//
		// `browser.deleteSession()` 은 이 경로를 밟지 않는다 — tauri-driver 가 프로세스를 그냥
		// 내려서 창 파괴 이벤트가 오지 않는다(2026-09-10 실측: lease 가 그대로 남았다).
		// 세션 종료와 앱의 정상 종료는 다른 일이고, 계약이 말하는 것은 뒤쪽이다.
		//
		// 앱이 그 자리에서 죽으므로 응답이 돌아오지 않을 수 있다. 그것은 실패가 아니다 —
		// 판정은 응답이 아니라 **lease 와 프로세스**가 한다.
		await invokeCommand("plugin:window|close", { label: "main" }).catch(() => undefined);

		assertTrue(
			await waitUntil(() => !existsSync(LEASE), { timeoutMs: 30_000 }),
			"정상 종료 뒤에도 lease 가 남았다",
		);
		assertTrue(
			await waitUntil(() => target.exited, { timeoutMs: 10_000 }),
			"정상 종료가 표식 프로세스를 회수하지 않았다",
		);
	});

	it("재시작 뒤 이전 lease 가 조정된다", async () => {
		const target = markedProcess(randomUUID());
		writeLease(target);
		assertTrue(existsSync(LEASE), "lease 를 쓰지 못했다");

		// 실제 재시작이다 — tauri-driver 가 바이너리를 다시 띄우고, 시작 조정이 lease 를 읽는다.
		// 이 뒤로 이 세션의 `execute` 는 쓸 수 없다(2026-09-10 실측). 그래서 이 케이스가 마지막이고,
		// 판정은 웹뷰가 아니라 파일과 프로세스로 한다 — 재시작의 증거는 거기 있다.
		await browser.reloadSession();

		assertTrue(
			await waitUntil(() => target.exited, { timeoutMs: 60_000 }),
			"시작 조정이 이전 lease 의 프로세스를 회수하지 않았다",
		);
		assertTrue(await waitUntil(() => !existsSync(LEASE)), "시작 조정 뒤에도 lease 가 남았다");
	});

	after(() => {
		for (const marked of spawned) {
			if (!marked.exited) marked.child.kill("SIGKILL");
		}
		rmSync(LEASE, { force: true });
		writeAttestationSync([SPEC_ID, `pid:${process.pid}`]);
	});
});
