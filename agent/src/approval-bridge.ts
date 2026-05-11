/**
 * Approval Bridge — naia-os pending-approvals Map ↔ ApprovalBroker contract.
 *
 * R4 Phase 4.1 Day 4.5.2 — Phase 4.1 transition layer.
 *
 * Background:
 *   naia-os agent/src/index.ts uses an in-process Map<toolCallId, {resolve}>
 *   pattern (lines 99~106) plus stdio writeLine() to emit `approval_request`
 *   frames; Shell responds via `approval_response` to handleApprovalResponse().
 *
 *   external @nextain/agent-types defines `ApprovalBroker.decide(req) → Promise<ApprovalDecision>`.
 *   cli-app's `IpcApprovalBroker` (Day 2-3) implements this over StdioFrame v1
 *   envelopes + dispatcher routing.
 *
 * This bridge provides the **adapter contract** for Phase 4.2 to wire naia-os
 * approval flow into IpcApprovalBroker. Phase 4.1 keeps the legacy Map-based
 * flow active; this module exposes a clean interface so future migration is a
 * one-import change rather than a dispatch refactor.
 *
 * Spec: r4-phase4-day1-1-interface-mapping.md §3.4 (Approval mapping)
 *       day2-spec.md (IpcApprovalBroker integration)
 *
 * Phase 4.2 will replace `pendingApprovals` Map + `waitForApproval` with a
 * single `BridgedApprovalBroker.decide()` call routed through cli-app's
 * StdioDispatcher.
 */

import { randomUUID } from "node:crypto";
import type { ApprovalResponse } from "./protocol.js";

/** Tier level — mirrors @nextain/agent-types TierLevel. */
export type ApprovalTier = "T0" | "T1" | "T2" | "T3";

/** Mirrors @nextain/agent-types ApprovalRequest minimum shape. */
export interface BridgeApprovalRequest {
	id: string;
	toolName: string;
	toolArgs: unknown;
	tier: ApprovalTier;
	summary: string;
	timeoutMs?: number;
	sessionId?: string;
}

/** Mirrors @nextain/agent-types ApprovalDecision union. */
export type BridgeApprovalDecision =
	| { status: "approved"; at: number }
	| { status: "denied"; reason: string; at: number }
	| { status: "timeout"; at: number };

/** Minimum broker contract — naia-os flow adapts to this in Phase 4.2. */
export interface ApprovalBridge {
	decide(request: BridgeApprovalRequest): Promise<BridgeApprovalDecision>;
	/** Forward a response received via stdio (or other channel) into the broker. */
	handleResponse(response: ApprovalResponse): void;
	/** Settle all pending as denied (e.g. agent shutdown). */
	close(): void;
	/** Diagnostics — count of in-flight approvals. */
	pendingCount(): number;
}

/** Default tier timeout (ms) — mirrors @nextain/agent-types APPROVAL_DEFAULT_TIMEOUT_MS. */
export const APPROVAL_DEFAULT_TIMEOUT_MS: Record<ApprovalTier, number> = {
	T0: 0,
	T1: 60_000,
	T2: 120_000,
	T3: 300_000,
};

interface PendingEntry {
	resolve: (d: BridgeApprovalDecision) => void;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface NaiaApprovalBridgeOptions {
	/** Custom timeout overrides. */
	defaultTimeoutMs?: Partial<Record<ApprovalTier, number>>;
	/** Emit outbound approval_request frame to shell (e.g. writeLine). */
	emit: (frame: {
		type: "approval_request";
		requestId: string;
		toolCallId: string;
		toolName: string;
		args: unknown;
		tier: number;
		description: string;
	}) => void;
}

/**
 * NaiaApprovalBridge — Phase 4.1 transition implementation.
 *
 * Behavior matches naia-os index.ts pendingApprovals Map + waitForApproval()
 * but exposes the @nextain/agent-types ApprovalBroker contract (translated to
 * naia-os's `ApprovalResponse.decision: "once" | "always" | "reject"` legacy
 * format). "always" treated as "once" (single grant) — Phase 4.2 will enforce
 * fresh-per-tier via IpcApprovalBroker (D40 spec).
 */
export class NaiaApprovalBridge implements ApprovalBridge {
	readonly #defaultTimeoutMs: Record<ApprovalTier, number>;
	readonly #emit: NaiaApprovalBridgeOptions["emit"];
	readonly #pending = new Map<string, PendingEntry>();
	#closed = false;

	constructor(opts: NaiaApprovalBridgeOptions) {
		this.#emit = opts.emit;
		this.#defaultTimeoutMs = {
			T0: opts.defaultTimeoutMs?.T0 ?? APPROVAL_DEFAULT_TIMEOUT_MS.T0,
			T1: opts.defaultTimeoutMs?.T1 ?? APPROVAL_DEFAULT_TIMEOUT_MS.T1,
			T2: opts.defaultTimeoutMs?.T2 ?? APPROVAL_DEFAULT_TIMEOUT_MS.T2,
			T3: opts.defaultTimeoutMs?.T3 ?? APPROVAL_DEFAULT_TIMEOUT_MS.T3,
		};
	}

	async decide(request: BridgeApprovalRequest): Promise<BridgeApprovalDecision> {
		if (this.#closed) {
			return { status: "denied", reason: "bridge closed", at: Date.now() };
		}
		// T0 — never requires approval.
		if (request.tier === "T0") {
			return { status: "approved", at: Date.now() };
		}

		const id = request.id || randomUUID();
		const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs[request.tier];

		return new Promise<BridgeApprovalDecision>((resolve) => {
			let settled = false;
			const settle = (d: BridgeApprovalDecision) => {
				if (settled) return;
				settled = true;
				const e = this.#pending.get(id);
				if (e?.timer) clearTimeout(e.timer);
				this.#pending.delete(id);
				resolve(d);
			};

			const timer = timeoutMs > 0
				? setTimeout(() => settle({ status: "timeout", at: Date.now() }), timeoutMs)
				: null;

			this.#pending.set(id, { resolve: settle, timer });

			// Emit naia-os legacy `approval_request` frame.
			try {
				this.#emit({
					type: "approval_request",
					requestId: id,
					toolCallId: id,
					toolName: request.toolName,
					args: request.toolArgs as Record<string, unknown>,
					tier: tierToNumber(request.tier),
					description: request.summary,
				});
			} catch (err) {
				if (timer) clearTimeout(timer);
				this.#pending.delete(id);
				settled = true;
				resolve({
					status: "denied",
					reason: `emit failed: ${err instanceof Error ? err.message : String(err)}`,
					at: Date.now(),
				});
			}
		});
	}

	handleResponse(response: ApprovalResponse): void {
		const e = this.#pending.get(response.toolCallId);
		if (!e) return;  // stale or unknown
		const at = Date.now();
		if (response.decision === "reject") {
			e.resolve({
				status: "denied",
				reason: response.message ?? "user denied",
				at,
			});
		} else if (response.decision === "always") {
			// Phase 4.5 Day 8.1 — legacy "always" 변환기 (D40 spec 강제).
			// Adversarial review (Phase 4 P0-3 fix) — emit structured "log" frame
			// instead of stderr (shell logs는 사용자 도달 X). Shell 측에서 frame을
			// 파싱하여 toast notification 또는 modal warning 표시 가능.
			//
			// "always" was historically a permissive grant; D40 requires fresh-per-tier.
			// Phase 5+ envelope-only + IpcApprovalBroker direct wire 시 outright reject.
			this.#emit({
				type: "approval_request",  // reuse channel for shell visibility
				requestId: `always-warn-${response.toolCallId}`,
				toolCallId: response.toolCallId,
				toolName: "__d40_warn__",
				args: {
					message: 'legacy "always" decision treated as one-time approve (D40 fresh-per-tier policy)',
					originalToolCallId: response.toolCallId,
				},
				tier: 0,
				description: "D40 transition warning — shell should display this to user",
			});
			// stderr 백업 (production 모니터링용)
			process.stderr.write(
				`[NaiaApprovalBridge] legacy "always" → one-time approve (D40, id=${response.toolCallId})\n`,
			);
			e.resolve({ status: "approved", at });
		} else {
			// "once" — single grant.
			e.resolve({ status: "approved", at });
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const [id, e] of this.#pending) {
			if (e.timer) clearTimeout(e.timer);
			e.resolve({ status: "denied", reason: "bridge closed", at: Date.now() });
			this.#pending.delete(id);
		}
	}

	pendingCount(): number {
		return this.#pending.size;
	}
}

/** Convert tier string ↔ legacy tier number (used by naia-os tool-tiers.ts). */
function tierToNumber(tier: ApprovalTier): number {
	if (tier === "T0") return 0;
	if (tier === "T1") return 1;
	if (tier === "T2") return 2;
	return 3;
}
