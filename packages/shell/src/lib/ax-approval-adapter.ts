import { Logger } from "./logger";

/** Draft host boundary matching Agent ecb879b. No JSON/RPC implementation exists.
 * Evidence and capture tokens must remain authenticated, process-local objects. */
export interface AxApprovalCard {
	readonly proposalId: string;
	readonly requestId: string;
	readonly callId: string;
	readonly mode: "conversation" | "code";
	readonly expiresAt: number;
	readonly preview: string;
	readonly reviewedPlanDigest?: string;
}
export interface AxHostControlPort {
	displayed(proposalId: string): boolean;
	beginInput(evidence: unknown): object | undefined;
	submit(
		token: object,
		input: { text: string; final: boolean; confidence?: number },
	): boolean;
	invalidate(): void;
	dispose(): void;
}

export function makeAxApprovalAdapter(host: AxHostControlPort) {
	Logger.debug("AxApprovalAdapter", "created", {});
	let current: AxApprovalCard | undefined;
	let rendered = false;
	let closed = false;
	let capture: object | undefined;
	const clear = () => {
		current = undefined;
		rendered = false;
		capture = undefined;
	};
	return {
		present(card: AxApprovalCard) {
			Logger.debug("AxApprovalAdapter", "present", { mode: card.mode });
			if (closed) return false;
			// Host present has already replaced its proposal. Calling invalidate here
			// would reject the new proposal as well as the old one.
			clear();
			current = Object.freeze({ ...card });
			return true;
		},
		displayed(proposalId: string) {
			Logger.debug("AxApprovalAdapter", "displayed", {});
			if (closed || current?.proposalId !== proposalId) return false;
			try {
				rendered = host.displayed(proposalId);
			} catch {
				rendered = false;
			}
			return rendered;
		},
		beginInput(evidence: unknown) {
			Logger.debug("AxApprovalAdapter", "beginInput", { rendered });
			capture = undefined;
			if (closed || !rendered || !current) return false;
			try {
				capture = host.beginInput(evidence);
			} catch {
				capture = undefined;
			}
			return capture !== undefined;
		},
		submit(text: string) {
			Logger.debug("AxApprovalAdapter", "submit", { captured: !!capture });
			if (closed || !current || !rendered || !capture) return false;
			const token = capture;
			clear(); // Consume before host callback: synchronous replay cannot win.
			try {
				return host.submit(token, { text, final: true });
			} catch {
				return false;
			}
		},
		invalidate() {
			Logger.debug("AxApprovalAdapter", "invalidate", {});
			clear();
			if (!closed) {
				try {
					host.invalidate();
				} catch {
					/* Local input is already retired. */
				}
			}
		},
		dispose() {
			Logger.debug("AxApprovalAdapter", "dispose", {});
			if (closed) return;
			closed = true;
			clear();
			try {
				host.dispose();
			} catch {
				/* Never resurrect a disconnected capture. */
			}
		},
	};
}
