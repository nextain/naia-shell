import { mkdirSync, writeFileSync as writeFileSyncNode } from "node:fs";
import { dirname as dirnameOf, resolve as resolvePath } from "node:path";

// #502 슬라이스 1 전달 — 실 Tauri 백엔드 검증 (P04, FR-ENV-DISPATCH.1·4·5·7).
//
// 여기서 확인하는 것은 UI 가 아니라 **Rust 명령 경계**다. 새로 연 두 명령이 실제로 등록됐는지,
// 형식이 어긋난 인자를 Rust 가 실제로 거절하는지를 실 백엔드에 물어본다.
// 계약 테스트는 대역 포트로 돌기 때문에 이 두 가지를 증명하지 못한다.
//
// ⚠️ 성공 경로(실제로 사용자의 pane 에 명령을 넣는 것)는 밟지 않는다. E2E 픽스처에 Herdr 세션이 없고,
//    있다 해도 실 터미널에 입력하는 것은 이 스펙의 목적이 아니다.
//
// ⚠️ 왕복을 한 번만 한다(2026-08-26 실측). execute 를 케이스마다 부르면 부팅 중 화면 전환 시점에
//    "Origin header is not a valid URL" 로 뒤쪽 케이스가 무너졌고, refresh 로 안정화하려 하면
//    앱이 다시 뜨지 않았다. 한 번의 execute 로 전부 모은 뒤 단언한다.
//    주입 함수는 async 로 만들지 않고 거절도 던지지 않는다 — 둘 다 wdio 가 결과를 파싱하지 못한다.

interface InvokeResult {
	readonly ok: boolean;
	readonly error: string;
}

interface Probe {
	readonly name: string;
	readonly cmd: string;
	readonly args: Record<string, unknown>;
}

const PROBES: Probe[] = [
	{ name: "run:registered", cmd: "herdr_run_pane", args: { paneId: "잘못된형식", command: "echo hi" } },
	{ name: "keys:registered", cmd: "herdr_send_keys", args: { paneId: "잘못된형식", keys: ["C-c"] } },
	{ name: "id:empty", cmd: "herdr_run_pane", args: { paneId: "", command: "echo hi" } },
	{ name: "id:noPrefix", cmd: "herdr_run_pane", args: { paneId: "p1", command: "echo hi" } },
	{ name: "id:noWorkspace", cmd: "herdr_run_pane", args: { paneId: "w:p1", command: "echo hi" } },
	{ name: "id:injection", cmd: "herdr_run_pane", args: { paneId: "w9:pB;rm -rf /", command: "echo hi" } },
	{ name: "id:tooLong", cmd: "herdr_run_pane", args: { paneId: `w9:p${"a".repeat(65)}`, command: "echo hi" } },
	{ name: "body:empty", cmd: "herdr_run_pane", args: { paneId: "w9:pB", command: "   " } },
	{ name: "body:tooLong", cmd: "herdr_run_pane", args: { paneId: "w9:pB", command: "a".repeat(12 * 1024 + 1) } },
	{ name: "keys:empty", cmd: "herdr_send_keys", args: { paneId: "w9:pB", keys: [] } },
	{ name: "keys:flag", cmd: "herdr_send_keys", args: { paneId: "w9:pB", keys: ["--help"] } },
	{ name: "keys:space", cmd: "herdr_send_keys", args: { paneId: "w9:pB", keys: ["a b"] } },
	{ name: "keys:tooMany", cmd: "herdr_send_keys", args: { paneId: "w9:pB", keys: Array.from({ length: 9 }, () => "esc") } },
	{ name: "unopened", cmd: "herdr_close_workspace", args: { workspaceId: "w9" } },
];

/** 명령이 등록되지 않았으면 Tauri 가 "not allowed"/"not found" 계열로 답한다. */
function looksUnregistered(error: string): boolean {
	return /not allowed|not found|unknown command|Command .* not/i.test(error);
}

let results: Record<string, InvokeResult> = {};


/**
 * 실환경 관측 증명서. 벤치는 이 파일이 있어야 native 영수증을 준다 —
 * 등급이 경로 허용목록으로만 정해지면 그것은 설정을 검증하는 것이다(2026-08-27 적대리뷰).
 * wdio 스펙은 코어를 import 하지 않으므로 같은 형식을 여기서 직접 쓴다.
 */
function writeAttestationSync(touched: readonly string[]): void {
	const root = resolvePath(import.meta.dirname, "..", "..", "..", "..");
	const file = resolvePath(
		root,
		"benchmark",
		".attest",
		`${SPEC_ID.replace(/[^A-Za-z0-9]+/g, "_")}.json`,
	);
	mkdirSync(dirnameOf(file), { recursive: true });
	writeFileSyncNode(
		file,
		`${JSON.stringify({ spec: SPEC_ID, kinds: ["native"], cases: passedCases, touched, at: Date.now() }, null, 2)}\n`,
		"utf8",
	);
}

// ⚠️ 템플릿으로 만들어지는 제목도 실제로 돈 케이스다. 리터럴만 모으면 신고에서 빠지고,
// 그러면 실환경을 밟은 케이스가 밟지 않은 것으로 읽힌다(2026-08-27 7차 실측).
/**
 * 실제로 돈 케이스를 러너에서 모은다.
 *
 * ⚠️ 손으로 적은 배열은 테스트를 고칠 때 따라오지 않는다. 실제로 세 번 어긋났다 —
 *    템플릿으로 만들어지는 제목이 빠졌고, 새로 넣은 케이스가 빠졌다. 작성자가 관리하는
 *    매핑을 하나 더 만드는 셈이라(2026-08-27 적대리뷰가 1차부터 지적한 것) 러너가
 *    직접 기록하게 한다.
 */
const passedCases: string[] = [];

afterEach(function (this: Mocha.Context) {
	const t = this.currentTest;
	if (t && t.state === "passed" && t.title) passedCases.push(t.title);
});


const SPEC_ID = "packages/shell/e2e-tauri/specs/environment-dispatch.spec.ts";

describe("환경 호출 전달 — Rust 명령 경계 (#502) [UC-ENV-LIVE-ACT FR-ENV-LIVE.4 FR-ENV-LIVE.5] (FR-ENV-LIVE.3 FR-ENV-LIVE.4 FR-ENV-LIVE.5)", () => {
	before(async () => {
		// 앱이 창을 여럿 열면 wdio 컨텍스트가 빈 쪽에 붙어 있을 수 있다.
		// 그 상태에서는 origin 이 null 이라 Tauri IPC 가 전부 거절한다(2026-08-26 실측).
		// http origin 에 있는 창으로 옮겨 붙는다.
		const handles = await browser.getWindowHandles();
		for (const handle of handles) {
			await browser.switchToWindow(handle);
			const href = (await browser.execute(() => document.location.href)) as string;
			if (typeof href === "string" && href.startsWith("http")) break;
		}

		// UI 가 그려질 때까지 기다리지 않는다. 이 스펙이 보는 것은 Rust 명령 경계이고,
		// 필요한 것은 Tauri invoke 다리뿐이다. #root 표시를 기다리면 온보딩 화면 등
		// 이 스펙과 무관한 이유로 막힌다(2026-08-26 실측).
		// Tauri 는 about:blank 에도 invoke 다리를 심는다 — 다리 존재만으로는 부족하다.
		// IPC 는 origin 을 보므로 http origin 에 실제로 도달할 때까지 기다린다.
		await browser.waitUntil(
			async () => {
				try {
					return (await browser.execute(() => document.location.href.startsWith("http"))) === true;
				} catch {
					return false;
				}
			},
			{ timeout: 60_000, timeoutMsg: "웹뷰가 60초 안에 http origin 에 도달하지 못했다" },
		);
		results = (await browser.execute((probes: Probe[]) => {
			const w = window as unknown as {
				__TAURI_INTERNALS__?: { invoke: (c: string, a: unknown) => Promise<unknown> };
				__TAURI__?: { core?: { invoke: (c: string, a: unknown) => Promise<unknown> } };
			};
			const invoke = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
			if (!invoke) {
				const missing: Record<string, { ok: boolean; error: string }> = {};
				for (const p of probes) missing[p.name] = { ok: false, error: "TAURI_INVOKE_MISSING" };
				return Promise.resolve(missing);
			}
			return Promise.all(
				probes.map((p) =>
					invoke(p.cmd, p.args).then(
						() => [p.name, { ok: true, error: "" }] as [string, { ok: boolean; error: string }],
						(e: unknown) =>
							[p.name, { ok: false, error: typeof e === "string" ? e : String(e) }] as [
								string,
								{ ok: boolean; error: string },
							],
					),
				),
			).then((entries) =>
				Object.fromEntries([
					...entries,
					// 웹뷰가 어디에 떠 있는지. IPC 가 origin 때문에 거절할 때
					// "어디서 거절됐나"를 다음 사람이 다시 파헤치지 않도록 결과에 싣는다.
					["__where", { ok: true, error: `${location.href} | origin=${location.origin}` }],
				]),
			);
		}, PROBES)) as Record<string, InvokeResult>;
	});

	// 등록 확인이 **실제 응답에서만** 오는가 (FR-ENV-ATTENTION.16, FR-ENV-LIVE.5).
	//
	// 앞선 판은 "e2e 는 에이전트를 의도적으로 막는다" 를 전제로 삼았다. 그것은 더
	// 이상 사실이 아니다 — 자격증명 등급이 격리 워크스페이스에 살아 있는 공급자를
	// 심으면서(#547) 뇌는 언제나 살아 있다. 그래서 전제에 기대지 않는 방식으로
	// 같은 것을 잰다: 에이전트가 답할 수 없는 요청을 하나 더 보내고, 거기에 확인이
	// 오지 않는지 본다. 셸이 확인을 지어낸다면 그 요청에도 확인이 온다.
	//
	// ⚠️ 성공 경로의 **내용**(gRPC 왕복 결과가 옳은가)은 여전히 여기서 재지 않는다.
	//    이 자리는 Rust 명령 경계와 확인의 출처를 재는 곳이다.
	it("확인은 실제 응답에서만 온다 — 셸이 지어내지 않는다", async () => {
		const probe = (await browser.execute(() => {
			const w = window as unknown as {
				__TAURI_INTERNALS__?: {
					invoke: (c: string, a: unknown) => Promise<unknown>;
					transformCallback?: (fn: (p: unknown) => void, once?: boolean) => number;
				};
			};
			const internals = w.__TAURI_INTERNALS__;
			if (!internals?.invoke || !internals.transformCallback) {
				return Promise.resolve({
					outcome: "TAURI_INVOKE_MISSING",
					bogusOutcome: "TAURI_INVOKE_MISSING",
					oracleAlive: false,
				});
			}
			const invoke = internals.invoke;
			const realId = `native-ack-probe-${Date.now()}`;
			const selfTestId = `${realId}-selftest`;
			// 뇌가 살아 있어도 **답이 올 수 없는** 요청. 형식이 아는 것이 아니므로
			// 에이전트는 무시한다. 여기에 확인이 오면 그것은 셸이 지어낸 것이다.
			const bogusId = `${realId}-unroutable`;
			let sawReal = false;
			let sawSelfTest = false;
			let sawBogus = false;

			// ⚠️ 관측 통로를 먼저 연다. 이것이 없으면 "확인이 오지 않았다"는 주장을 **측정할
			//    수단이 없어** 무조건 통과한다 — 실제로 그렇게 만들었다(2026-08-28 24차 지적).
			const handler = internals.transformCallback((raw: unknown) => {
				const payload = (raw as { payload?: unknown } | undefined)?.payload;
				const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
				try {
					const msg = JSON.parse(text) as { type?: string; requestId?: string };
					if (msg?.type !== "app_skills_result") return;
					if (msg.requestId === realId) sawReal = true;
					if (msg.requestId === selfTestId) sawSelfTest = true;
					if (msg.requestId === bogusId) sawBogus = true;
				} catch {
					// 다른 형태의 agent_response 는 이 탐침의 것이 아니다.
				}
			});

			const diag: string[] = [];
			// target 은 필수다(실측: "command listen missing required key target").
			return invoke("plugin:event|listen", {
				event: "agent_response",
				target: { kind: "Any" },
				handler,
			})
				.then(
					(r: unknown) => diag.push(`listen=ok:${String(r)}`),
					(e: unknown) => diag.push(`listen=err:${String(e)}`),
				)
				.then(() =>
					// 통로가 살아 있는지 스스로 증명한다. 합성 이벤트를 하나 쏴서 보이는지 본다.
					invoke("plugin:event|emit", {
						event: "agent_response",
						payload: JSON.stringify({ type: "app_skills_result", requestId: selfTestId, ok: true }),
					}).then(
						(r: unknown) => diag.push(`emit=ok:${String(r)}`),
						(e: unknown) => diag.push(`emit=err:${String(e)}`),
					),
				)
				.then(() => new Promise((r) => setTimeout(r, 500)))
				.then(() => {
					const message = JSON.stringify({
						type: "app_skills",
						appId: "bgm-widget",
						requestId: realId,
						tools: [
							{
								name: "skill_youtube_bgm",
								description: "probe",
								parameters: { type: "object", properties: {} },
							},
						],
					});
					const unroutable = JSON.stringify({
						type: "app_skills_unroutable_probe",
						appId: "bgm-widget",
						requestId: bogusId,
					});
					return invoke("send_to_agent_command", { message })
						.then(
							() => "QUEUED",
							(e: unknown) => `QUEUE_FAILED:${String(e)}`,
						)
						.then((queued: string) =>
							invoke("send_to_agent_command", { message: unroutable }).then(
								() => queued,
								(e: unknown) => {
									diag.push(`bogusSend=err:${String(e)}`);
									return queued;
								},
							),
						);
				})
				.then((queued: string) =>
					new Promise((r) => setTimeout(r, 4_000)).then(() => ({
						outcome: sawReal ? "ACKED" : queued === "QUEUED" ? "NO_ACK" : queued,
						bogusOutcome: sawBogus ? "ACKED" : "NO_ACK",
						oracleAlive: sawSelfTest,
						diag: diag.join(" | "),
					})),
				)
				// ⚠️ 거절을 그대로 두면 wdio 가 결과를 파싱하지 못한다(이 파일 머리말 참고).
				//    어느 단계에서 실패했는지 값으로 돌려준다.
				.catch((e: unknown) => ({
					outcome: `PROBE_FAILED:${String(e)}`,
					bogusOutcome: "PROBE_FAILED",
					oracleAlive: false,
					diag: diag.join(" | "),
				}));
		})) as {
			outcome: string;
			bogusOutcome: string;
			oracleAlive: boolean;
			diag?: string;
		};

		// 관측 통로가 죽어 있으면 아래 단언은 공허하다. 먼저 그것부터 세운다.
		// 실패 시 어디서 막혔는지 값에 실어 보낸다(이 러너의 expect 는 메시지 인자를 안 받는다).
		expect(probe.oracleAlive ? "oracle-alive" : `oracle-dead [${probe.diag ?? ""}]`).toBe(
			"oracle-alive",
		);

		// 전제에 기대지 않는다.
		//
		// 앞선 판은 "뇌가 없다" 를 전제로만 뜻이 있었다. 그런데 자격증명 등급이
		// 격리 워크스페이스에 살아 있는 공급자를 심게 된 뒤(#547) 그 전제는
		// **영구히** 깨졌다 — 에이전트가 언제나 살아 있으므로 이 단정은 매번
		// "전제 불성립" 으로 죽는다. 그 상태로 두면 재는 것이 없는 스펙이 실패로
		// 남아, 사람이 매 실행마다 제품 결함이 아닌 것을 들여다보게 된다.
		//
		// 재려던 것은 "뇌가 없음" 자체가 아니라 **셸이 확인을 지어내지 않는가**
		// 였다(FR-ENV-LIVE.5 — 거절과 오류를 성공으로 바꾸지 않는다). 그것은
		// 뇌가 살아 있어도 잴 수 있다: 에이전트가 답할 수 없는 요청을 하나 더
		// 보내고, 그것에 확인이 오지 않는지 본다. 셸이 확인을 지어낸다면 그
		// 요청에도 확인이 온다.
		//
		// 그래서 아래 단정은 세 갈래 어디에서도 뜻이 있다.
		//   뇌 있음   — 정상 요청은 ACKED, 답할 수 없는 요청은 NO_ACK
		//   뇌 없음   — 정상 요청도 NO_ACK 이거나 QUEUE_FAILED
		//   통로 죽음 — 위 `oracleAlive` 단정이 먼저 잡는다

		// ① 답이 올 수 없는 요청에는 확인이 오지 않는다. 이것이 이 스펙의 핵심이고
		//    뇌의 생사와 무관하다. 여기서 ACKED 가 나오면 셸이 지어낸 것이다.
		expect(probe.bogusOutcome).toBe("NO_ACK");

		// ② 정상 요청의 결과는 셋 중 하나여야 한다. `TAURI_INVOKE_MISSING` 이나
		//    `PROBE_FAILED` 는 측정 자체가 안 된 것이므로 통과가 아니다.
		expect(probe.outcome).toMatch(/^(ACKED$|NO_ACK$|QUEUE_FAILED:)/);
		expect(probe.outcome).not.toBe("TAURI_INVOKE_MISSING");
	});

	it("웹뷰가 유효한 origin 에 떠 있다 — IPC 가 origin 때문에 막히면 나머지 단언은 무의미하다", () => {
		const where = results["__where"]?.error ?? "(모름)";
		const sample = results[PROBES[0]?.name ?? ""]?.error ?? "";
		// 이 러너의 expect 는 메시지 인자를 받지 않는다 — 위치를 알려면 던져야 한다.
		if (sample.includes("Origin header is not a valid URL")) {
			throw new Error(
				`Tauri IPC 가 origin 을 거절했다. 웹뷰 위치: ${where} — 앱이 dev 서버(http://localhost:1420)에 못 붙었다는 뜻이다.`,
			);
		}
		expect(sample).not.toContain("Origin header is not a valid URL");
	});

	it("모든 탐침이 응답했다 — 빈 결과로 공허하게 통과하지 않는다", () => {
		expect(Object.keys(results).length).toBe(PROBES.length + 1); // + __where
		for (const probe of PROBES) {
			expect(results[probe.name]).toBeDefined();
			expect(results[probe.name]?.error).not.toBe("TAURI_INVOKE_MISSING");
		}
	});

	describe("새로 연 명령이 등록돼 있다 (FR-ENV-DISPATCH.7)", () => {
		it("herdr_run_pane 이 등록돼 있다 — 미등록이 아니라 인자 검증에서 걸린다", () => {
			const r = results["run:registered"];
			expect(r?.ok).toBe(false);
			expect(looksUnregistered(r?.error ?? "")).toBe(false);
			expect(r?.error).toContain("Invalid Herdr pane id");
		});

		it("herdr_send_keys 가 등록돼 있다", () => {
			const r = results["keys:registered"];
			expect(r?.ok).toBe(false);
			expect(looksUnregistered(r?.error ?? "")).toBe(false);
			expect(r?.error).toContain("Invalid Herdr pane id");
		});
	});

	describe("Rust 가 식별자 형식을 실제로 검증한다 (FR-ENV-DISPATCH.4)", () => {
		const cases: [string, string][] = [
			["빈 값", "id:empty"],
			["접두사 없음", "id:noPrefix"],
			["워크스페이스 부분 없음", "id:noWorkspace"],
			["구분자 주입", "id:injection"],
			["과길이", "id:tooLong"],
		];
		for (const [label, key] of cases) {
			it(`${label} 인 표면 식별자를 거절한다`, () => {
				const r = results[key];
				expect(r?.ok).toBe(false);
				expect(r?.error).toContain("Invalid Herdr pane id");
			});
		}
	});

	describe("Rust 가 본문과 키를 실제로 검증한다 (FR-ENV-DISPATCH.5)", () => {
		const cases: [string, string, string][] = [
			["빈 명령", "body:empty", "command is required"],
			["상한을 넘는 명령", "body:tooLong", "byte limit"],
			["빈 키 배열", "keys:empty", "keys are required"],
			["플래그로 해석될 수 있는 키", "keys:flag", "must not start with"],
			["공백이 든 키", "keys:space", "Invalid Herdr key"],
			["키 개수 상한 초과", "keys:tooMany", "exceed"],
		];
		for (const [label, key, expected] of cases) {
			it(`${label}을(를) 거절한다`, () => {
				const r = results[key];
				expect(r?.ok).toBe(false);
				expect(r?.error).toContain(expected);
			});
		}
	});

	describe("열지 않은 명령은 없다 (FR-ENV-DISPATCH.1)", () => {
		it("이 슬라이스가 열지 않은 herdr 명령은 등록돼 있지 않다", () => {
			const r = results["unopened"];
			expect(r?.ok).toBe(false);
			expect(looksUnregistered(r?.error ?? "")).toBe(true);
		});
	});

	after(() => {
		// 이 실행이 실제 Rust 백엔드를 밟았다는 증명서를 남긴다.
		writeAttestationSync([SPEC_ID, `pid:${process.pid}`]);
	});
});
