/**
 * Configuration resolver, TtsProviderMeta definition, and end-to-end AudioQueue +
 * Avatar Lip-Sync session factory for the Azure AI Speech + Viseme TTS module.
 */

import type { AudioPlaybackClock } from "../avatar/nva-speech/speech-timing";
import {
	type AudioQueueItemCallbacks,
	PcmStreamSource,
} from "../voice/audio-queue";
import {
	type AzureSpeechAdapterConfig,
	type AzureSpeechMode,
	type AzureSpeechSynthesisResult,
	type AzureSpeechSynthesizeRequest,
	AzureSpeechTtsAdapter,
} from "./azure-speech-tts";
import {
	type AvatarLipSyncFrame,
	AzureVisemeTimelineDriver,
	type AzureVisemeTimelineDriverOptions,
} from "./azure-speech-viseme";
import { AZURE_SPEECH_VOICE_PRESETS } from "./azure-speech-voices";
import { registerTtsProviderMeta } from "./registry";
import type { TtsProviderMeta, TtsVoiceMeta } from "./types";

export const AZURE_SPEECH_PROVIDER_ID = "azure-speech" as const;

/** Static `TtsProviderMeta` descriptor for settings UI & dynamic provider registration. */
export const AZURE_SPEECH_TTS_PROVIDER_META: TtsProviderMeta = {
	id: AZURE_SPEECH_PROVIDER_ID,
	name: "Azure AI Speech (Viseme HD)",
	description:
		"Azure 크레딧 기반 무제한 동시 스트리밍 TTS + 실시간 Viseme(0~21) 아바타 입모양 동기화",
	requiresApiKey: false,
	requiresNaiaKey: true,
	isClientSide: true,
	pricing: "$16/1M chars (Azure Credit)",
	voices: AZURE_SPEECH_VOICE_PRESETS.map(
		(preset): TtsVoiceMeta => ({
			id: preset.id,
			label: preset.label,
			language: preset.language,
			gender: preset.gender,
		}),
	),
	fetchVoices: async (
		credentialHint: string,
	): Promise<TtsVoiceMeta[] | null> => {
		const trimmed = credentialHint.trim();
		if (!trimmed) return null;
		// Supports `<region>:<subscriptionKey>` format for direct voice list discovery.
		const sep = trimmed.indexOf(":");
		if (sep <= 0) return null;
		const region = trimmed.slice(0, sep).trim();
		const key = trimmed.slice(sep + 1).trim();
		if (!region || !key) return null;
		try {
			const resp = await fetch(
				`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
				{
					headers: { "Ocp-Apim-Subscription-Key": key },
				},
			);
			if (!resp.ok) return null;
			const list = (await resp.json()) as Array<{
				ShortName?: string;
				LocalName?: string;
				DisplayName?: string;
				Locale?: string;
				Gender?: string;
			}>;
			if (!Array.isArray(list)) return null;
			return list
				.filter((item) => Boolean(item.ShortName))
				.map((item) => {
					const g = (item.Gender ?? "").toLowerCase();
					return {
						id: item.ShortName as string,
						label:
							item.LocalName || item.DisplayName || (item.ShortName as string),
						language: item.Locale,
						gender:
							g === "male" ? "male" : g === "female" ? "female" : "neutral",
					};
				});
		} catch {
			return null;
		}
	},
};

/**
 * Opt-in registration helper that adds `azure-speech` to `naia-shell`'s
 * `tts/registry` without mutating default registry order at module import time.
 */
export function registerAzureSpeechTtsProvider(): TtsProviderMeta {
	registerTtsProviderMeta(AZURE_SPEECH_TTS_PROVIDER_META);
	return AZURE_SPEECH_TTS_PROVIDER_META;
}

export interface AzureSpeechConfigInput extends AzureSpeechAdapterConfig {
	/** Optional HTTP endpoint returning `{ token, region? }` or plain-text short-lived STS token. */
	tokenEndpointUrl?: string;
}

function readEnvMap(
	explicitEnv?: Record<string, string | undefined>,
): Record<string, string | undefined> {
	if (explicitEnv) return explicitEnv;
	const metaEnv = (
		import.meta as unknown as { env?: Record<string, string | undefined> }
	).env;
	if (metaEnv && typeof metaEnv === "object") return metaEnv;
	if (typeof process !== "undefined" && process.env) return process.env;
	return {};
}

/**
 * Resolve `AzureSpeechAdapterConfig` from explicit runtime settings and
 * optional `VITE_AZURE_SPEECH_*` / `VITE_NAIA_GATEWAY_URL` environment variables.
 */
export function resolveAzureSpeechConfig(
	input: AzureSpeechConfigInput = {},
	envOverride?: Record<string, string | undefined>,
): AzureSpeechAdapterConfig {
	const env = readEnvMap(envOverride);
	const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);

	const gatewayUrl = (
		input.gatewayUrl ??
		env.VITE_NAIA_GATEWAY_URL ??
		env.NAIA_GATEWAY_URL ??
		""
	)
		.trim()
		.replace(/\/+$/, "");

	const naiaKey = (input.naiaKey ?? env.VITE_NAIA_KEY ?? "").trim();
	const region = (
		input.region ??
		env.VITE_AZURE_SPEECH_REGION ??
		env.AZURE_SPEECH_REGION ??
		""
	).trim();

	const wsEndpointUrl = (
		input.wsEndpointUrl ??
		env.VITE_AZURE_SPEECH_WS_ENDPOINT ??
		""
	).trim();

	const restEndpointUrl = (
		input.restEndpointUrl ??
		env.VITE_AZURE_SPEECH_REST_ENDPOINT ??
		""
	).trim();

	const tokenEndpointUrl = (
		input.tokenEndpointUrl ??
		env.VITE_AZURE_SPEECH_TOKEN_URL ??
		""
	).trim();

	const rawMode = (
		input.mode ??
		(env.VITE_AZURE_SPEECH_MODE as AzureSpeechMode | undefined) ??
		"auto"
	).trim() as AzureSpeechMode;

	const mode: AzureSpeechMode =
		rawMode === "websocket" || rawMode === "rest" || rawMode === "gateway"
			? rawMode
			: "auto";

	let getAuthToken = input.getAuthToken;
	if (!getAuthToken && tokenEndpointUrl) {
		getAuthToken = async (signal?: AbortSignal): Promise<string> => {
			const headers: Record<string, string> = {};
			if (naiaKey) {
				headers["X-AnyLLM-Key"] = `Bearer ${naiaKey}`;
			}
			const resp = await fetchImpl(tokenEndpointUrl, {
				method: "POST",
				headers,
				signal,
			});
			if (!resp.ok) {
				throw new Error(
					`Azure Speech token endpoint failed (${resp.status}): ${resp.statusText}`,
				);
			}
			const ctype = (resp.headers?.get("content-type") ?? "").toLowerCase();
			if (ctype.includes("application/json")) {
				const body = (await resp.json()) as {
					token?: string;
					access_token?: string;
				};
				const tok = (body.token ?? body.access_token ?? "").trim();
				if (!tok) throw new Error("Token endpoint JSON missing `token`");
				return tok;
			}
			const textToken = (await resp.text()).trim();
			if (!textToken) throw new Error("Token endpoint returned empty body");
			return textToken;
		};
	}

	return {
		...input,
		mode,
		region: region || undefined,
		gatewayUrl: gatewayUrl || undefined,
		naiaKey: naiaKey || undefined,
		wsEndpointUrl: wsEndpointUrl || undefined,
		restEndpointUrl: restEndpointUrl || undefined,
		getAuthToken,
		fetchImpl,
	};
}

export interface AzureSpeechStreamingUtterance {
	/** Live PCM stream ready for `AudioQueue.enqueueStreamOrdered(seq, utterance.pcmStream, utterance.queueCallbacks)`. */
	pcmStream: PcmStreamSource;
	/** Per-utterance timeline driver bound to `AudioPlaybackClock`. */
	visemeDriver: AzureVisemeTimelineDriver;
	/** Pre-wired `AudioQueueItemCallbacks` starting/stopping lip-sync strictly on audio clock events. */
	queueCallbacks: AudioQueueItemCallbacks;
	/** Resolves when synthesis finishes assembling WAV/MP3, cost, and NVA `SpeechPlan`. */
	result: Promise<AzureSpeechSynthesisResult>;
	/** Cancel this specific utterance immediately and reset its lip-sync driver. */
	abort: () => void;
}

export interface AzureSpeechProviderSessionOptions
	extends AzureSpeechConfigInput {
	driverOptions?: Omit<
		AzureVisemeTimelineDriverOptions,
		"onFrame" | "onTalkingChange"
	>;
	/** Invoked on each synchronized avatar lip-sync frame (`mouthOpen`, `vrmWeights`, `talking`, `visemeId`). */
	onLipSyncFrame?: (frame: AvatarLipSyncFrame) => void;
	/** Invoked when avatar `talking` state changes (`useAvatarStore.getState().setSpeaking(talking)`). */
	onSpeakingChange?: (talking: boolean) => void;
}

export interface AzureSpeechProviderSession {
	readonly adapter: AzureSpeechTtsAdapter;
	/** Start a streaming synthesis + synchronized lip-sync utterance. */
	speakStream(
		request: Omit<AzureSpeechSynthesizeRequest, "pcmStream" | "visemeDriver">,
		extraQueueCallbacks?: AudioQueueItemCallbacks,
	): AzureSpeechStreamingUtterance;
	/** Abort all active utterances and immediately reset avatar mouth state to idle. */
	interruptAll(): void;
}

/**
 * Factory creating a complete Azure AI Speech + Real-Time Viseme session controller
 * wired to `PcmStreamSource`, `AudioPlaybackClock`, and Naia Avatar callbacks.
 */
export function createAzureSpeechTtsProvider(
	options: AzureSpeechProviderSessionOptions = {},
): AzureSpeechProviderSession {
	const resolvedConfig = resolveAzureSpeechConfig(options);
	const adapter = new AzureSpeechTtsAdapter(resolvedConfig);
	const activeAborters = new Set<() => void>();

	return {
		adapter,
		speakStream(request, extraQueueCallbacks = {}) {
			const controller = new AbortController();
			const onExternalAbort = () => controller.abort();
			if (request.signal) {
				if (request.signal.aborted) {
					controller.abort();
				} else {
					request.signal.addEventListener("abort", onExternalAbort, {
						once: true,
					});
				}
			}

			const pcmStream = new PcmStreamSource(24000);
			const visemeDriver = new AzureVisemeTimelineDriver({
				...options.driverOptions,
				onFrame: options.onLipSyncFrame,
				onTalkingChange: options.onSpeakingChange,
			});

			const cleanupAborter = () => {
				request.signal?.removeEventListener("abort", onExternalAbort);
				activeAborters.delete(abortUtterance);
			};

			const abortUtterance = () => {
				cleanupAborter();
				controller.abort();
				pcmStream.fail();
				visemeDriver.reset();
			};
			activeAborters.add(abortUtterance);

			const queueCallbacks: AudioQueueItemCallbacks = {
				...extraQueueCallbacks,
				onPlaybackStart: (playback: AudioPlaybackClock) => {
					visemeDriver.start(playback.clock);
					extraQueueCallbacks.onPlaybackStart?.(playback);
				},
				onPlaybackEnd: () => {
					visemeDriver.stop();
					cleanupAborter();
					extraQueueCallbacks.onPlaybackEnd?.();
				},
				onPlaybackFailure: () => {
					visemeDriver.stop();
					cleanupAborter();
					extraQueueCallbacks.onPlaybackFailure?.();
				},
				onPlaybackUnavailable: () => {
					visemeDriver.stop();
					cleanupAborter();
					extraQueueCallbacks.onPlaybackUnavailable?.();
				},
			};

			const result = adapter
				.synthesize({
					...request,
					signal: controller.signal,
					pcmStream,
					visemeDriver,
				})
				.finally(() => {
					request.signal?.removeEventListener("abort", onExternalAbort);
				});

			return {
				pcmStream,
				visemeDriver,
				queueCallbacks,
				result,
				abort: abortUtterance,
			};
		},
		interruptAll() {
			for (const abortFn of [...activeAborters]) {
				abortFn();
			}
			activeAborters.clear();
		},
	};
}
