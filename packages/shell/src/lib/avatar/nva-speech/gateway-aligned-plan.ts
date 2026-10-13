/**
 * Aligned plan source for Shell TTS sound (naia-shell#760, naia.land#104).
 *
 * The Shell sends the exact WAV bytes it is about to play plus the spoken
 * sentence to the gateway route the studio already uses
 * (POST /v1/studio/speech-plan, source kind `shell_audio`): MFA alignment and
 * the 13-unit PHONE_MAP happen there. The Shell never makes a plan itself.
 *
 * A reply is accepted only when it is an `aligned` plan that passes the
 * canonical validator and is bound to this sound (sha256 + duration) and this
 * sentence. Anything else resolves null and the avatar keeps its idle clip.
 * Korean first (RQ-15 5): the gateway aligner is Korean-only, so sentences
 * without Hangul are not sent.
 */
import type {
	AlignedSpeechPlanRequest,
	AlignedSpeechPlanSource,
	SpeechPlan,
} from "./speech-timing";
import { validateSpeechPlan } from "./vendor/speech-plan.js";

export interface GatewayAlignedPlanConfig {
	gatewayUrl?: string;
	naiaKey?: string;
}

export interface GatewayAlignedPlanOptions {
	getConfig: () => GatewayAlignedPlanConfig | null | undefined;
	fetchImpl?: typeof fetch;
	/** Gives up after this long; the sound then plays without a mouth plan. */
	timeoutMs?: number;
}

export const GATEWAY_PLAN_TIMEOUT_MS = 8000;
const HANGUL = /[가-힣]/;

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

function isRiffWave(bytes: Uint8Array): boolean {
	const tag = (offset: number) =>
		String.fromCharCode(...bytes.subarray(offset, offset + 4));
	return bytes.length >= 44 && tag(0) === "RIFF" && tag(8) === "WAVE";
}

export function createGatewayAlignedPlanSource(
	options: GatewayAlignedPlanOptions,
): AlignedSpeechPlanSource {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	const timeoutMs = options.timeoutMs ?? GATEWAY_PLAN_TIMEOUT_MS;

	return async (request: AlignedSpeechPlanRequest): Promise<SpeechPlan | null> => {
		// Only a whole, known sound can be aligned before it plays.
		if (request.audio.kind !== "whole") return null;
		const text = request.text.trim();
		if (!text || !HANGUL.test(text)) return null;
		const config = options.getConfig();
		const base = config?.gatewayUrl?.replace(/\/$/, "");
		if (!base || !config?.naiaKey) return null;

		const bytes = base64ToBytes(request.audio.audioBase64);
		if (!isRiffWave(bytes)) return null;
		const audioSha = await sha256Hex(bytes);

		const controller = new AbortController();
		const onAbort = () => controller.abort();
		request.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetchImpl(
				`${base}/v1/studio/speech-plan?wait=true`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-AnyLLM-Key": `Bearer ${config.naiaKey}`,
					},
					body: JSON.stringify({
						source: {
							kind: "shell_audio",
							id: audioSha.slice(0, 16),
							audio_base64: request.audio.audioBase64,
						},
						text,
						wait: true,
					}),
					signal: controller.signal,
				},
			);
			if (!response.ok) return null;
			const body = (await response.json()) as { plan?: SpeechPlan };
			const plan = body?.plan;
			if (!plan || plan.quality_mode !== "aligned") return null;
			if (!validateSpeechPlan(plan).ok) return null;
			if (plan.audio?.sha256 !== audioSha || plan.text !== text) return null;
			const seconds = request.audio.durationSeconds;
			if (
				seconds != null &&
				Math.abs(plan.audio.duration_us - seconds * 1_000_000) > 50_000
			)
				return null;
			return plan;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", onAbort);
		}
	};
}
