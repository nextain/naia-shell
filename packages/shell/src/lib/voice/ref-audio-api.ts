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

import { invoke } from "@tauri-apps/api/core";
import { getAdkPath } from "../adk-store";
import {
	DEFAULT_LOCAL_VOICE_HOST,
	LAB_GATEWAY_URL,
	canonicalRefAudioUrl,
	getNaiaKeySecure,
} from "../config";
import { Logger } from "../logger";
import {
	fetchLocalVoiceAuthenticated,
	localVoiceAuthHeaders,
} from "./local-runtime";
import { encodeRefAudio } from "./ref-audio";

const TAG = "RefAudioApi";

// ── Naia Local recorded/uploaded reference voice (no gateway, no credits) ──
// Naia Local uses the member-gated loopback Runtime without per-request voice
// credits. The selected ADK owns the WAV at naia-settings/voice/ref-audio.wav.
// localStorage is only a hot runtime cache because the synchronous synthesis
// path must be able to read the clip without an IPC round-trip.
const LOCAL_REF_AUDIO_KEY = "naia.voiceRefAudioB64";

/** Persist (or clear) the local recorded reference voice as a base64 WAV. */
export function setLocalRefAudioB64(b64: string | null): void {
	try {
		if (b64) localStorage.setItem(LOCAL_REF_AUDIO_KEY, b64);
		else localStorage.removeItem(LOCAL_REF_AUDIO_KEY);
	} catch {
		// localStorage unavailable — non-fatal.
	}
}

/** The locally-stored recorded reference voice (base64 WAV), or null. */
export function getLocalRefAudioB64(): string | null {
	try {
		return localStorage.getItem(LOCAL_REF_AUDIO_KEY);
	} catch {
		return null;
	}
}

function base64ToBytes(b64: string): number[] {
	const binary = atob(b64);
	return Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(bytes: number[]): string {
	const chunkSize = 0x8000;
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
	}
	return btoa(binary);
}

function isCurrentAdkPath(adkPath: string): boolean {
	return getAdkPath() === adkPath;
}

/** Persist the local reference voice in the selected ADK and refresh the cache. */
export async function persistLocalRefAudioB64(b64: string): Promise<void> {
	const adkPath = getAdkPath();
	if (!adkPath) throw new Error("ADK path is not configured");
	await invoke("write_naia_ref_audio", {
		adkPath,
		bytes: base64ToBytes(b64),
	});
	if (isCurrentAdkPath(adkPath)) setLocalRefAudioB64(b64);
}

/**
 * 녹음해 둔 참조 음성을 워크스페이스에서 지운다.
 *
 * 저장과 한 함수였는데 인자가 null 이냐 아니냐로 갈렸다. 그러면 부르는
 * 쪽만 보고는 이것이 저장인지 삭제인지 알 수 없고, 되돌릴 수 없는 동작에
 * 확인이 걸렸는지 보는 검사도 둘을 구분하지 못한다. 이름으로 갈라 둔다.
 */
export async function clearLocalRefAudio(): Promise<void> {
	const adkPath = getAdkPath();
	if (!adkPath) throw new Error("ADK path is not configured");
	await invoke("delete_naia_ref_audio", { adkPath });
	if (isCurrentAdkPath(adkPath)) setLocalRefAudioB64(null);
}

/** Hydrate the synchronous runtime cache from the selected ADK source of truth. */
export async function hydrateLocalRefAudioB64(): Promise<string | null> {
	const adkPath = getAdkPath();
	setLocalRefAudioB64(null);
	if (!adkPath) {
		return null;
	}
	const bytes = await invoke<number[] | null>("read_naia_ref_audio", {
		adkPath,
	});
	const b64 = bytes && bytes.length > 0 ? bytesToBase64(bytes) : null;
	if (isCurrentAdkPath(adkPath)) setLocalRefAudioB64(b64);
	return b64;
}

export interface RefAudioActive {
	/** "upload" | "preset" — absent on legacy gateway = treat as "upload". */
	kind?: "upload" | "preset";
	uploadedAt: string;
	sizeBytes: number;
	durationSeconds: number;
	/** Present only when kind === "preset". */
	presetId?: string;
	presetName?: string;
}

export interface RefAudioStatus {
	active: RefAudioActive | null;
	historyCount: number;
}

/** A pre-provided voice reference preset (REF-AUDIO-PRESET-CONTRACT §2). */
export interface RefAudioPreset {
	id: string;
	name: string;
	description?: string;
	locale: string;
	gender?: string;
	ageRange?: string;
	durationSeconds: number;
	sampleUrl: string;
	sampleFormat: string;
	sampleSha256?: string;
	source: string;
	license: string;
	localIndex?: number;
	isDefault?: boolean;
}

/** Install a browser-recorded/uploaded WAV as the local Runtime's active voice. */
export async function applyLocalRefAudio(
	b64: string,
	baseUrl = DEFAULT_LOCAL_VOICE_HOST,
): Promise<void> {
	const base = baseUrl.trim().replace(/\/+$/, "") || DEFAULT_LOCAL_VOICE_HOST;
	let res: Response;
	try {
		res = await fetchLocalVoiceAuthenticated(base, "/voice", {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ audio_base64: b64 }),
		});
	} catch (err) {
		throw new RefAudioApiError("network", 0, String(err));
	}
	if (!res.ok) {
		const body = await readErrorBody(res);
		throw new RefAudioApiError(
			mapErrorCode(res.status, body),
			res.status,
			`PUT /voice failed (${res.status})`,
			body,
		);
	}
}

/**
 * Read the voice palette exposed by the standalone local voice runtime.
 *
 * This endpoint is loopback-only and protected by the per-launch bearer. It is
 * the source of truth for voices that VoxCPM2 can actually resolve; using the
 * cloud preset endpoint here made preview fail whenever the LLM was external
 * but TTS used `naia-local-voice`.
 */
export async function getLocalRefAudioPresets(
	baseUrl = DEFAULT_LOCAL_VOICE_HOST,
): Promise<RefAudioPreset[]> {
	const base = baseUrl.trim().replace(/\/+$/, "") || DEFAULT_LOCAL_VOICE_HOST;
	const authHeaders = localVoiceAuthHeaders();
	Logger.debug(TAG, "getLocalRefAudioPresets:entry", {
		base,
		hasToken: !!authHeaders.Authorization,
	});
	let res: Response;
	try {
		res = await fetchLocalVoiceAuthenticated(base, "/ref/voices");
	} catch (err) {
		Logger.warn(TAG, "local presets GET network error", {
			base,
			hasToken: !!authHeaders.Authorization,
			error: String(err),
		});
		throw new RefAudioApiError("network", 0, String(err));
	}
	if (!res.ok) {
		const body = await readErrorBody(res);
		Logger.warn(TAG, "getLocalRefAudioPresets:http-error", {
			status: res.status,
			hasToken: !!authHeaders.Authorization,
		});
		throw new RefAudioApiError(
			mapErrorCode(res.status, body),
			res.status,
			`GET /ref/voices failed (${res.status})`,
			body,
		);
	}
	const body = (await res.json()) as {
		voices?: Array<{
			name?: string;
			url?: string;
			gender?: string;
			lang?: string;
			idx?: number;
			default?: boolean;
		}>;
	};
	Logger.debug(TAG, "getLocalRefAudioPresets:result", {
		count: (body.voices ?? []).length,
	});
	return (body.voices ?? [])
		.filter((voice) => voice.name && voice.url)
		.map((voice) => {
			const name = voice.name as string;
			// The runtime's /ref/voices doesn't carry gender metadata, but the CC0
			// catalog encodes it in the name (cc0-ko-female-01 / cc0-ko-male-01) —
			// derive it so the male/female preset filter works for local voices too.
			const gender =
				voice.gender ??
				(/female/i.test(name)
					? "female"
					: /male/i.test(name)
						? "male"
						: undefined);
			// The runtime returns a loopback-relative path (/ref/audio/<name>.wav).
			// Preview/apply fetch this URL directly, so it must be absolute against
			// the engine host — a relative URL resolves against the webview origin
			// (tauri://) and 404s, which is why local preview silently failed.
			const url = voice.url as string;
			const sampleUrl = /^https?:\/\//i.test(url) ? url : `${base}${url}`;
			return {
				id: name,
				name: voice.default ? `${name} (default)` : name,
				locale: voice.lang ?? "",
				gender,
				durationSeconds: 0,
				sampleUrl,
				sampleFormat: "wav",
				source: "local-runtime",
				license: "bundled",
				localIndex: voice.idx,
				isDefault: voice.default ?? false,
			};
		});
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
	// W5 — gateway GPU pool 매진 (모든 후보 cap 초과 OR 가용 0).
	// 사용자 UI = "현재 매진입니다. 잠시 후 다시 시도해주세요" + Tier A 권장.
	| "sold-out"
	// preset 선택 시 preset_id 미존재 (404).
	| "preset-not-found"
	// content 미리듣기 시 active ref 없음 (404, GET /v1/ref-audio/content).
	| "no-active-ref"
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
	// Gateway ref-audio routes read the `Authorization` header (ref_audio.py
	// _extract_bearer), NOT X-AnyLLM-Key — mismatched header name was causing
	// 401 on status/presets even while signed in.
	return { Authorization: `Bearer ${naiaKey}` };
}

function mapErrorCode(status: number, body: unknown): RefAudioErrorCode {
	const tag =
		typeof body === "object" && body !== null && "error" in body
			? String((body as { error: unknown }).error)
			: "";
	if (status === 401) return "unauthenticated";
	if (status === 404 && tag === "no-active-ref") return "no-active-ref";
	if (status === 404 && tag === "preset-not-found") return "preset-not-found";
	if (status === 402) return "credit-insufficient";
	if (status === 409 && tag === "upload-in-progress")
		return "upload-in-progress";
	if (status === 413) return "file-too-large";
	if (status === 422 && tag === "duration-out-of-range")
		return "duration-out-of-range";
	if (status === 422) return "invalid-audio-format";
	// W5 — gateway GPU pool 매진 (503 + error="sold-out").
	// plan §0.2.1 매진 UX 일관: 새 session 거부 + 사용자 안내.
	// (gateway pool orchestrator follow-up = W4-follow-up)
	if (status === 503 && tag === "sold-out") return "sold-out";
	if (status === 503) return "sold-out"; // 운영 시 backend overload 도 매진 처리
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
			kind?: "upload" | "preset";
			uploaded_at?: string;
			size_bytes?: number;
			duration_seconds?: number;
			preset_id?: string;
			preset_name?: string;
		} | null;
		history_count?: number;
	};
	const active = body.active;
	if (!active) return { active: null, historyCount: body.history_count ?? 0 };

	// Backward compat (§3.2): no `kind` + uploaded_at present → "upload".
	const kind: "upload" | "preset" =
		active.kind ?? (active.uploaded_at ? "upload" : "upload");
	if (kind === "preset" && active.preset_id) {
		return {
			active: {
				kind: "preset",
				uploadedAt: active.uploaded_at ?? "",
				sizeBytes: active.size_bytes ?? 0,
				durationSeconds: active.duration_seconds ?? 0,
				presetId: active.preset_id,
				presetName: active.preset_name,
			},
			historyCount: body.history_count ?? 0,
		};
	}
	return {
		active: active.uploaded_at
			? {
					kind: "upload",
					uploadedAt: active.uploaded_at,
					sizeBytes: active.size_bytes ?? 0,
					durationSeconds: active.duration_seconds ?? 0,
				}
			: null,
		historyCount: body.history_count ?? 0,
	};
}

/**
 * Fetch the list of pre-provided voice presets (CONTRACT §2).
 * Free (no charge). Client may cache for ~1h (Cache-Control hint).
 */
export async function getRefAudioPresets(): Promise<RefAudioPreset[]> {
	const headers = await authHeader();
	let res: Response;
	try {
		res = await fetch(`${LAB_GATEWAY_URL}/v1/ref-audio/presets`, { headers });
	} catch (err) {
		Logger.warn(TAG, "presets GET network error", { error: String(err) });
		throw new RefAudioApiError("network", 0, String(err));
	}
	if (!res.ok) {
		const body = await readErrorBody(res);
		throw new RefAudioApiError(
			mapErrorCode(res.status, body),
			res.status,
			`GET /v1/ref-audio/presets failed (${res.status})`,
			body,
		);
	}
	const body = (await res.json()) as {
		presets?: Array<{
			id?: string;
			name?: string;
			description?: string;
			locale?: string;
			gender?: string;
			age_range?: string;
			duration_seconds?: number;
			sample_url?: string;
			sample_format?: string;
			sample_sha256?: string;
			source?: string;
			license?: string;
		}>;
	};
	return (body.presets ?? [])
		.filter((p) => p.id && p.sample_url)
		.map((p) => ({
			id: p.id as string,
			name: p.name ?? (p.id as string),
			description: p.description,
			locale: p.locale ?? "",
			gender: p.gender,
			ageRange: p.age_range,
			durationSeconds: p.duration_seconds ?? 0,
			// The gateway still hands out legacy GCS sample URLs; normalize to the
			// canonical Azure host here (single choke point) so browse, preview,
			// apply and the persisted voiceRefUrl all use Azure.
			sampleUrl: canonicalRefAudioUrl(p.sample_url as string),
			sampleFormat: p.sample_format ?? "wav",
			sampleSha256: p.sample_sha256,
			source: p.source ?? "",
			license: p.license ?? "",
		}));
}

/**
 * Select a preset as the active reference voice (CONTRACT §3).
 * Free (no charge), idempotent. Returns the applied preset metadata.
 */
export async function applyRefAudioPreset(
	presetId: string,
): Promise<{ presetId: string; presetName: string; appliedAt: string }> {
	const headers: Record<string, string> = {
		...(await authHeader()),
		"Content-Type": "application/json",
	};
	let res: Response;
	try {
		res = await fetch(`${LAB_GATEWAY_URL}/v1/ref-audio/preset`, {
			method: "POST",
			headers,
			body: JSON.stringify({ preset_id: presetId }),
		});
	} catch (err) {
		Logger.warn(TAG, "preset POST network error", { error: String(err) });
		throw new RefAudioApiError("network", 0, String(err));
	}
	if (!res.ok) {
		const body = await readErrorBody(res);
		throw new RefAudioApiError(
			mapErrorCode(res.status, body),
			res.status,
			`POST /v1/ref-audio/preset failed (${res.status})`,
			body,
		);
	}
	const data = (await res.json()) as {
		active?: { preset_id?: string; name?: string; applied_at?: string };
	};
	Logger.info(TAG, "preset applied", { presetId: data.active?.preset_id });
	return {
		presetId: data.active?.preset_id ?? presetId,
		presetName: data.active?.name ?? "",
		appliedAt: data.active?.applied_at ?? new Date().toISOString(),
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

/**
 * Stream the user's active *uploaded* ref-audio back as a WAV blob for
 * in-app preview (GET /v1/ref-audio/content). Free (no charge).
 *
 * Only valid when the active slot is an upload — presets store no GCS blob,
 * so the gateway returns 404 `no-active-ref` for them; callers must preview
 * presets via their `sampleUrl` instead. Throws `RefAudioApiError` with code
 * `no-active-ref` (404), `unauthenticated` (401), or `network`/`unknown`.
 */
export async function getRefAudioContent(): Promise<Blob> {
	const headers = await authHeader();
	let res: Response;
	try {
		res = await fetch(`${LAB_GATEWAY_URL}/v1/ref-audio/content`, { headers });
	} catch (err) {
		Logger.warn(TAG, "ref-audio content network error", { error: String(err) });
		throw new RefAudioApiError("network", 0, String(err));
	}
	if (!res.ok) {
		const body = await readErrorBody(res);
		throw new RefAudioApiError(
			mapErrorCode(res.status, body),
			res.status,
			`GET /v1/ref-audio/content failed (${res.status})`,
			body,
		);
	}
	return res.blob();
}
