/**
 * Voice Reference Audio gateway client (naia-anyllm #31, plan §7).
 *
 * Talks to the `/v1/ref-audio` endpoints on `LAB_GATEWAY_URL`. The
 * encoder in `ref-audio.ts` produces the wire-form base64; this module
 * is just transport (auth, idempotency, error mapping) — keeping the
 * two concerns separate so the encoder stays usable from the realtime
 * proxy path too.
 *
 * Auth: `X-AnyLLM-Key: Bearer <naiaKey>` (matches CostDashboard +
 * gemini-live, the existing gateway client pattern).
 *
 * PII (plan §11): we never log the base64 payload. Only sizes,
 * durations, and status codes go through `Logger`.
 */

import { LAB_GATEWAY_URL, getNaiaKeySecure } from "../config";
import { Logger } from "../logger";
import { encodeRefAudio } from "./ref-audio";

const TAG = "RefAudioApi";

export interface RefAudioActive {
	uploadedAt: string;
	sizeBytes: number;
	durationSeconds: number;
}

export interface RefAudioStatus {
	active: RefAudioActive | null;
	historyCount: number;
}

export interface RefAudioUploadResult {
	uploadedAt: string;
	sizeBytes: number;
	durationSeconds: number;
	newBalanceUsd: number;
	transactionId: string;
}

export type RefAudioErrorCode =
	| "unauthenticated"
	| "credit-insufficient"
	| "invalid-audio-format"
	| "duration-out-of-range"
	| "file-too-large"
	| "upload-in-progress"
	| "network"
	| "unknown";

export class RefAudioApiError extends Error {
	readonly code: RefAudioErrorCode;
	readonly status: number;
	readonly detail: Record<string, unknown>;
	constructor(
		code: RefAudioErrorCode,
		status: number,
		message: string,
		detail: Record<string, unknown> = {},
	) {
		super(message);
		this.name = "RefAudioApiError";
		this.code = code;
		this.status = status;
		this.detail = detail;
	}
}

async function authHeader(): Promise<Record<string, string>> {
	const naiaKey = await getNaiaKeySecure();
	if (!naiaKey) {
		throw new RefAudioApiError(
			"unauthenticated",
			401,
			"naia account is not signed in",
		);
	}
	return { "X-AnyLLM-Key": `Bearer ${naiaKey}` };
}

function mapErrorCode(status: number, body: unknown): RefAudioErrorCode {
	const tag =
		typeof body === "object" && body !== null && "error" in body
			? String((body as { error: unknown }).error)
			: "";
	if (status === 401) return "unauthenticated";
	if (status === 402) return "credit-insufficient";
	if (status === 409 && tag === "upload-in-progress")
		return "upload-in-progress";
	if (status === 413) return "file-too-large";
	if (status === 422 && tag === "duration-out-of-range")
		return "duration-out-of-range";
	if (status === 422) return "invalid-audio-format";
	return "unknown";
}

async function readErrorBody(res: Response): Promise<Record<string, unknown>> {
	try {
		const body = await res.json();
		return typeof body === "object" && body !== null
			? (body as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * Fetch the user's current ref-audio metadata. Returns `null active`
 * when the user has never uploaded.
 */
export async function getRefAudioStatus(): Promise<RefAudioStatus> {
	const headers = await authHeader();
	let res: Response;
	try {
		res = await fetch(`${LAB_GATEWAY_URL}/v1/ref-audio`, { headers });
	} catch (err) {
		Logger.warn(TAG, "ref-audio GET network error", { error: String(err) });
		throw new RefAudioApiError("network", 0, String(err));
	}
	if (!res.ok) {
		const body = await readErrorBody(res);
		throw new RefAudioApiError(
			mapErrorCode(res.status, body),
			res.status,
			`GET /v1/ref-audio failed (${res.status})`,
			body,
		);
	}
	const body = (await res.json()) as {
		active?: {
			uploaded_at?: string;
			size_bytes?: number;
			duration_seconds?: number;
		} | null;
		history_count?: number;
	};
	const active = body.active;
	return {
		active: active?.uploaded_at
			? {
					uploadedAt: active.uploaded_at,
					sizeBytes: active.size_bytes ?? 0,
					durationSeconds: active.duration_seconds ?? 0,
				}
			: null,
		historyCount: body.history_count ?? 0,
	};
}

/**
 * Encode + upload the user's reference clip.
 *
 * `input` accepts the same shapes as `encodeRefAudio` (Blob/File,
 * ArrayBuffer, or an already-base64 wire string). A fresh uuid4
 * Idempotency-Key is generated per call — `localStorage` save is
 * unsafe (replay → double charge once the key TTL passes).
 *
 * Caller is responsible for showing the right toast on each
 * `RefAudioErrorCode`. Charges $0.01 from the user's Tier B credit.
 */
export async function uploadRefAudio(
	input: ArrayBuffer | Blob | string,
): Promise<RefAudioUploadResult> {
	const b64 = await encodeRefAudio(input);
	const headers: Record<string, string> = {
		...(await authHeader()),
		"Idempotency-Key": crypto.randomUUID(),
	};
	const form = new FormData();
	// gateway expects the base64 string in a file-field (plan §4)
	form.append("file", new Blob([b64], { type: "text/plain" }), "ref-audio.b64");

	let res: Response;
	try {
		res = await fetch(`${LAB_GATEWAY_URL}/v1/ref-audio`, {
			method: "POST",
			headers,
			body: form,
		});
	} catch (err) {
		Logger.warn(TAG, "ref-audio POST network error", { error: String(err) });
		throw new RefAudioApiError("network", 0, String(err));
	}

	if (!res.ok) {
		const body = await readErrorBody(res);
		Logger.warn(TAG, "ref-audio upload failed", {
			status: res.status,
			error: String(body.error ?? ""),
			// PII (plan §11): size goes through, the base64 payload does NOT
			b64SizeBytes: b64.length,
		});
		throw new RefAudioApiError(
			mapErrorCode(res.status, body),
			res.status,
			`POST /v1/ref-audio failed (${res.status})`,
			body,
		);
	}

	const data = (await res.json()) as {
		uploaded_at?: string;
		size_bytes?: number;
		duration_seconds?: number;
		new_balance_usd?: number;
		transaction_id?: string;
	};
	Logger.info(TAG, "ref-audio uploaded", {
		sizeBytes: data.size_bytes,
		durationSeconds: data.duration_seconds,
		newBalanceUsd: data.new_balance_usd,
	});
	return {
		uploadedAt: data.uploaded_at ?? new Date().toISOString(),
		sizeBytes: data.size_bytes ?? 0,
		durationSeconds: data.duration_seconds ?? 0,
		newBalanceUsd: data.new_balance_usd ?? 0,
		transactionId: data.transaction_id ?? "",
	};
}

/**
 * Soft-delete the active ref-audio (history kept until the 90-day
 * sweep). Pass `hardDelete: true` to wipe active + every history blob
 * immediately (GDPR / 한국 개인정보보호법 right-to-erasure).
 */
export async function deleteRefAudio(
	options: { hardDelete?: boolean } = {},
): Promise<void> {
	const headers = await authHeader();
	const url = options.hardDelete
		? `${LAB_GATEWAY_URL}/v1/ref-audio?hard_delete=true`
		: `${LAB_GATEWAY_URL}/v1/ref-audio`;
	let res: Response;
	try {
		res = await fetch(url, { method: "DELETE", headers });
	} catch (err) {
		Logger.warn(TAG, "ref-audio DELETE network error", { error: String(err) });
		throw new RefAudioApiError("network", 0, String(err));
	}
	if (!res.ok && res.status !== 404) {
		const body = await readErrorBody(res);
		throw new RefAudioApiError(
			mapErrorCode(res.status, body),
			res.status,
			`DELETE /v1/ref-audio failed (${res.status})`,
			body,
		);
	}
	Logger.info(TAG, "ref-audio deleted", { hardDelete: !!options.hardDelete });
}
