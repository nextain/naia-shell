import { expect, it, vi } from "vitest";
import { resetKioskVisit } from "./entry";
it("waits for cancellation and memory reset before new session and reload", async () => {
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
