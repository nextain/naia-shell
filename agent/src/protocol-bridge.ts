/**
 * Protocol Bridge — naia-os flat protocol ↔ @nextain/agent-protocol StdioFrame v1.
 *
 * R4 Phase 4.1 Day 4.4 — transition window envelope wrapping.
 *
 * Spec: r4-phase4-day1-2-protocol-mapping.md §8 (encoding/decoding)
 *
 * Use cases (Phase 4.1 transition):
 *   - shell sends StdioFrame v1 envelope → unwrapFrame() → existing AgentRequest dispatch
 *   - existing writeLine output → wrapAsFrame() → shell consumes as StdioFrame
 *   - both formats coexist behind capability negotiation (Day 1.4 §3 handshake)
 *
 * Phase 4.2 lock will remove the legacy flat path; bridge becomes pass-through.
 */

import { randomUUID } from "node:crypto";
import {
	PROTOCOL_VERSION,
	type StdioFrame,
} from "@nextain/agent-protocol";
import type { AgentRequest } from "./protocol.js";

/**
 * Allowed payload.kind whitelist (Day 1.2 §8 + Day 2 Paranoid P1-1 fix).
 * Mirrored from cli-app/src/ipc-approval-broker.ts ALLOWED_KINDS to keep
 * shell + agent enforcement symmetric.
 */
const ALLOWED_KINDS = new Set<string>([
	// shell → agent (request)
	"chat", "cancel", "tool_direct", "tts", "skill_list",
	"memory_export", "memory_import",
	"panel_skills", "panel_skills_clear", "panel_install",
	// shell → agent (response/event)
	"approval", "panel_tool_result", "approval_cancel",
	// agent → shell (event)
	"chat_chunk", "audio", "usage", "tool_result", "chat_end",
	"error", "log", "token_warning", "ready",
	"panel_install_result", "panel_control",
	// agent → shell (request — agent solicits)
	"panel_tool_call",
	// agent → shell (response — to shell request)
	"memory_export_result", "memory_import_result", "skill_list_response",
	// handshake
	"handshake", "handshake_ack",
]);

export function isValidKind(kind: unknown): kind is string {
	if (typeof kind !== "string") return false;
	if (kind === "__proto__" || kind === "constructor" || kind === "prototype") {
		return false;
	}
	return ALLOWED_KINDS.has(kind);
}

/**
 * naia-os flat AgentRequest type → application kind mapping.
 * Identical to dispatcher's classifyFrameType but expressed as kind→type.
 */
function classifyFrameType(applicationKind: string): "request" | "response" | "event" {
	if (applicationKind === "approval" /* response side */ || applicationKind === "panel_tool_result") {
		return "response";
	}
	if (
		applicationKind === "memory_export_result" ||
		applicationKind === "memory_import_result" ||
		applicationKind === "skill_list_response"
	) {
		return "response";
	}
	if (
		applicationKind === "chat_chunk" || applicationKind === "audio" ||
		applicationKind === "usage" || applicationKind === "tool_result" ||
		applicationKind === "chat_end" || applicationKind === "error" ||
		applicationKind === "log" || applicationKind === "token_warning" ||
		applicationKind === "ready" ||
		applicationKind === "panel_install_result" || applicationKind === "panel_control" ||
		applicationKind === "approval_cancel"
	) {
		return "event";
	}
	return "request";
}

/**
 * Map naia-os flat AgentRequest.type → StdioFrame v1 payload.kind.
 *
 * naia-os legacy types include `chat_request`, `cancel_stream`, etc. — these
 * are stripped of trailing `_request` / `_stream` to produce envelope kinds.
 */
function flatTypeToKind(flatType: string): string {
	if (flatType === "chat_request") return "chat";
	if (flatType === "cancel_stream") return "cancel";
	if (flatType === "tool_request") return "tool_direct";
	if (flatType === "tts_request") return "tts";
	if (flatType === "skill_list") return "skill_list";
	if (flatType === "memory_export") return "memory_export";
	if (flatType === "memory_import") return "memory_import";
	if (flatType === "approval_response") return "approval";
	if (flatType === "panel_skills") return "panel_skills";
	if (flatType === "panel_skills_clear") return "panel_skills_clear";
	if (flatType === "panel_install") return "panel_install";
	if (flatType === "panel_tool_result") return "panel_tool_result";
	// agent → shell streaming chunks (writeLine emit)
	if (flatType === "text" || flatType === "thinking" || flatType === "tool_use") return "chat_chunk";
	if (flatType === "finish") return "chat_end";
	if (flatType === "log_entry") return "log";
	if (flatType === "skill_list_response") return "skill_list_response";
	// pass-through for already-correct kinds
	return flatType;
}

/**
 * Reverse of flatTypeToKind — used when a StdioFrame arrives and we need to
 * synthesize a legacy AgentRequest for existing dispatch code in index.ts.
 *
 * Day 4.4 review (P1 — kindToFlatType 역방향 완성) fix: response-side kinds
 * also reversed (memory/skill_list result), event-side preserved through
 * delta-aware chat_chunk handling in unwrapFrame.
 */
function kindToFlatType(kind: string, payload: Record<string, unknown>): string {
	// Request-side reverse
	if (kind === "chat") return "chat_request";
	if (kind === "cancel") return "cancel_stream";
	if (kind === "tool_direct") return "tool_request";
	if (kind === "tts") return "tts_request";
	if (kind === "skill_list") return "skill_list";
	if (kind === "memory_export") return "memory_export";
	if (kind === "memory_import") return "memory_import";
	if (kind === "panel_skills") return "panel_skills";
	if (kind === "panel_skills_clear") return "panel_skills_clear";
	if (kind === "panel_install") return "panel_install";
	// Response-side reverse (P1 fix — Day 4.4 review)
	if (kind === "approval") return "approval_response";
	if (kind === "panel_tool_result") return "panel_tool_result";
	if (kind === "memory_export_result") return "memory_export_result";
	if (kind === "memory_import_result") return "memory_import_result";
	if (kind === "skill_list_response") return "skill_list_response";
	// Event-side reverse — chat_chunk needs delta-aware variant restoration
	if (kind === "chat_chunk") {
		const delta = payload["delta"] as { text?: unknown; thinking?: unknown; tool_use?: unknown } | undefined;
		if (delta?.tool_use) return "tool_use";
		if (delta?.thinking !== undefined) return "thinking";
		return "text";
	}
	if (kind === "chat_end") return "finish";
	if (kind === "log") return "log_entry";
	// Pass-through for kinds with same name in flat protocol
	return kind;
}

/**
 * Wrap a naia-os flat AgentRequest (or any agent→shell event/response) into
 * a StdioFrame v1 envelope.
 *
 * @param flat   The naia-os flat object — must have `type` field. `requestId`
 *               (if present) becomes the frame `id`.
 * @returns StdioFrame v1 ready for stdout serialization.
 */
export function wrapAsFrame(flat: { type: string; requestId?: string; [k: string]: unknown }): StdioFrame {
	const { type: flatType, requestId, ...rest } = flat;
	const kind = flatTypeToKind(flatType);
	if (!isValidKind(kind)) {
		throw new Error(`wrapAsFrame: invalid kind '${kind}' (from flat type '${flatType}')`);
	}
	return {
		v: PROTOCOL_VERSION,
		id: requestId ?? randomUUID(),
		type: classifyFrameType(kind),
		payload: { kind, ...rest },
	};
}

/**
 * Unwrap a StdioFrame v1 into a naia-os flat AgentRequest shape, suitable
 * for the existing readline dispatch in `index.ts.main()`.
 *
 * Returns null if the frame's payload is malformed or kind is not allowed
 * (Paranoid P1-1 — silent drop, caller should log via stderr).
 */
export function unwrapFrame(frame: StdioFrame): AgentRequest | null {
	const payload = frame.payload as { kind?: unknown; [k: string]: unknown } | null;
	if (!payload || typeof payload !== "object") return null;
	const { kind, ...rest } = payload;
	if (!isValidKind(kind)) return null;
	const flatType = kindToFlatType(kind, payload as Record<string, unknown>);
	const out: Record<string, unknown> = {
		type: flatType,
		requestId: frame.id,
		...rest,
	};
	return out as unknown as AgentRequest;
}

/**
 * Detect whether an inbound JSON line is a StdioFrame v1 envelope or a
 * legacy flat naia-os request. Heuristic: envelopes have `v="1"` + `payload`
 * top-level fields.
 *
 * Phase 4.1 transition: shell may send either format until handshake
 * negotiates v1 mode (Day 1.4 §3). Phase 4.2 lock removes legacy.
 */
export function looksLikeFrame(parsed: unknown): boolean {
	if (typeof parsed !== "object" || parsed === null) return false;
	const obj = parsed as Record<string, unknown>;
	return obj["v"] === PROTOCOL_VERSION && "payload" in obj && typeof obj["type"] === "string";
}
