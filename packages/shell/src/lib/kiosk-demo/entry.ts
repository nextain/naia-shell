import { Logger } from "../logger";

let greetingPending = false;

export function requestKioskGreeting(): void {
	Logger.debug("KioskDemo", "entry accepted");
	greetingPending = true;
}

/** Destructive read prevents duplicate greeting on React StrictMode remounts. */
export function consumeKioskGreeting(): boolean {
	const pending = greetingPending;
	greetingPending = false;
	return pending;
}

/** Wait for cancellation and durable memory reset before discarding the session. */
export async function resetKioskVisit(actions: {
	cancel: () => void | Promise<void>;
	resetMemory: () => Promise<void>;
	newConversation: () => void;
	reload: () => void;
}): Promise<void> {
	Logger.debug("KioskDemo", "reset visit");
	await actions.cancel();
	await actions.resetMemory();
	actions.newConversation();
	actions.reload();
}
