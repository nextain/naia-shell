// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WEB_REMOTE_KEY_STORAGE_KEY } from "../web-runtime/web-auth";
import { createMemoryWebFs, setWebFsForTests } from "../web-runtime/web-fs";
import {
	KIOSK_VISIT_ACTIVE_SESSION_KEY,
	KIOSK_VISIT_IDLE_TIMEOUT_MS,
	KIOSK_VISIT_LAST_ACTIVE_KEY,
	clearKioskVisitActivity,
	getKioskIdleTimeoutMs,
	isKioskVisitExpired,
	recordKioskVisitActivity,
	resetKioskVisit,
	shouldResetKioskVisitOnEnter,
} from "./entry";

const idleOverrideHolder = globalThis as {
	__NAIA_KIOSK_IDLE_TIMEOUT_MS__?: unknown;
};

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	idleOverrideHolder.__NAIA_KIOSK_IDLE_TIMEOUT_MS__ = undefined;
	setWebFsForTests(null);
});
afterEach(() => {
	idleOverrideHolder.__NAIA_KIOSK_IDLE_TIMEOUT_MS__ = undefined;
	setWebFsForTests(null);
});

it("waits for cancellation, memory reset and OPFS conversation cleanup before new session and reload while preserving naia-remote-key", async () => {
	const fs = createMemoryWebFs();
	await fs.writeBytes(
		"naia-adk/conversations/chat-prev.jsonl",
		'{"role":"user","content":"이전 질문"}\n',
	);
	await fs.writeBytes(
		"naia-adk/conversations-guest/chat-guest.jsonl",
		'{"role":"user","content":"게스트 질문"}\n',
	);
	await fs.writeBytes(
		"naia-adk/naia-settings/conversations-guest/chat-settings.jsonl",
		'{"role":"user","content":"설정 질문"}\n',
	);
	setWebFsForTests(fs);
	localStorage.setItem(WEB_REMOTE_KEY_STORAGE_KEY, "test-kiosk-demo-key");
	recordKioskVisitActivity(1_000);

	const order: string[] = [];
	let release!: () => void;
	const pending = resetKioskVisit({
		cancel: async () => {
			order.push("cancel");
		},
		resetMemory: () =>
			new Promise<void>((resolve) => {
				release = resolve;
				order.push("memory");
			}),
		newConversation: () => {
			order.push("new");
		},
		reload: () => {
			order.push("reload");
		},
	});
	await vi.waitFor(() => expect(order).toEqual(["cancel", "memory"]));
	release();
	await pending;
	expect(order).toEqual(["cancel", "memory", "new", "reload"]);
	expect(await fs.exists("naia-adk/conversations/chat-prev.jsonl")).toBe(false);
	expect(await fs.exists("naia-adk/conversations-guest/chat-guest.jsonl")).toBe(
		false,
	);
	expect(
		await fs.exists(
			"naia-adk/naia-settings/conversations-guest/chat-settings.jsonl",
		),
	).toBe(false);
	expect(localStorage.getItem(WEB_REMOTE_KEY_STORAGE_KEY)).toBe(
		"test-kiosk-demo-key",
	);
	expect(localStorage.getItem(KIOSK_VISIT_LAST_ACTIVE_KEY)).toBeNull();
	expect(sessionStorage.getItem(KIOSK_VISIT_ACTIVE_SESSION_KEY)).toBeNull();
});
it("does not discard the conversation or reload when memory reset fails", async () => {
	const next = vi.fn();
	const reload = vi.fn();
	await expect(
		resetKioskVisit({
			cancel: vi.fn(),
			resetMemory: async () => {
				throw Error("storage");
			},
			newConversation: next,
			reload,
		}),
	).rejects.toThrow("storage");
	expect(next).not.toHaveBeenCalled();
	expect(reload).not.toHaveBeenCalled();
});
it("distinguishes active same-tab reload from new tab or idle-expired visit", () => {
	clearKioskVisitActivity();
	expect(shouldResetKioskVisitOnEnter(10_000, 60_000)).toBe(false);

	// Active visit in same tab within timeout -> preserve across F5 reload
	recordKioskVisitActivity(10_000);
	expect(isKioskVisitExpired(30_000, 60_000)).toBe(false);
	expect(shouldResetKioskVisitOnEnter(30_000, 60_000)).toBe(false);

	// Idle timeout elapsed -> reset next visit
	expect(isKioskVisitExpired(75_000, 60_000)).toBe(true);
	expect(shouldResetKioskVisitOnEnter(75_000, 60_000)).toBe(true);

	// Previous visitor closed tab without pressing reset (sessionStorage cleared, localStorage has lastActiveAt) -> reset
	recordKioskVisitActivity(50_000);
	sessionStorage.removeItem(KIOSK_VISIT_ACTIVE_SESSION_KEY);
	expect(shouldResetKioskVisitOnEnter(55_000, 60_000)).toBe(true);
});

it("keeps the visit on same-tab reload within the idle timeout (reset only for a new tab or expiry)", () => {
	recordKioskVisitActivity(10_000);
	// 같은 탭 새로고침(세션 표식 유지)은 초기화하지 않는다.
	expect(shouldResetKioskVisitOnEnter(12_000, 60_000)).toBe(false);
	// 새 탭(세션 표식 없음)은 초기화한다.
	sessionStorage.removeItem(KIOSK_VISIT_ACTIVE_SESSION_KEY);
	expect(shouldResetKioskVisitOnEnter(13_000, 60_000)).toBe(true);
});

it("defaults idle timeout to 30 minutes (1,800,000ms) while honoring a valid __NAIA_KIOSK_IDLE_TIMEOUT_MS__ override", () => {
	expect(KIOSK_VISIT_IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
	expect(KIOSK_VISIT_IDLE_TIMEOUT_MS).toBe(1_800_000);
	expect(getKioskIdleTimeoutMs()).toBe(1_800_000);

	const t0 = 10_000;
	recordKioskVisitActivity(t0);

	// 3분(180,000ms) 및 30분 직전(1,799,999ms)에는 만료되지 않는다.
	expect(isKioskVisitExpired(t0 + 3 * 60 * 1000)).toBe(false);
	expect(shouldResetKioskVisitOnEnter(t0 + 3 * 60 * 1000)).toBe(false);
	expect(isKioskVisitExpired(t0 + 1_800_000 - 1)).toBe(false);
	expect(shouldResetKioskVisitOnEnter(t0 + 1_800_000 - 1)).toBe(false);

	// 정확히 30분(1,800,000ms) 경과 시 만료·초기화 대상이 된다.
	expect(isKioskVisitExpired(t0 + 1_800_000)).toBe(true);
	expect(shouldResetKioskVisitOnEnter(t0 + 1_800_000)).toBe(true);

	// 양수 유한수 전역 덮어쓰기(__NAIA_KIOSK_IDLE_TIMEOUT_MS__)는 그대로 반영하고, 비정상 값은 30분 기본값으로 되돌린다.
	idleOverrideHolder.__NAIA_KIOSK_IDLE_TIMEOUT_MS__ = 45_000;
	expect(getKioskIdleTimeoutMs()).toBe(45_000);
	expect(isKioskVisitExpired(t0 + 44_999)).toBe(false);
	expect(isKioskVisitExpired(t0 + 45_000)).toBe(true);

	for (const invalid of [
		0,
		-1_000,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		"30m",
	]) {
		idleOverrideHolder.__NAIA_KIOSK_IDLE_TIMEOUT_MS__ = invalid;
		expect(getKioskIdleTimeoutMs()).toBe(1_800_000);
	}
});
