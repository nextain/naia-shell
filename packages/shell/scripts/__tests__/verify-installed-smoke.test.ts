import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectInstalledSession } from "../verify-installed-smoke.mjs";

const RESOURCE_DIR = resolve("installed", "naia");
const BUNDLED_NODE = resolve(RESOURCE_DIR, "node");
const OUTSIDE_NODE = resolve("installed", "node");
const session = (lines: string[]) =>
	[
		`[100] [Naia] node = ${OUTSIDE_NODE}`,
		"[101] [Naia] === Session started ===",
		...lines,
	].join("\n");

describe("installed smoke session predicate (FR-INSTALL.4·5)", () => {
	it("마지막 session 이후 handshake + node 2줄 모두 resource dir 하위면 green", () => {
		const log = session([
			`[102] [Naia] node = ${BUNDLED_NODE}`,
			`[103] [Naia] node = ${BUNDLED_NODE}`,
			"[104] [Naia] agent-core gRPC @ 127.0.0.1:12345",
		]);
		expect(inspectInstalledSession(log, RESOURCE_DIR).ok).toBe(true);
	});

	it("node 줄 0개는 공허참이 아니라 red", () => {
		const result = inspectInstalledSession(
			session(["[104] [Naia] agent-core gRPC @ 127.0.0.1:12345"]),
			RESOURCE_DIR,
		);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/0개/);
	});

	it("기존 누적 로그만 있고 새 session이 없으면 red", () => {
		const log = session([
			`[102] [Naia] node = ${BUNDLED_NODE}`,
			`[103] [Naia] node = ${BUNDLED_NODE}`,
			"[104] [Naia] agent-core gRPC @ 127.0.0.1:12345",
		]);
		expect(inspectInstalledSession(log, RESOURCE_DIR, 1)).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/새 session/),
		});
	});

	it("둘 중 하나라도 resource dir 밖이면 red", () => {
		const result = inspectInstalledSession(
			session([
				`[102] [Naia] node = ${BUNDLED_NODE}`,
				`[103] [Naia] node = ${OUTSIDE_NODE}`,
				"[104] [Naia] agent-core gRPC @ 127.0.0.1:12345",
			]),
			RESOURCE_DIR,
		);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/번들 밖/);
	});
});
