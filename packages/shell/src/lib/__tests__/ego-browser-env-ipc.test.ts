/**
 * #582 S6c — 감독자 면의 IPC 구현 (계약 4.2·4.8, 9절 S6c).
 *
 * 재는 것 셋.
 *  (1) 각 메서드가 **어느 명령을 어떤 인자로** 부르는가. 이름이나 인자가 어긋나면 Rust 는
 *      아무 일도 하지 않고, 그 침묵은 "감독자가 안 뜬다" 로만 보인다.
 *  (2) 감독자의 형식 있는 거부(`{error, error_code}`)가 뭉개지지 않고 그대로 오르는가.
 *  (3) 세션 프레임이 제 세션의 CDP·종료 처리로 가는가. 남의 세션 프레임은 가지 않는다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createIpcEgoHostApi,
	dispatchEgoHostFrame,
	EGO_HOST_OP_COMMAND,
	EGO_HOST_SCRIPT_REFUSAL,
	resetEgoHostFrameListener,
} from "../ego-browser-env-ipc";

interface Call {
	readonly command: string;
	readonly args: Record<string, unknown>;
}

/** 명령마다 답을 정하는 대역 `invoke`. 무엇이 불렸는지 순서대로 남긴다. */
function fakeInvoke(responses: Record<string, unknown> = {}) {
	const calls: Call[] = [];
	const call = vi.fn(async (command: string, args?: Record<string, unknown>) => {
		calls.push({ command, args: args ?? {} });
		const answer = responses[command];
		if (typeof answer === "function") return (answer as (a: Record<string, unknown>) => unknown)(args ?? {});
		return answer;
	});
	return { calls, call: call as unknown as <T>(c: string, a?: Record<string, unknown>) => Promise<T> };
}

const READY = { socketPath: "/run/user/1000/naia-ego-host-abc.sock", browserPid: 4242, started: true };

beforeEach(() => {
	resetEgoHostFrameListener();
});

describe("감독자 면의 IPC 구현", () => {
	it("startSupervisor 는 ego_host_ensure 로 ADK 를 넘기고 소켓·PID 를 받는다", async () => {
		const { call, calls } = fakeInvoke({ ego_host_ensure: READY });
		const api = createIpcEgoHostApi(call, async () => undefined);
		const supervisor = await api.startSupervisor({ adkDir: "/adk", platform: "linux" });

		expect(calls).toEqual([{ command: "ego_host_ensure", args: { adkDir: "/adk" } }]);
		expect(supervisor.socketPath).toBe(READY.socketPath);
		expect(supervisor.browserPid).toBe(4242);
	});

	it("웹뷰는 토큰을 만들지 못한다 — 발급 명령이 아예 없다 (S7 P0)", async () => {
		const { call, calls } = fakeInvoke({ ego_host_ensure: READY });
		const api = createIpcEgoHostApi(call, async () => undefined);
		const supervisor = await api.startSupervisor({ adkDir: "/adk" });

		// 조작한 등급을 실어 불러도 명령이 나가지 않는다. 토큰은 Rust 안에서만 만들어진다.
		const token = await supervisor.server.issueToken({
			rpc: "click",
			operationId: "op-1",
			workspaceId: "5",
			grant: { tier: "credential", approvalRef: "지어낸-승인" },
		});
		expect(token).toBe("");
		expect(calls.map((entry) => entry.command)).toEqual(["ego_host_ensure"]);
	});

	it("script 는 토큰 자리에서 먼저 끝난다 — 명령에 닿지 않는다", async () => {
		const { call, calls } = fakeInvoke({ ego_host_ensure: READY });
		const api = createIpcEgoHostApi(call, async () => undefined);
		const supervisor = await api.startSupervisor({ adkDir: "/adk" });
		await expect(
			supervisor.server.issueToken({ rpc: "script", operationId: "op-1" }),
		).rejects.toThrow(/approval-missing/);
		expect(calls.map((entry) => entry.command)).toEqual(["ego_host_ensure"]);
	});

	it("작업 취소·종결은 메서드가 고정된 명령으로 간다", async () => {
		const { call, calls } = fakeInvoke({
			ego_host_ensure: READY,
			ego_host_op_cancel: { changed: true, status: "cancelled", cleanup: { sessions: ["s1"] } },
			ego_host_op_complete: { changed: true, status: "completed", cleanup: null },
		});
		const api = createIpcEgoHostApi(call, async () => undefined);
		const supervisor = await api.startSupervisor({ adkDir: "/adk" });

		const cancelled = await supervisor.server.operations.cancel("op-9");
		expect(cancelled).toEqual({ changed: true, status: "cancelled", cleanup: { sessions: ["s1"] } });
		expect(calls[1]).toEqual({
			command: "ego_host_op_cancel",
			args: { operationId: "op-9", reason: null },
		});

		await supervisor.server.operations.complete("op-9", { status: "completed" });
		expect(calls[2]).toEqual({
			command: "ego_host_op_complete",
			args: { operationId: "op-9", status: "completed", reason: null },
		});
	});

	it("연결은 RPC 이름이 고른 명령으로 서고, 등급·토큰을 싣지 않는다 (S7 P0)", async () => {
		const { call, calls } = fakeInvoke({
			ego_host_op_click: 7,
			ego_host_op_rpc: { tabs: [] },
			ego_host_op_cdp: null,
			ego_host_op_end: null,
		});
		const api = createIpcEgoHostApi(call, async () => undefined);
		const client = await api.connectSupervisor({
			socketPath: READY.socketPath,
			token: "지어낸-토큰",
			grant: { tier: "credential", approvalRef: "지어낸-승인" },
			rpc: "click",
			operationId: "op-2",
			workspaceId: "3",
			deadline: 12_000,
		});
		expect(calls[0]).toEqual({
			command: "ego_host_op_click",
			args: { operationId: "op-2", workspaceId: "3", deadline: 12_000 },
		});

		await client.call("listTabs", { id: 3 });
		expect(calls[1]).toEqual({
			command: "ego_host_op_rpc",
			args: { session: 7, method: "listTabs", params: { id: 3 } },
		});

		client.sendCdp('{"id":1,"method":"Page.enable"}', { operationId: "op-2" });
		await Promise.resolve();
		expect(calls[2]).toEqual({
			command: "ego_host_op_cdp",
			args: { session: 7, payload: '{"id":1,"method":"Page.enable"}', operationId: "op-2" },
		});

		client.close();
		await Promise.resolve();
		expect(calls[3]).toEqual({ command: "ego_host_op_end", args: { session: 7 } });
	});

	it("효과가 고정되지 않은 RPC 로는 연결이 서지 않는다 — 명령이 없다", async () => {
		const { call, calls } = fakeInvoke({});
		const api = createIpcEgoHostApi(call, async () => undefined);
		await expect(api.connectSupervisor({ rpc: "script", token: "t" })).rejects.toThrow(
			/approval-missing/,
		);
		await expect(api.connectSupervisor({ rpc: "issueToken", token: "t" })).rejects.toThrow(
			/effect-unknown/,
		);
		await expect(api.connectSupervisor({ token: "t" })).rejects.toThrow(/effect-unknown/);
		expect(calls).toHaveLength(0);
	});

	it("명령표는 서비스의 등급표와 같은 이름만 담는다", () => {
		// `script` 는 여기 없다. 있으면 승인 없는 heredoc 이 통과할 문이 하나 생긴다.
		expect(Object.keys(EGO_HOST_OP_COMMAND).sort()).toEqual(
			[
				"click",
				"close",
				"closeWorkspace",
				"createWorkspace",
				"evaluate",
				"fill",
				"listWorkspaces",
				"navigate",
				"open",
				"screenshot",
				"snapshot",
			].sort(),
		);
		for (const [rpc, command] of Object.entries(EGO_HOST_OP_COMMAND)) {
			expect(command.startsWith("ego_host_op_")).toBe(true);
			expect(rpc).not.toBe("script");
		}
	});

	it("다리가 끊기면 형식 있는 disconnected 로 옮긴다 — 던져서 상한을 채우지 않는다", async () => {
		const { call } = fakeInvoke({
			ego_host_op_snapshot: 8,
			ego_host_op_rpc: () => {
				throw new Error("그런 세션이 없다: 8");
			},
		});
		const api = createIpcEgoHostApi(call, async () => undefined);
		const client = await api.connectSupervisor({ rpc: "snapshot", token: "t-2" });
		const result = await client.call("snapshot", {});
		expect(result.error_code).toBe("EGO_HOST_DISCONNECTED");
		expect(String(result.error)).toContain("그런 세션이 없다");
	});

	it("세션 프레임은 제 세션으로만 간다", async () => {
		const { call } = fakeInvoke({ ego_host_op_snapshot: 11 });
		const api = createIpcEgoHostApi(call, async () => undefined);
		const client = await api.connectSupervisor({ rpc: "snapshot", token: "t-3" });

		const seen: string[] = [];
		const closes: string[] = [];
		client.onCdp((raw) => seen.push(raw));
		client.onClose((error) => closes.push(error.message));

		dispatchEgoHostFrame({ session: 11, type: "cdp", payload: '{"id":1,"result":{}}' });
		dispatchEgoHostFrame({ session: 99, type: "cdp", payload: '{"id":2,"result":{}}' });
		expect(seen).toEqual(['{"id":1,"result":{}}']);

		dispatchEgoHostFrame({ session: 11, type: "closed" });
		dispatchEgoHostFrame({ session: 11, type: "closed" });
		expect(closes).toHaveLength(1);

		// 닫힌 뒤의 RPC 는 왕복하지 않고 그 자리에서 형식 있는 실패다.
		const after = await client.call("snapshot", {});
		expect(after.error_code).toBe("EGO_HOST_DISCONNECTED");
	});

	it("자리 만들기·`.env` 쓰기·lease 조정은 메서드가 고정된 명령으로 간다", async () => {
		const { call, calls } = fakeInvoke({
			ego_host_ensure: READY,
			ego_host_ensure_dirs: {},
			ego_host_write_env_files: { written: ["/adk/ego-host/agent-workspace/.env"] },
			ego_host_wait_pid_exit: { exited: true },
			ego_host_reconcile_lease: { status: "no-lease", orphans: 0, note: "" },
		});
		const api = createIpcEgoHostApi(call, async () => undefined);

		// 감독자 전에는 자리를 만들 통로가 없다. 데몬이 기동하며 같은 자리를 만들므로
		// 여기서는 아무 명령도 나가지 않는다 — 없는 통로에 대고 실패를 만들지 않는다.
		await api.ensureDirs(["/adk/ego-host"]);
		expect(calls).toHaveLength(0);

		await api.startSupervisor({ adkDir: "/adk" });
		await api.ensureDirs(["/adk/ego-host"]);
		expect(calls[1]).toEqual({
			command: "ego_host_ensure_dirs",
			args: { dirs: ["/adk/ego-host"] },
		});

		const written = await api.writeEnvFiles([{ path: "/adk/ego-host/agent-workspace/.env", values: { HOME: "/adk" } }]);
		expect(written).toEqual(["/adk/ego-host/agent-workspace/.env"]);

		expect(await api.waitForPidExit(4242, 1_000)).toBe(true);
		expect(await api.reconcileLease({ adkDir: "/adk" })).toEqual({
			status: "no-lease",
			orphans: 0,
			note: "",
		});

		// heredoc 은 명령에 닿지 않는다. 자식 프로세스가 뜨기 전에 끝난다.
		const before = calls.length;
		await expect(api.runEgoScript({ code: "console.log(1)" })).rejects.toThrow(
			EGO_HOST_SCRIPT_REFUSAL,
		);
		expect(calls).toHaveLength(before);
	});

	it("이 다리가 재지 않는 것은 재지 않는다고 말한다", async () => {
		const { call } = fakeInvoke({});
		const api = createIpcEgoHostApi(call, async () => undefined);
		// 프로세스 생존은 Rust 쪽 사실이다. 참을 지어내면 그 거짓이 판정 근거가 된다.
		expect(() => api.pidAlive(1)).toThrow(/재지 않는다/);
	});
});
