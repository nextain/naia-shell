/**
 * #582 S6c — 감독자 모듈 자리에 꽂는 **Tauri IPC 구현** (계약 4.2·4.8, 9절 S6c).
 *
 * S6a 가 남긴 구멍이 여기다. 셸 웹뷰에는 node 가 없어 코어 어댑터의 기본 로더
 * (`packages/ego-host/src/host-api.mjs` 동적 import)가 웹뷰에서는 늘 실패했고, 그래서
 * 테스트가 초록이어도 사용자는 도구를 쓸 수 없었다.
 *
 * ## 왜 포트를 다시 구현하지 않았나
 *
 * 브리프는 `BrowserWorkspacePort`·`BrowserOperationPort`·`CancellationPort` 를 `invoke` 로
 * 구현하라고 적었다. 그러지 않고 **그 아래 한 겹**을 IPC 로 바꿨다. 세 포트는 코어 어댑터
 * (`src/main/adapters/ego-browser-env.ts`)가 이미 구현하고 있고, 그 안에는 안정 참조 검사·
 * 개정 대조·attach·문서 로드 대기·증거 셋 조립이 들어 있다. 포트를 웹뷰에서 새로 쓰면
 * **같은 뜻의 구현이 둘**이 되고, 둘이 갈라지는 날 실 Chromium 으로 돌던 S3a 계약 테스트가
 * 웹뷰의 동작을 더는 증명하지 못한다(S6b 가 marker 경계에서 겪은 그 자리다).
 *
 * 그래서 이 파일이 채우는 것은 어댑터가 보는 좁은 면(`EgoHostApi`) 하나다. 그 위는 전부
 * 실물이며, 이 파일 아래로는 Tauri 명령뿐이다.
 *
 *   포트 셋 ← 코어 어댑터 ← **이 파일(EgoHostApi over IPC)** ← ego_host_* 명령 ← 감독자
 *
 * ## 무엇이 비동기가 됐나
 *
 * node 안에서는 동기였던 세 자리(`issueToken`·`ensureDirs`·`writeEnvFiles`)가 IPC 를 지나며
 * Promise 가 된다. 어댑터의 그 세 호출부에 `await` 를 넣고 타입을 `T | Promise<T>` 로 넓혔다.
 * 문자열을 await 해도 같은 문자열이므로 node 조립(계약 테스트)은 그대로 돈다.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { EgoHostApi } from "@nextain/naia-os-core/composition";

/**
 * 도구 RPC 이름 → 그 RPC 의 Tauri 명령 (S7).
 *
 * 웹뷰가 부를 수 있는 문은 이 표에 있는 것뿐이다. 토큰 발급·관리 RPC·원시 CDP 의 넓은 문은
 * Rust 에서 사라졌고, **등급은 부른 명령의 이름이 정한다** — 여기서 등급을 실어 보내지 않는다.
 * 표에 없는 이름은 명령을 찾지 못해 실패한다(기본 거부).
 */
export const EGO_HOST_OP_COMMAND: Readonly<Record<string, string>> = {
	open: "ego_host_op_open",
	navigate: "ego_host_op_navigate",
	snapshot: "ego_host_op_snapshot",
	click: "ego_host_op_click",
	fill: "ego_host_op_fill",
	evaluate: "ego_host_op_evaluate",
	screenshot: "ego_host_op_screenshot",
	close: "ego_host_op_close",
	createWorkspace: "ego_host_op_create_workspace",
	listWorkspaces: "ego_host_op_list_workspaces",
	closeWorkspace: "ego_host_op_close_workspace",
};

/**
 * heredoc 은 여기서 끝난다 (FR-ENV-TOOL.14b Pending).
 *
 * 승인을 남기는 자리가 Rust 에 없다. 서비스가 승인 참조를 요구하지만 그 참조를 만드는 UI 가
 * 아직 없고, 웹뷰의 자기 신고만으로 임의 자바스크립트를 통과시키면 승인 요구가 빈 말이 된다.
 * 그래서 **어댑터에서 한 번, Rust 의 `ego_host_op_script` 에서 또 한 번** 거부한다.
 */
export const EGO_HOST_SCRIPT_REFUSAL =
	"approval-missing: script 는 Rust 쪽 승인 기록이 없어 웹뷰에서 거부한다 — 승인 UI 미구현 (FR-ENV-TOOL.14b)";

/** Rust 가 작업 연결의 프레임을 올려 보내는 이름. `ego_host_bridge.rs` 의 `FRAME_EVENT` 와 같다. */
export const EGO_HOST_FRAME_EVENT = "ego-host://frame";

export interface FramePayload {
	readonly session: number;
	readonly type?: string;
	readonly payload?: string;
	readonly error?: string;
	readonly error_code?: string;
}

type FrameHandler = (frame: FramePayload) => void;

/**
 * 세션별 프레임 수신자. 리스너는 **하나만** 둔다 — 세션마다 새로 등록하면 등록이 끝나기 전에
 * 도착한 프레임을 놓치고, 그 손실은 "CDP 응답이 안 온다"는 상한 초과로만 보인다.
 */
const frameHandlers = new Map<number, FrameHandler>();
let frameListener: Promise<UnlistenFn> | null = null;

/**
 * 프레임 하나를 제 세션으로. 리스너가 부르는 **유일한** 자리이며, 단위 테스트도 이것을 부른다 —
 * 테스트가 다른 문을 쓰면 실제로 도는 분배 규칙은 아무도 재지 않는다.
 */
export function dispatchEgoHostFrame(frame: FramePayload | undefined | null): void {
	if (!frame || typeof frame.session !== "number") return;
	frameHandlers.get(frame.session)?.(frame);
}

function ensureFrameListener(): Promise<UnlistenFn> {
	if (!frameListener) {
		frameListener = listen<FramePayload>(EGO_HOST_FRAME_EVENT, (event) =>
			dispatchEgoHostFrame(event.payload),
		);
	}
	return frameListener;
}

/** 테스트가 상태를 되돌리는 자리. 리스너는 앱 수명 동안 하나면 된다. */
export function resetEgoHostFrameListener(): void {
	frameHandlers.clear();
	frameListener = null;
}

interface EnsureResult {
	readonly socketPath?: string;
	readonly browserPid?: number | null;
	readonly adkDir?: string;
	readonly started?: boolean;
}

/** 감독자가 `{error, error_code}` 로 답한 것을 던지는 실패로 바꾼다. */
function throwIfShaped(value: unknown, what: string): Record<string, unknown> {
	const shape = (value ?? {}) as Record<string, unknown>;
	if (typeof shape.error === "string") {
		const error = new Error(`${what}: ${shape.error}`) as Error & { error_code?: string };
		if (typeof shape.error_code === "string") error.error_code = shape.error_code;
		throw error;
	}
	return shape;
}

/**
 * 어댑터가 보는 감독자 면 하나. 각 메서드가 정확히 어떤 명령으로 가는지가 이 파일의 전부다.
 *
 * @param call Tauri `invoke`. 테스트가 대역을 꽂는 자리다 — 웹뷰 밖(vitest)에는 IPC 가 없다.
 */
export function createIpcEgoHostApi(
	call: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = (command, args) =>
		invoke(command, args),
	subscribe: () => Promise<unknown> = ensureFrameListener,
): EgoHostApi {
	/**
	 * 감독자가 떠 있는가. `ensureDirs` 가 이것을 본다 — 어댑터는 감독자를 띄우기 **전에**
	 * 자리를 만들라고 부르는데, 그 시점에는 관리 통로가 아직 없다(실기에서 이 순서로 걸렸다).
	 * 그 네 자리는 데몬이 기동하며 만든다(`supervisord.mjs` 의 `hostDirs`).
	 */
	let supervisorUp = false;
	return {
		async startSupervisor(options: Record<string, unknown>) {
			const adkDir = String(options.adkDir ?? "");
			const result = await call<EnsureResult>("ego_host_ensure", { adkDir });
			supervisorUp = true;
			const socketPath = String(result?.socketPath ?? "");
			const browserPid = Number(result?.browserPid ?? 0);
			return {
				socketPath,
				browserPid,
				server: {
					/**
					 * 토큰은 **Rust 안에서만** 만들어진다 (S7).
					 *
					 * S6c 까지는 이 자리가 `ego_host_issue_token` 으로 나가면서 웹뷰가 고른 등급을
					 * 그대로 실어 보냈다. 그 문 하나로 웹뷰는 자기 판정을 건너뛴 등급을 스스로
					 * 만들 수 있었다. 이제 그 명령은 없고, 토큰은 `ego_host_op_*` 가 자기 이름이
					 * 정한 등급으로 발급한다. 어댑터가 이 문자열을 핸드셰이크로 나르지 않으므로
					 * 빈 값이 맞다 — 여기서 그럴듯한 값을 지어내면 그것이 토큰으로 읽힌다.
					 */
					issueToken: async (issue) => {
						if (issue.rpc === "script") throw new Error(EGO_HOST_SCRIPT_REFUSAL);
						return "";
					},
					operations: {
						cancel: async (id, cancelOptions) => {
							const value = throwIfShaped(
								await call("ego_host_op_cancel", {
									operationId: id,
									reason: (cancelOptions as { reason?: string } | undefined)?.reason ?? null,
								}),
								"cancelOperation",
							);
							return {
								changed: value.changed === true,
								status: String(value.status ?? "failed"),
								cleanup: value.cleanup ?? null,
							};
						},
						complete: async (id, completeOptions) => {
							const shape = (completeOptions ?? {}) as { status?: string; reason?: string };
							const value = throwIfShaped(
								await call("ego_host_op_complete", {
									operationId: id,
									status: shape.status ?? null,
									reason: shape.reason ?? null,
								}),
								"endOperation",
							);
							return {
								changed: value.changed === true,
								status: String(value.status ?? "failed"),
								cleanup: value.cleanup ?? null,
							};
						},
						/**
						 * 장부 목록은 IPC 를 지나면 비동기라 이 동기 자리에 담을 수 없다.
						 * 어댑터의 `stateOf` 하나만 이것을 쓰고, 서비스는 자기 장부로 상태를
						 * 판정한다(`EnvironmentToolService.stateOf`). 그래서 **비었다고 말한다** —
						 * 지어낸 상태를 돌려주면 그 거짓이 어딘가에서 완료로 읽힌다.
						 */
						list: () => [],
					},
				},
				browser: {
					/**
					 * Chromium 소멸 통지. 웹뷰에는 그 프로세스가 보이지 않고, 회수는 Rust 의
					 * lease 조정(S6b)이 맡는다. 어댑터는 이 통지가 없으면 다음 요청이 실패로
					 * 끝나는 것으로 같은 사실에 도달한다 — 여기서 없는 사건을 지어내지 않는다.
					 */
					on: () => {},
				},
				stop: async () => {
					supervisorUp = false;
					await call("ego_host_stop", {});
				},
			};
		},

		async connectSupervisor(options: Record<string, unknown>) {
			await subscribe();
			const rpc = String(options.rpc ?? "");
			if (rpc === "script") throw new Error(EGO_HOST_SCRIPT_REFUSAL);
			const command = EGO_HOST_OP_COMMAND[rpc];
			if (!command) {
				throw new Error(`effect-unknown: 효과가 고정된 명령이 없는 RPC 다: ${rpc || "(이름 없음)"}`);
			}
			// `token`·`grant` 를 보내지 않는다. 둘 다 Rust 가 명령 이름으로 정한다(S7).
			const session = await call<number>(command, {
				operationId: options.operationId ?? null,
				workspaceId: options.workspaceId ?? null,
				deadline: options.deadline ?? null,
			});
			const cdpHandlers = new Set<(raw: string) => void>();
			const closeHandlers = new Set<(error: Error) => void>();
			let closed = false;
			frameHandlers.set(session, (frame) => {
				if (frame.type === "cdp" && typeof frame.payload === "string") {
					for (const handler of cdpHandlers) handler(frame.payload);
					return;
				}
				if (frame.type === "closed" || frame.type === "fatal") {
					if (closed) return;
					closed = true;
					const error = new Error(frame.error ?? "감독자 연결이 닫혔다");
					for (const handler of closeHandlers) handler(error);
				}
			});
			return {
				async call(method: string, params: Record<string, unknown> = {}) {
					if (closed) return { error: "감독자 연결이 닫혔다", error_code: "EGO_HOST_DISCONNECTED" };
					try {
						return (await call<Record<string, unknown>>("ego_host_op_rpc", {
							session,
							method,
							params,
						})) as Record<string, unknown> & { error?: string; error_code?: string };
					} catch (error) {
						// 다리가 끊긴 것은 감독자의 거부와 다른 사실이다. 형식 있는 모양으로 옮겨
						// 어댑터가 `disconnected` 로 읽게 한다.
						return { error: String(error), error_code: "EGO_HOST_DISCONNECTED" };
					}
				},
				/**
				 * CDP 한 통. node 안에서는 동기 enqueue 였지만 IPC 는 비동기다.
				 * 벤더 런타임의 동기 계약(ABI 1)은 **런처 프로세스**에만 걸리고, 이 통로를 쓰는
				 * 것은 우리 어댑터의 `cdpChannel` 이다 — 그쪽은 자기 상한으로 응답을 기다린다.
				 */
				sendCdp(payload: string, sendOptions?: { operationId?: string | null }) {
					void call("ego_host_op_cdp", {
						session,
						payload,
						operationId: sendOptions?.operationId ?? null,
					}).catch(() => {
						/* 끊긴 연결은 close 통지가 알린다 */
					});
				},
				onCdp(handler: (raw: string) => void) {
					cdpHandlers.add(handler);
					return () => cdpHandlers.delete(handler);
				},
				onClose(handler: (error: Error) => void) {
					closeHandlers.add(handler);
					return () => closeHandlers.delete(handler);
				},
				close() {
					frameHandlers.delete(session);
					void call("ego_host_op_end", { session }).catch(() => {});
				},
			};
		},

		async reconcileLease(options: Record<string, unknown>) {
			const value = throwIfShaped(
				await call("ego_host_reconcile_lease", { adkDir: options.adkDir ?? null }),
				"reconcileLease",
			);
			return {
				status: String(value.status ?? "unreadable"),
				orphans: Number(value.orphans ?? 0),
				note: String(value.note ?? ""),
			};
		},

		/**
		 * 자리 만들기는 데몬이 기동할 때 이미 한다(`supervisord.mjs` 의 `hostDirs`).
		 * 그래도 부르는 이유는 `script` 경로가 작업 공간을 나중에 요구하기 때문이다.
		 */
		ensureDirs: async (dirs: readonly string[]) => {
			// 감독자 전이면 만들 통로가 없다. 데몬이 기동하며 같은 자리를 만들므로 여기서는
			// 아무 일도 하지 않는다 — 없는 통로에 대고 실패를 만들지 않는다.
			if (!supervisorUp) return;
			await call("ego_host_ensure_dirs", { dirs });
		},

		writeEnvFiles: (files) =>
			call<Record<string, unknown>>("ego_host_write_env_files", { files }).then((value) => {
				const written = throwIfShaped(value, "writeEnvFiles").written;
				return Array.isArray(written) ? written.map((entry) => String(entry)) : [];
			}),

		/**
		 * 이 면은 어댑터가 부르지 않는다(`waitForPidExit` 만 쓴다). 조용히 참을 돌려주면
		 * 그 거짓이 언젠가 "살아 있다"는 판정 근거가 되므로, 불리면 그 자리에서 말한다.
		 */
		pidAlive: () => {
			throw new Error("pidAlive 는 이 다리에서 재지 않는다 — 프로세스는 Rust 쪽 사실이다");
		},

		waitForPidExit: async (pid: number, timeoutMs?: number) => {
			const value = throwIfShaped(
				await call("ego_host_wait_pid_exit", { pid, timeoutMs: timeoutMs ?? 10_000 }),
				"waitForPidExit",
			);
			return value.exited === true;
		},

		/**
		 * heredoc 실행. 웹뷰에서는 **자식 프로세스가 뜨기 전에** 끝난다 (S7).
		 *
		 * 등급 판정만으로는 부족하다. 승인 참조는 웹뷰가 스스로 채우는 값이고 그것을 검증할
		 * 기록이 Rust 에 없다. Rust 에도 `ego_host_op_script` 가 같은 문구로 거부한다 —
		 * 두 겹 중 하나가 깨져도 다른 하나가 남는다.
		 */
		runEgoScript: async () => {
			throw new Error(EGO_HOST_SCRIPT_REFUSAL);
		},

		/** 벤더 SDK 자리는 node 쪽 사실이다. 어댑터는 이 값을 읽지 않는다. */
		DEFAULT_SDK_DIR: "",
	};
}

let cached: EgoHostApi | null = null;

/** 앱이 쓰는 하나. 어댑터가 `loadApi` 로 부른다. */
export function ipcEgoHostApi(): Promise<EgoHostApi> {
	if (!cached) cached = createIpcEgoHostApi();
	return Promise.resolve(cached);
}
