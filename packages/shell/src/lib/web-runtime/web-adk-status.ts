export type WebAdkPhase =
	| "checking"
	| "needs-setup"
	| "installing"
	| "ready"
	| "error";

export interface WebAdkStatus {
	phase: WebAdkPhase;
	done?: number;
	total?: number;
	reason?: string;
}

let currentStatus: WebAdkStatus = {
	phase: "checking",
};

const listeners = new Set<() => void>();

export function getWebAdkStatus(): WebAdkStatus {
	return currentStatus;
}

export function subscribeWebAdkStatus(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function setWebAdkStatus(patch: Partial<WebAdkStatus>): void {
	const nextPhase = patch.phase ?? currentStatus.phase;
	const nextStatus: WebAdkStatus = {
		...currentStatus,
		...patch,
	};
	if (nextPhase !== "installing") {
		delete nextStatus.done;
		delete nextStatus.total;
	}
	if (nextPhase !== "error") {
		delete nextStatus.reason;
	}
	currentStatus = nextStatus;
	for (const listener of listeners) {
		listener();
	}
}

export function resetWebAdkStatusForTests(): void {
	currentStatus = {
		phase: "checking",
	};
	listeners.clear();
}

declare global {
	interface Window {
		__NAIA_WEB_ADK_STATUS__?: () => WebAdkStatus;
	}
}

if (import.meta.env.MODE === "web" && typeof window !== "undefined") {
	window.__NAIA_WEB_ADK_STATUS__ = getWebAdkStatus;
}
