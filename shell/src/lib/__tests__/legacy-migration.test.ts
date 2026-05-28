// #337 Phase 8 — unit tests for legacy-migration.ts.
//
// Strategy: mock the three external collaborators (agent-ipc, config,
// secure-store) and drive the migration policy through its branches:
//   (a) no legacy key
//   (b) legacy key + agent already logged in   → silent purge
//   (c) legacy key + agent not logged in + ok  → migrate + purge
//   (d) legacy key + agent not logged in + nack → hard-fail, no purge
//   (e) legacy key + agent not logged in + timeout → hard-fail, no purge
//   (f) listener unsubscribe / concurrent / userId propagation
//
// Logger is mocked because the real one bridges to a Tauri invoke we don't
// want firing during tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentAuthQuery = vi.fn();
const mockAgentAuthLegacyMigrate = vi.fn();
const mockResolveAuthMode = vi.fn();
const mockGetNaiaKeySecure = vi.fn();
const mockLoadConfig = vi.fn();
const mockDeleteSecretKey = vi.fn();

vi.mock("../agent-ipc.js", () => ({
	agentAuthQuery: (...args: unknown[]) =>
		(mockAgentAuthQuery as unknown as (...a: unknown[]) => unknown)(...args),
	agentAuthLegacyMigrate: (...args: unknown[]) =>
		(mockAgentAuthLegacyMigrate as unknown as (...a: unknown[]) => unknown)(
			...args,
		),
	resolveAuthMode: () =>
		(mockResolveAuthMode as unknown as () => unknown)(),
}));

vi.mock("../config.js", () => ({
	getNaiaKeySecure: (...args: unknown[]) =>
		(mockGetNaiaKeySecure as unknown as (...a: unknown[]) => unknown)(...args),
	loadConfig: (...args: unknown[]) =>
		(mockLoadConfig as unknown as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("../secure-store.js", () => ({
	deleteSecretKey: (...args: unknown[]) =>
		(mockDeleteSecretKey as unknown as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("../logger.js", () => ({
	Logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import {
	__resetLegacyMigrationForTest,
	onLegacyMigrationFailed,
	runLegacyMigration,
} from "../legacy-migration.js";

describe("runLegacyMigration", () => {
	beforeEach(() => {
		mockAgentAuthQuery.mockReset();
		mockAgentAuthLegacyMigrate.mockReset();
		mockResolveAuthMode.mockReset();
		mockResolveAuthMode.mockReturnValue("prod");
		mockGetNaiaKeySecure.mockReset();
		mockLoadConfig.mockReset();
		mockLoadConfig.mockReturnValue(null);
		mockDeleteSecretKey.mockReset();
		mockDeleteSecretKey.mockResolvedValue(undefined);
		__resetLegacyMigrationForTest();
	});

	afterEach(() => {
		vi.useRealTimers();
		__resetLegacyMigrationForTest();
	});

	it("(1) no legacy key → returns no_legacy_key without touching the agent", async () => {
		mockGetNaiaKeySecure.mockResolvedValue(undefined);

		const result = await runLegacyMigration();

		expect(result).toEqual({ kind: "no_legacy_key" });
		expect(mockAgentAuthQuery).not.toHaveBeenCalled();
		expect(mockAgentAuthLegacyMigrate).not.toHaveBeenCalled();
		expect(mockDeleteSecretKey).not.toHaveBeenCalled();
	});

	it("(2) legacy key + agent already logged in → purges naiaKey + apiKey, no migrate", async () => {
		mockGetNaiaKeySecure.mockResolvedValue("gw-legacy-abc");
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: true, userId: "naia_x" });

		const result = await runLegacyMigration();

		expect(result).toEqual({ kind: "agent_already_logged_in", purged: true });
		expect(mockAgentAuthQuery).toHaveBeenCalledWith("prod");
		expect(mockAgentAuthLegacyMigrate).not.toHaveBeenCalled();
		expect(mockDeleteSecretKey).toHaveBeenCalledWith("naiaKey");
		expect(mockDeleteSecretKey).toHaveBeenCalledWith("apiKey");
	});

	it("(3) legacy key + agent not logged in + migrate ok → migrated + both deleted", async () => {
		mockGetNaiaKeySecure.mockResolvedValue("gw-legacy-abc");
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValue({ ok: true });

		const result = await runLegacyMigration();

		expect(result).toEqual({ kind: "migrated", mode: "prod" });
		expect(mockAgentAuthLegacyMigrate).toHaveBeenCalledTimes(1);
		expect(mockAgentAuthLegacyMigrate).toHaveBeenCalledWith({
			mode: "prod",
			naiaKey: "gw-legacy-abc",
		});
		expect(mockDeleteSecretKey).toHaveBeenCalledWith("naiaKey");
		expect(mockDeleteSecretKey).toHaveBeenCalledWith("apiKey");
	});

	it("(4) legacy key + agent not logged in + ok:false → failed, no delete, listener fires", async () => {
		mockGetNaiaKeySecure.mockResolvedValue("gw-legacy-abc");
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValue({
			ok: false,
			reason: "disk_full",
		});

		const failures: string[] = [];
		onLegacyMigrationFailed((reason) => failures.push(reason));

		const result = await runLegacyMigration();

		expect(result).toEqual({ kind: "failed", reason: "disk_full" });
		expect(mockDeleteSecretKey).not.toHaveBeenCalled();
		expect(failures).toEqual(["disk_full"]);
	});

	it("(5) legacy key + agent not logged in + IPC times out → failed, no delete, listener fires", async () => {
		mockGetNaiaKeySecure.mockResolvedValue("gw-legacy-abc");
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		// Never resolve — the 5 s timeout in legacy-migration must trip.
		mockAgentAuthLegacyMigrate.mockReturnValue(new Promise(() => {}));

		const failures: string[] = [];
		onLegacyMigrationFailed((reason) => failures.push(reason));

		vi.useFakeTimers();
		const resultPromise = runLegacyMigration();
		// Let the (1) getNaiaKey + (2) agentAuthQuery microtasks resolve so
		// the migrate call has actually been issued by the time we advance
		// the timer past the 5 s threshold.
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(5_001);

		const result = await resultPromise;

		expect(result.kind).toBe("failed");
		if (result.kind === "failed") {
			expect(result.reason).toMatch(/timeout/i);
		}
		expect(mockDeleteSecretKey).not.toHaveBeenCalled();
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatch(/timeout/i);
	});

	it("(6) unsubscribe stops further failure listener calls", async () => {
		mockGetNaiaKeySecure.mockResolvedValue("gw-legacy-abc");
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValue({
			ok: false,
			reason: "boom",
		});

		const calls: string[] = [];
		const unsub = onLegacyMigrationFailed((reason) => calls.push(reason));
		unsub();

		await runLegacyMigration();
		expect(calls).toEqual([]);
	});

	it("(7) concurrent calls return the same result (single-flight)", async () => {
		mockGetNaiaKeySecure.mockResolvedValue("gw-legacy-abc");
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: true });

		const [a, b, c] = await Promise.all([
			runLegacyMigration(),
			runLegacyMigration(),
			runLegacyMigration(),
		]);

		expect(a).toEqual(b);
		expect(b).toEqual(c);
		expect(a.kind).toBe("agent_already_logged_in");
		// The agent must have been queried only once — concurrent callers join
		// the same in-flight promise.
		expect(mockAgentAuthQuery).toHaveBeenCalledTimes(1);
	});

	it("(7b) second call after successful migration sees no_legacy_key (state reset by purge)", async () => {
		mockGetNaiaKeySecure.mockResolvedValueOnce("gw-legacy-abc");
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValue({ ok: true });

		const first = await runLegacyMigration();
		expect(first.kind).toBe("migrated");

		// Reset module-level promise cache + simulate the slot being gone (the
		// real deleteSecretKey would have removed it).
		__resetLegacyMigrationForTest();
		mockGetNaiaKeySecure.mockResolvedValueOnce(undefined);

		const second = await runLegacyMigration();
		expect(second.kind).toBe("no_legacy_key");
	});

	it("(8) userId from localStorage AppConfig propagated to agent IPC", async () => {
		mockGetNaiaKeySecure.mockResolvedValue("gw-legacy-abc");
		mockLoadConfig.mockReturnValue({ naiaUserId: "naia_persistent_user" });
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValue({ ok: true });

		const result = await runLegacyMigration();

		expect(result.kind).toBe("migrated");
		expect(mockAgentAuthLegacyMigrate).toHaveBeenCalledWith({
			mode: "prod",
			naiaKey: "gw-legacy-abc",
			userId: "naia_persistent_user",
		});
	});

	it("(8b) empty/missing naiaUserId in AppConfig → userId omitted from IPC", async () => {
		mockGetNaiaKeySecure.mockResolvedValue("gw-legacy-abc");
		mockLoadConfig.mockReturnValue({ naiaUserId: "" });
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValue({ ok: true });

		await runLegacyMigration();

		const callArgs = mockAgentAuthLegacyMigrate.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(callArgs).not.toHaveProperty("userId");
	});

	it("mode resolves dev vs prod independently", async () => {
		mockResolveAuthMode.mockReturnValue("dev");
		mockGetNaiaKeySecure.mockResolvedValue("gw-legacy-abc");
		mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });
		mockAgentAuthLegacyMigrate.mockResolvedValue({ ok: true });

		const result = await runLegacyMigration();
		expect(result).toEqual({ kind: "migrated", mode: "dev" });
		expect(mockAgentAuthQuery).toHaveBeenCalledWith("dev");
		expect(mockAgentAuthLegacyMigrate).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "dev" }),
		);
	});

	it("agentAuthQuery throw → treats as not logged in and attempts migrate", async () => {
		mockGetNaiaKeySecure.mockResolvedValue("gw-legacy-abc");
		mockAgentAuthQuery.mockRejectedValue(new Error("agent dead"));
		mockAgentAuthLegacyMigrate.mockResolvedValue({ ok: true });

		const result = await runLegacyMigration();
		expect(result.kind).toBe("migrated");
		expect(mockAgentAuthLegacyMigrate).toHaveBeenCalledTimes(1);
	});

	it("getNaiaKeySecure throw → no_legacy_key (defensive)", async () => {
		mockGetNaiaKeySecure.mockRejectedValue(new Error("secure store boom"));

		const result = await runLegacyMigration();
		expect(result).toEqual({ kind: "no_legacy_key" });
		expect(mockAgentAuthQuery).not.toHaveBeenCalled();
	});
});
