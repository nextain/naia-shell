import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname as dirnameOf, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";

// #582 UC-ENV-TOOL-BROWSE·SCRIPT — 풀스택 (P04, native). 계약 4.2·4.4·4.5·4.8, 9절 S6c.
//
// 이 스펙이 답하는 질문 하나: **실 Tauri 앱에서 채팅 도구 호출이 실 Chromium 증거를 돌려주는가.**
// 그 답이 아니오이면 S6a 의 도구도 S6b 의 회수도 사용자에게는 없는 기능이다.
//
// 지나는 층: 웹뷰의 EnvironmentToolService(등급·승인) → 코어 어댑터 → ego_host_op_* Tauri 명령
//            → Rust 다리 → bin/supervisord.mjs → 감독자 → **실 Chromium**.
// 대역은 한 겹도 없다. 페이지는 이 스펙이 띄운 로컬 픽스처이고 외부 네트워크는 0 이다.
//
//   (a) env_browser_open 이 증거 셋(스냅샷 참조·캡처 경로·주소 개정)을 돌려주고 캡처가 PNG 다
//   (b) env_browser_click 이 **안정 참조**로 실제 요소를 누른다 (누른 결과를 페이지에서 되읽는다)
//   (c) 승인 없는 env_browser_script 는 거부다 — 실기에서도 형식 도구로 우회되지 않는다
//   (c2) 웹뷰에는 토큰 발급·관리 RPC·원시 CDP 명령이 아예 없고, 조작한 grant 는 Rust 가 버린다 (S7 P0)
//   (d) 앱을 닫으면 감독자 데몬과 Chromium 이 남지 않는다 (S6b 와 결합)

const SPEC_ID = "packages/shell/e2e-tauri/specs/env-tool-browser-host-fullstack.spec.ts";

const ADK = (process.env.NAIA_E2E_ADK_PATH ?? "").trim();
const EGO_DIR = ADK ? resolvePath(ADK, "ego-host") : "";
const LEASE = EGO_DIR ? resolvePath(EGO_DIR, "lease.json") : "";
const EVIDENCE = EGO_DIR ? resolvePath(EGO_DIR, "evidence") : "";

const FIXTURE_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>naia 픽스처</title></head>
<body>
  <h1>#582 브라우저 호스트 픽스처</h1>
  <p id="out">before</p>
  <button id="go" type="button">확인 단추</button>
  <script>
    document.getElementById("go").addEventListener("click", function () {
      document.getElementById("out").textContent = "clicked";
      document.title = "clicked";
    });
  </script>
</body></html>`;

interface BrowserHostEvidence {
	readonly snapshotRef?: string;
	readonly screenshotRef?: string;
	readonly url?: string;
	readonly urlRevision?: number;
}

interface BrowserHostCard {
	readonly tool: string;
	readonly status: string;
	readonly workspaceId: string;
	readonly operationId?: string;
	readonly evidence?: BrowserHostEvidence;
	readonly result?: string;
	readonly refusals?: readonly { code: string; detail: string }[];
}

interface ToolOutcome {
	readonly ok?: boolean;
	readonly card?: BrowserHostCard;
	readonly error?: string;
}

let fixture: Server | null = null;
let fixtureUrl = "";
const passedCases: string[] = [];

function assertTrue(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM = 남의 것이지만 살아 있다. "죽었다"로 읽으면 남지 않았다고 잘못 말한다.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitUntil(
	predicate: () => boolean,
	{ timeoutMs = 30_000, stepMs = 200 } = {},
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(stepMs);
	}
	return predicate();
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

/**
 * 도구 호출 하나. 셸이 채팅에서 부르는 그 실행기를 같은 인자로 부른다(`browser-host-skill.ts`
 * 의 e2e 이음매). 뇌를 거치지 않는 이유는 실기에서 LLM 이 그 도구를 고를 때까지 기다리는 것이
 * 결정적이지 않기 때문이며, 이음매 아래는 한 겹도 대역이 아니다.
 */
async function callTool(tool: string, args: Record<string, unknown>): Promise<ToolOutcome> {
	return (await browser.execute(
		(toolName: string, toolArgs: Record<string, unknown>, id: string) => {
			const seam = (
				window as unknown as {
					__NAIA_BROWSER_HOST_CALL__?: (
						t: string,
						a: Record<string, unknown>,
						i: string,
					) => Promise<{ ok: boolean; card: unknown }>;
				}
			).__NAIA_BROWSER_HOST_CALL__;
			if (typeof seam !== "function") {
				return Promise.resolve({ error: "BROWSER_HOST_SEAM_MISSING" });
			}
			return seam(toolName, toolArgs, id).then(
				(result) => ({ ok: result.ok, card: result.card }),
				(error: unknown) => ({ error: String(error) }),
			);
		},
		tool,
		args,
		`e2e-${randomUUID().slice(0, 8)}`,
	)) as ToolOutcome;
}

/** 실 Rust 명령 하나. 감독자 PID 를 이 통로로 확인한다(대역이 아니다). */
async function invokeCommand(cmd: string, args: Record<string, unknown>): Promise<unknown> {
	return browser.execute(
		(command: string, payload: Record<string, unknown>) => {
			const internals = (
				window as unknown as {
					__TAURI_INTERNALS__?: { invoke: (c: string, a: unknown) => Promise<unknown> };
				}
			).__TAURI_INTERNALS__;
			if (!internals?.invoke) return Promise.resolve({ error: "TAURI_INVOKE_MISSING" });
			return internals.invoke(command, payload).then(
				(value: unknown) => value,
				(error: unknown) => ({ error: String(error) }),
			);
		},
		cmd,
		args,
	);
}

/**
 * 명령 하나를 부르고 **성공·거부 어느 쪽이든 값으로** 받는다.
 *
 * 등록되지 않은 명령의 거부는 웹뷰 안의 `catch` 가 아니라 WebDriver 경계에서 예외로 올라온다.
 * 그 예외를 잡지 않으면 "명령이 없다"는 사실이 스펙의 실패로 보여, 우리가 재려던 것과
 * 스펙이 깨진 것을 구별할 수 없다.
 */
async function invokeMaybe(
	cmd: string,
	args: Record<string, unknown>,
): Promise<{ value?: unknown; error?: string }> {
	try {
		const value = await invokeCommand(cmd, args);
		const shape = value as { error?: unknown } | null;
		if (shape && typeof shape === "object" && typeof shape.error === "string") {
			return { error: shape.error };
		}
		return { value };
	} catch (error) {
		return { error: String(error) };
	}
}

function describeCard(outcome: ToolOutcome): string {
	return JSON.stringify(outcome).slice(0, 900);
}

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

afterEach(function (this: Mocha.Context) {
	const t = this.currentTest;
	if (t && t.state === "passed" && t.title) passedCases.push(t.title);
});

let workspaceId = "";
let snapshotFile = "";
let capturePath = "";
let daemonPid = 0;
let chromiumPid = 0;

describe("브라우저 호스트 풀스택 (#582 UC-ENV-TOOL-BROWSE·SCRIPT)", () => {
	before(async () => {
		if (!ADK) {
			throw new Error(
				"NAIA_E2E_ADK_PATH 가 없다. 이 스펙은 ADK 안의 증거 파일을 확인하므로 건너뛰지 않고 실패한다.",
			);
		}
		// 픽스처는 이 프로세스가 띄운다. 외부 네트워크로 나가면 그 순간 이 스펙은 남의 페이지를 잰다.
		fixture = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(FIXTURE_HTML);
		});
		await new Promise<void>((resolve) => fixture?.listen(0, "127.0.0.1", resolve));
		const address = fixture.address();
		if (!address || typeof address === "string") throw new Error("픽스처 서버 주소를 얻지 못했다");
		fixtureUrl = `http://127.0.0.1:${address.port}/fixture`;

		await webviewReady();
		// Chromium 기동과 첫 스냅샷이 한 호출에 들어간다. 기본 스크립트 상한으로는 모자란다.
		await browser.setTimeout({ script: 180_000 });
		await browser.waitUntil(
			async () =>
				(await browser.execute(
					() =>
						typeof (window as unknown as { __NAIA_BROWSER_HOST_CALL__?: unknown })
							.__NAIA_BROWSER_HOST_CALL__ === "function",
				)) === true,
			{ timeout: 60_000, timeoutMsg: "브라우저 호스트 실행기가 웹뷰에 오르지 않았다" },
		);
	});

	it("(a) env_browser_open 이 실 Chromium 의 증거 셋을 돌려주고 캡처가 실제 PNG 다", async () => {
		const created = await callTool("env_browser_create_workspace", { name: "s6c-fullstack" });
		assertTrue(created.ok === true, `작업 공간을 만들지 못했다: ${describeCard(created)}`);
		workspaceId = String(created.card?.workspaceId ?? "");
		assertTrue(workspaceId !== "", "작업 공간 손잡이가 비었다");

		const opened = await callTool("env_browser_open", { url: fixtureUrl });
		assertTrue(opened.ok === true, `열기가 실패했다: ${describeCard(opened)}`);
		const evidence = opened.card?.evidence;
		assertTrue(Boolean(evidence), `증거 셋이 없다: ${describeCard(opened)}`);

		snapshotFile = String(evidence?.snapshotRef ?? "");
		capturePath = String(evidence?.screenshotRef ?? "");
		assertTrue(snapshotFile !== "", "스냅샷 참조가 비었다");
		assertTrue(capturePath !== "", "캡처 참조가 비었다");
		assertTrue(
			String(evidence?.url ?? "").includes("127.0.0.1"),
			`주소가 픽스처가 아니다: ${evidence?.url}`,
		);
		assertTrue(Number(evidence?.urlRevision ?? 0) >= 1, `주소 개정이 0 이다: ${describeCard(opened)}`);

		// 참조가 문자열로만 존재하면 그것은 증거가 아니다. 파일이 실제로 있고 PNG 여야 한다.
		assertTrue(capturePath.startsWith(EVIDENCE), `캡처가 증거 디렉터리 밖이다: ${capturePath}`);
		assertTrue(existsSync(capturePath), `캡처 파일이 없다: ${capturePath}`);
		const magic = readFileSync(capturePath).subarray(0, 8);
		assertTrue(
			magic.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
			`캡처가 PNG 가 아니다: ${capturePath}`,
		);
		assertTrue(existsSync(snapshotFile), `스냅샷 파일이 없다: ${snapshotFile}`);
		// 산출물의 자리를 실행 기록에 남긴다. 증거 문서가 "어느 파일을 봤는지" 를 말할 수 있어야 한다.
		process.stdout.write(
			`[s6c] 증거 캡처=${capturePath} (${readFileSync(capturePath).length}바이트) 스냅샷=${snapshotFile}\n`,
		);
		const snapshot = readFileSync(snapshotFile, "utf8");
		assertTrue(snapshot.includes("확인 단추"), `스냅샷에 픽스처의 단추가 없다:\n${snapshot.slice(0, 400)}`);

		// 감독자와 Chromium 의 PID 를 (d) 를 위해 지금 잡아 둔다. lease 는 감독자가 쓴 사실이다.
		const lease = JSON.parse(readFileSync(LEASE, "utf8")) as {
			pid?: number;
			supervisorPid?: number;
		};
		chromiumPid = Number(lease.pid ?? 0);
		daemonPid = Number(lease.supervisorPid ?? 0);
		assertTrue(alive(chromiumPid), `lease 의 Chromium(PID ${chromiumPid})이 살아 있지 않다`);
		assertTrue(alive(daemonPid), `lease 의 감독자(PID ${daemonPid})가 살아 있지 않다`);
	});

	it("(b) env_browser_click 이 안정 참조로 실제 요소를 누른다", async () => {
		// 참조는 지어내지 않는다. 방금 남은 스냅샷 파일에서 그 단추의 ref 를 읽는다 —
		// `ref=N` 과 `refs[].backendNodeId` 가 같은 값이라는 것이 감독자와의 기계 계약이다.
		const snapshot = readFileSync(snapshotFile, "utf8");
		const line = snapshot.split("\n").find((entry) => entry.includes("확인 단추"));
		assertTrue(Boolean(line), `스냅샷에서 단추 줄을 찾지 못했다:\n${snapshot.slice(0, 400)}`);
		const ref = /ref=(\d+)/.exec(line ?? "")?.[1] ?? "";
		assertTrue(ref !== "", `단추 줄에 ref 가 없다: ${line}`);

		const clicked = await callTool("env_browser_click", { ref });
		assertTrue(clicked.ok === true, `클릭이 실패했다: ${describeCard(clicked)}`);

		// 눌렀다는 주장이 아니라 **페이지가 바뀐 사실**을 확인한다. 좌표도 아니고 참조였다.
		const read = await callTool("env_browser_evaluate", {
			expression: "document.getElementById('out').textContent",
		});
		assertTrue(read.ok === true, `되읽기가 실패했다: ${describeCard(read)}`);
		assertTrue(
			String(read.card?.result ?? "").includes("clicked"),
			`클릭이 페이지를 바꾸지 않았다: ${describeCard(read)}`,
		);

		// 낡은 참조는 작용하지 않는다 — 있지도 않은 번호로는 아무것도 누르지 못한다.
		const stale = await callTool("env_browser_click", { ref: "999999" });
		assertTrue(stale.ok === false, `없는 참조로 클릭이 통과했다: ${describeCard(stale)}`);
	});

	it("(c) 승인 없는 env_browser_script 는 실기에서도 거부된다", async () => {
		const refused = await callTool("env_browser_script", {
			code: "console.log(await page.info())",
		});
		assertTrue(refused.ok === false, `승인 없는 묶음 실행이 통과했다: ${describeCard(refused)}`);
		const codes = (refused.card?.refusals ?? []).map((entry) => entry.code);
		assertTrue(
			codes.includes("approval-missing"),
			`거부 사유가 승인 부재가 아니다: ${describeCard(refused)}`,
		);
		// 거부가 관측 도구를 망가뜨리지 않는다.
		const snapshot = await callTool("env_browser_snapshot", {});
		assertTrue(snapshot.ok === true, `거부 뒤 스냅샷이 실패했다: ${describeCard(snapshot)}`);
	});

	it("(c2) 웹뷰에는 토큰 발급·원시 CDP 명령이 없고, 조작한 grant 는 Rust 가 버린다", async () => {
		// 없어야 하는 문 다섯. Tauri 는 등록되지 않은 명령을 거부한다 — 그 거부가 곧 증거다.
		for (const removed of [
			"ego_host_issue_token",
			"ego_host_rpc",
			"ego_host_session_open",
			"ego_host_session_cdp",
			"ego_host_session_rpc",
		]) {
			const answer = await invokeMaybe(removed, {
				operationId: `e2e-${randomUUID().slice(0, 8)}`,
				method: "issueToken",
				session: 1,
				payload: '{"id":1,"method":"Browser.close"}',
				grant: { tier: "credential", approvalRef: "지어낸-승인" },
			});
			assertTrue(
				typeof answer.error === "string" && /not found/i.test(answer.error),
				`${removed} 가 아직 웹뷰에 있다: ${JSON.stringify(answer).slice(0, 300)}`,
			);
		}

		// heredoc 명령은 **있고**, 어떤 인자로도 통과하지 않는다.
		const script = await invokeMaybe("ego_host_op_script", {
			operationId: `e2e-${randomUUID().slice(0, 8)}`,
			grant: { tier: "credential", approvalRef: "지어낸-승인" },
		});
		assertTrue(
			String(script.error ?? "").includes("approval-missing"),
			`ego_host_op_script 가 승인 부재로 거부하지 않았다: ${JSON.stringify(script).slice(0, 300)}`,
		);

		// 조작한 등급을 실어 관측 작업을 연다. 등급은 **명령 이름**이 정하므로 관측이고,
		// 그 연결의 원시 CDP 는 Rust 가 먼저 거부한다.
		const observeOp = `e2e-${randomUUID().slice(0, 8)}`;
		const observe = await invokeMaybe("ego_host_op_snapshot", {
			operationId: observeOp,
			workspaceId,
			deadline: 15_000,
			grant: { tier: "credential", approvalRef: "지어낸-승인" },
		});
		assertTrue(
			typeof observe.value === "number",
			`관측 작업이 서지 않았다: ${JSON.stringify(observe).slice(0, 300)}`,
		);
		const cdp = await invokeMaybe("ego_host_op_cdp", {
			session: observe.value,
			payload: '{"id":1,"method":"Browser.close"}',
			operationId: observeOp,
		});
		assertTrue(
			String(cdp.error ?? "").includes("grant-required"),
			`관측 작업이 원시 CDP 를 보냈다 — 조작한 grant 가 이겼다: ${JSON.stringify(cdp).slice(0, 300)}`,
		);
		await invokeMaybe("ego_host_op_end", { session: observe.value });
		await invokeMaybe("ego_host_op_complete", {
			operationId: observeOp,
			status: "completed",
			reason: null,
		});

		// 반대 방향. `click` 은 이름이 workspace-write 이므로 조작한 관측 등급이 이기지 못한다.
		const writeOp = `e2e-${randomUUID().slice(0, 8)}`;
		const write = await invokeMaybe("ego_host_op_click", {
			operationId: writeOp,
			workspaceId,
			deadline: 15_000,
			grant: { tier: "observe" },
		});
		assertTrue(
			typeof write.value === "number",
			`쓰기 작업이 서지 않았다: ${JSON.stringify(write).slice(0, 300)}`,
		);
		const writeCdp = await invokeMaybe("ego_host_op_cdp", {
			session: write.value,
			payload: '{"id":1,"method":"Runtime.enable"}',
			operationId: writeOp,
		});
		assertTrue(
			writeCdp.error === undefined,
			`쓰기 작업의 CDP 가 막혔다 — 조작한 관측 등급이 이겼다: ${JSON.stringify(writeCdp).slice(0, 300)}`,
		);
		await invokeMaybe("ego_host_op_end", { session: write.value });
		await invokeMaybe("ego_host_op_complete", {
			operationId: writeOp,
			status: "completed",
			reason: null,
		});

		// 앞의 거부들이 정상 경로를 망가뜨리지 않는다.
		const snapshot = await callTool("env_browser_snapshot", {});
		assertTrue(snapshot.ok === true, `문을 닫은 뒤 스냅샷이 실패했다: ${describeCard(snapshot)}`);
	});

	it("(d) 앱을 닫으면 감독자와 Chromium 이 남지 않는다", async () => {
		assertTrue(daemonPid > 0 && chromiumPid > 0, "회수 대상 PID 를 잡지 못했다");
		// 창을 닫는 것이 사람이 앱을 끄는 길이고, Rust 의 창 파괴 경로가 소유 런타임 정리를 돈다.
		// `deleteSession()` 은 그 경로를 밟지 않는다(S6b 실측). 응답은 돌아오지 않을 수 있다.
		await invokeCommand("plugin:window|close", { label: "main" }).catch(() => undefined);

		assertTrue(
			await waitUntil(() => !alive(chromiumPid), { timeoutMs: 40_000 }),
			`종료 뒤에도 Chromium(PID ${chromiumPid})이 남았다`,
		);
		assertTrue(
			await waitUntil(() => !alive(daemonPid), { timeoutMs: 40_000 }),
			`종료 뒤에도 감독자 데몬(PID ${daemonPid})이 남았다`,
		);
		assertTrue(await waitUntil(() => !existsSync(LEASE), { timeoutMs: 20_000 }), "lease 가 남았다");
	});

	after(async () => {
		fixture?.close();
		if (chromiumPid > 0 && alive(chromiumPid)) {
			try {
				process.kill(chromiumPid, "SIGKILL");
			} catch {
				/* 이미 나갔다 */
			}
		}
		if (daemonPid > 0 && alive(daemonPid)) {
			try {
				process.kill(daemonPid, "SIGKILL");
			} catch {
				/* 이미 나갔다 */
			}
		}
		// 증거 파일은 다음 실행이 옛 캡처를 자기 것으로 읽지 않도록 치운다.
		if (EVIDENCE && existsSync(EVIDENCE)) {
			for (const entry of readdirSync(EVIDENCE)) {
				rmSync(resolvePath(EVIDENCE, entry), { force: true });
			}
		}
		writeAttestationSync([SPEC_ID, `adk:${ADK}`, `fixture:${fixtureUrl}`]);
	});
});
