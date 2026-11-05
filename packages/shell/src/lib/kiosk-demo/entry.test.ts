// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMemoryWebFs, setWebFsForTests } from "../web-runtime/web-fs";
import { WEB_REMOTE_KEY_STORAGE_KEY } from "../web-runtime/web-auth";
import {
	clearKioskVisitActivity,
	isKioskVisitExpired,
	KIOSK_VISIT_ACTIVE_SESSION_KEY,
	KIOSK_VISIT_LAST_ACTIVE_KEY,
	recordKioskVisitActivity,
	resetKioskVisit,
	shouldResetKioskVisitOnEnter,
} from "./entry";

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	setWebFsForTests(null);
});
afterEach(() => {
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
