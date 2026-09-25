// @vitest-environment node
/**
 * FR-BGM.14 (#517) — sidecar가 EADDRINUSE에서 재시도 없이 즉시 exit(1)한다.
 *
 * 과거 동작(무한 재시도)은 실패한 sidecar를 좀비로 남겨, 기존 포트 점유자가
 * 죽는 순간 낡은 nonce로 포트를 승계해 BGM 고장을 자기영속시켰다. 이 테스트는
 * 점유된 포트에서 startYoutubeServer()가 process.exit(1)을 호출하는지 실소켓으로
 * 검증한다(구 코드는 exit를 호출하지 않으므로 이 테스트가 회귀를 잡는다).
 */
import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";

let blocker: Server | null = null;

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.resetModules();
	if (blocker) {
		await new Promise<void>((resolve) => {
			blocker?.close(() => resolve());
		});
		blocker = null;
	}
});

it("점유된 포트에서 exit(1)을 호출한다 — 재시도 루프 없음", async () => {
	// Since #716 the sidecar binds the loopback addresses only, and 127.0.0.1 is
	// the one whose failure is fatal. Block that exact address: holding the
	// wildcard instead does not collide on Windows (a specific-address bind
	// succeeds beside a wildcard holder), so the test only passed on Linux.
	blocker = createServer();
	await new Promise<void>((resolve) => {
		blocker?.listen(0, "127.0.0.1", resolve);
	});
	const address = blocker.address();
	if (address === null || typeof address === "string") {
		throw new Error("blocker did not expose a port");
	}
	vi.stubEnv("NAIA_BGM_PORT", String(address.port));

	const exitSpy = vi
		.spyOn(process, "exit")
		.mockImplementation(() => undefined as never);
	const stderrSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation(() => true);

	const { startYoutubeServer, YT_SERVER_PORT } = await import(
		"../../../../bgm-sidecar/src/youtube-server.ts"
	);
	expect(YT_SERVER_PORT).toBe(address.port);
	startYoutubeServer();

	await vi.waitFor(() => {
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
	expect(exitSpy).toHaveBeenCalledTimes(1);
	const stderrText = stderrSpy.mock.calls.map((call) => String(call[0])).join("");
	expect(stderrText).toContain("exiting so the shell can reclaim it");
});
