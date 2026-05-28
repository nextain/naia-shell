// #337 Phase 6a — unit tests for auth-status-store. Mocks agent-ipc to drive
// `agentAuthQuery` resolutions and `onAgentAuthChanged` events; asserts the
// tri-state lifecycle (checking → logged_in/logged_out) and defensive
// fallbacks (query throws, slow query warning, mode filtering, unsubscribe).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthMode } from "../agent-ipc.js";

// ---------------------------------------------------------------------------
// Mocks. agent-ipc is the only real dependency we exercise; the Logger is
// mocked so we can assert on the slow-query warning + IPC-failure warning
// paths.

const mockAgentAuthQuery = vi.fn();
const mockResolveAuthMode = vi.fn();
const onAgentAuthChangedListeners = new Set<
	(event: { mode: AuthMode; loggedIn: boolean }) => void
>();
const mockOnAgentAuthChanged = vi.fn(
	(listener: (event: { mode: AuthMode; loggedIn: boolean }) => void) => {
		onAgentAuthChangedListeners.add(listener);
		return () => {
			onAgentAuthChangedListeners.delete(listener);
		};
	},
);

vi.mock("../agent-ipc.js", () => ({
	agentAuthQuery: (...args: unknown[]) =>
		(mockAgentAuthQuery as unknown as (...a: unknown[]) => unknown)(...args),
	onAgentAuthChanged: (
		listener: (event: { mode: AuthMode; loggedIn: boolean }) => void,
	) => mockOnAgentAuthChanged(listener),
	resolveAuthMode: () =>
		(mockResolveAuthMode as unknown as () => AuthMode)(),
}));

const loggerWarn = vi.fn();
vi.mock("../logger.js", () => ({
	Logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: (...args: unknown[]) => loggerWarn(...args),
		error: vi.fn(),
	},
}));

// ---------------------------------------------------------------------------

import {
	getMode,
	startAuthStatusTracking,
	type AuthStatusSnapshot,
} from "../auth-status-store.js";

describe("auth-status-store", () => {
	beforeEach(() => {
		mockAgentAuthQuery.mockReset();
		mockResolveAuthMode.mockReset();
		mockResolveAuthMode.mockReturnValue("prod");
		mockOnAgentAuthChanged.mockClear();
		onAgentAuthChangedListeners.clear();
		loggerWarn.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("getMode()", () => {
		it("returns the mode that resolveAuthMode reports", () => {
			mockResolveAuthMode.mockReturnValue("dev");
			expect(getMode()).toBe("dev");
			mockResolveAuthMode.mockReturnValue("prod");
			expect(getMode()).toBe("prod");
		});
	});

	describe("startAuthStatusTracking", () => {
		it("emits 'checking' synchronously before agentAuthQuery resolves", () => {
			let resolveFn: (
				v: { loggedIn: boolean; userId?: string },
			) => void = () => {};
			mockAgentAuthQuery.mockReturnValue(
				new Promise<{ loggedIn: boolean; userId?: string }>((r) => {
					resolveFn = r;
				}),
			);

			const snapshots: AuthStatusSnapshot[] = [];
			startAuthStatusTracking((s) => snapshots.push(s));

			// First emission must be synchronous — happens before this line.
			expect(snapshots).toHaveLength(1);
			expect(snapshots[0]).toEqual({ status: "checking", mode: "prod" });

			// Cleanup — release the dangling promise so it doesn't leak.
			resolveFn({ loggedIn: false });
		});

		it("emits 'logged_in' with userId after agentAuthQuery resolves loggedIn=true", async () => {
			mockAgentAuthQuery.mockResolvedValue({
				loggedIn: true,
				userId: "naia_x",
				expiresAt: 1_800_000_000,
			});

			const snapshots: AuthStatusSnapshot[] = [];
			startAuthStatusTracking((s) => snapshots.push(s));

			// Yield to microtasks so the .then() handler runs.
			await Promise.resolve();
			await Promise.resolve();

			expect(snapshots).toEqual([
				{ status: "checking", mode: "prod" },
				{
					status: "logged_in",
					mode: "prod",
					userId: "naia_x",
					expiresAt: 1_800_000_000,
				},
			]);
		});

		it("emits 'logged_out' after agentAuthQuery resolves loggedIn=false", async () => {
			mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });

			const snapshots: AuthStatusSnapshot[] = [];
			startAuthStatusTracking((s) => snapshots.push(s));

			await Promise.resolve();
			await Promise.resolve();

			expect(snapshots).toEqual([
				{ status: "checking", mode: "prod" },
				{ status: "logged_out", mode: "prod" },
			]);
		});

		it("defaults to 'logged_out' when agentAuthQuery throws", async () => {
			mockAgentAuthQuery.mockRejectedValue(new Error("agent dead"));

			const snapshots: AuthStatusSnapshot[] = [];
			startAuthStatusTracking((s) => snapshots.push(s));

			// Flush microtasks for the .catch() handler.
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(snapshots).toEqual([
				{ status: "checking", mode: "prod" },
				{ status: "logged_out", mode: "prod" },
			]);
			expect(loggerWarn).toHaveBeenCalled();
			const warnArgs = loggerWarn.mock.calls[0];
			expect(warnArgs[0]).toBe("auth-status-store");
			expect(String(warnArgs[1])).toMatch(/agentAuthQuery failed/);
		});

		it("flips status on auth_changed event for the SAME mode", async () => {
			mockResolveAuthMode.mockReturnValue("dev");
			mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });

			const snapshots: AuthStatusSnapshot[] = [];
			startAuthStatusTracking((s) => snapshots.push(s));

			await Promise.resolve();
			await Promise.resolve();

			expect(snapshots.length).toBeGreaterThanOrEqual(2);
			expect(snapshots[snapshots.length - 1]).toEqual({ status: "logged_out", mode: "dev" });

			// Simulate the agent pushing auth_changed for the dev mode.
			for (const listener of onAgentAuthChangedListeners) {
				listener({ mode: "dev", loggedIn: true });
			}
			expect(snapshots[snapshots.length - 1]).toEqual({ status: "logged_in", mode: "dev" });

			for (const listener of onAgentAuthChangedListeners) {
				listener({ mode: "dev", loggedIn: false });
			}
			expect(snapshots[snapshots.length - 1]).toEqual({ status: "logged_out", mode: "dev" });
		});

		it("ignores auth_changed events for OTHER modes", async () => {
			mockResolveAuthMode.mockReturnValue("dev");
			mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });

			const snapshots: AuthStatusSnapshot[] = [];
			startAuthStatusTracking((s) => snapshots.push(s));

			await Promise.resolve();
			await Promise.resolve();
			const lengthBefore = snapshots.length;

			// Push an event for the prod mode — must NOT affect dev tracker.
			for (const listener of onAgentAuthChangedListeners) {
				listener({ mode: "prod", loggedIn: true });
			}
			expect(snapshots).toHaveLength(lengthBefore);
		});

		it("unsubscribe stops further emits (no leaking listeners)", async () => {
			mockAgentAuthQuery.mockResolvedValue({ loggedIn: false });

			const snapshots: AuthStatusSnapshot[] = [];
			const unsub = startAuthStatusTracking((s) => snapshots.push(s));

			await Promise.resolve();
			await Promise.resolve();
			const lengthAfterSettle = snapshots.length;

			unsub();
			// After unsubscribe, the tracker must drop matching events on the floor.
			for (const listener of onAgentAuthChangedListeners) {
				listener({ mode: "prod", loggedIn: true });
			}
			expect(snapshots).toHaveLength(lengthAfterSettle);
		});

		it("does not emit anything after unsubscribe even if query was still pending", async () => {
			let resolveFn: (
				v: { loggedIn: boolean },
			) => void = () => {};
			mockAgentAuthQuery.mockReturnValue(
				new Promise<{ loggedIn: boolean }>((r) => {
					resolveFn = r;
				}),
			);

			const snapshots: AuthStatusSnapshot[] = [];
			const unsub = startAuthStatusTracking((s) => snapshots.push(s));

			// Synchronous "checking" emit landed.
			expect(snapshots).toHaveLength(1);

			unsub();
			// Now resolve the still-pending query — must be ignored.
			resolveFn({ loggedIn: true });
			await Promise.resolve();
			await Promise.resolve();

			expect(snapshots).toHaveLength(1);
		});

		it("logs a warning when agentAuthQuery exceeds 500ms (slow path)", async () => {
			// Use fake timers so we can deterministically advance "elapsed" without
			// real wall-clock sleep. We resolve the promise after a 700ms jump.
			vi.useFakeTimers();
			const startWall = Date.now();
			vi.setSystemTime(new Date(startWall));

			let resolveFn: (
				v: { loggedIn: boolean },
			) => void = () => {};
			mockAgentAuthQuery.mockReturnValue(
				new Promise<{ loggedIn: boolean }>((r) => {
					resolveFn = r;
				}),
			);

			const snapshots: AuthStatusSnapshot[] = [];
			startAuthStatusTracking((s) => snapshots.push(s));

			// Advance Date.now() past the 500ms SLA threshold.
			vi.setSystemTime(new Date(startWall + 700));

			resolveFn({ loggedIn: true });
			// Flush the .then() handler with real microtasks.
			await Promise.resolve();
			await Promise.resolve();

			// Slow-query warning must be present in the logger spy.
			const slowWarning = loggerWarn.mock.calls.find((call) =>
				String(call[1]).includes("exceeded SLA threshold"),
			);
			expect(slowWarning).toBeDefined();
		});
	});
});
