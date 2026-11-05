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
