/**
 * Voice Reference Audio section for SettingsTab.
 *
 * Lets a signed-in user set the voice Naia Omni clones for realtime-voice
 * replies. Three sources, all on one screen (no tabs):
 *   1. "Current voice" card — shows the active ref (upload or preset) with
 *      in-app preview (▶) and remove.
 *   2. "Make your voice" — record in-app (🎤, 5–30 s) OR upload a file. Both
 *      go through the gateway POST /v1/ref-audio ($0.01 each).
 *   3. Presets — collapsible (<details>, lazy-loaded on open).
 *
 * The realtime proxy picks the active ref up automatically on every
 * /v1/realtime connect — see naia-anyllm@69d133f / naia-model-infra@43dfa82.
 *
 * Plan SoT: alpha-adk/.agents/progress/ref-audio-service-plan-2026-05-29.md §7.
 * Inline ko/en strings — full 14-language i18n is deferred to a follow-up.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	DEFAULT_VOICE_REF_URL,
	canonicalRefAudioUrl,
	loadConfig,
	saveConfig,
} from "../lib/config";
import { SteamPurchaseModal } from "./SteamPurchaseModal";
import { formatCreditsFromUsd } from "../lib/credits";
import {
	isSteamChannelNow,
	paymentLinksHiddenNow,
	useIsSteamChannel,
	usePaymentLinksHidden,
} from "../lib/distribution";
import { getLocale, t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import { warmLocalVoice } from "../lib/tts/synthesize";
import { fetchLocalVoiceHealth } from "../lib/voice/local-runtime";
import { encodeRefAudio } from "../lib/voice/ref-audio";
import {
	type RefAudioActive,
	RefAudioApiError,
	type RefAudioPreset,
	applyRefAudioPreset,
	deleteRefAudio,
	getLocalRefAudioB64,
	getRefAudioContent,
	getRefAudioPresets,
	getRefAudioStatus,
	hydrateLocalRefAudioB64,
	clearLocalRefAudio,
	persistLocalRefAudioB64,
	uploadRefAudio,
} from "../lib/voice/ref-audio-api";
import {
	type RefRecording,
	startRefRecording,
} from "../lib/voice/ref-recorder";
import { useCascadeAvatarStore } from "../stores/cascade-avatar";

const TAG = "RefAudioSection";
const MIN_DURATION_S = 5;
const MAX_DURATION_S = 30;

/**
 * Persist the active voice-reference preset URL into AppConfig so the realtime
 * voice session (ChatArea) sends it directly as `ref_audio_url` — the
 * deterministic source the web demo uses. Pass null on upload/remove so an
 * uploaded voice (injected server-side from GCS) is not shadowed by a preset.
 */
function setConfigVoiceRefUrl(url: string | null): void {
	const c = loadConfig();
	if (c) saveConfig({ ...c, voiceRefUrl: url ?? undefined });
	// Notify a live voice session (ChatArea) to switch the cloned voice now,
	// without a reconnect (web-demo parity). No-op if no session is active.
	window.dispatchEvent(new CustomEvent("naia:voice-ref-url", { detail: url }));
	// cascade(NVA) 경로에도 즉시 반영 — PUT /voice 계약(2026-07-16 합의). 프리셋 URL 일 때만
	// 민다(업로드/제거 = null 은 게이트웨이 주입 경로라 cascade 로 보낼 URL 이 없음 — 서버 활성
	// 음성 유지). 렌더러 미연결이면 no-op — 연결 시점(VideoAvatarCanvas)이 다시 민다.
	if (url) void useCascadeAvatarStore.getState().renderer?.setVoice(url);
}



/**
 * 이 화면의 문구.
 *
 * 예전에는 여기 ko/en 두 벌짜리 표가 있었고 `getLocale() === "ko"` 로
 * 골랐다. 셸은 로케일이 열넷인데 이 표는 둘뿐이라, 나머지 열두 언어
 * 사용자는 이 화면에서 무조건 영어를 봤다. 그런 표는 locales/ 밖에 있어서
 * i18n 게이트에도 걸리지 않았다.
 *
 * 지금은 전부 locales/ 의 `voice.ref.*` 키를 지난다. 반환 모양은 예전과
 * 같게 두어 부르는 쪽을 건드리지 않았다.
 */
function pickStrings() {
	return {
		sectionTitle: t("voice.ref.sectionTitle"),
		hint: t("voice.ref.hint"),
		currentTitle: t("voice.ref.currentTitle"),
		statusNone: t("voice.ref.statusNone"),
		statusActiveUpload: (duration: string, kb: string, when: string) =>
			t("voice.ref.statusActiveUpload", { duration, kb, when }),
		statusUploadRestored: t("voice.ref.statusUploadRestored"),
		presetActiveLabel: (name: string) =>
			t("voice.ref.presetActiveLabel", { name }),
		previewBtn: t("voice.ref.previewBtn"),
		previewStop: t("voice.ref.previewStop"),
		previewLoading: t("voice.ref.previewLoading"),
		removeBtn: t("voice.ref.removeBtn"),
		confirmRemove: t("voice.ref.confirmRemove"),
		confirmYes: t("voice.ref.confirmYes"),
		confirmNo: t("voice.ref.confirmNo"),
		myVoiceTitle: t("voice.ref.myVoiceTitle"),
		recordBtn: t("voice.ref.recordBtn"),
		recordStop: t("voice.ref.recordStop"),
		recording: (seconds: string) => t("voice.ref.recording", { seconds }),
		recordTooShort: t("voice.ref.recordTooShort", { min: MIN_DURATION_S }),
		recordCancel: t("voice.ref.recordCancel"),
		takeReady: (seconds: string) => t("voice.ref.takeReady", { seconds }),
		takeApply: t("voice.ref.takeApply"),
		takeApplyFree: t("voice.ref.takeApplyFree"),
		takeDiscard: t("voice.ref.takeDiscard"),
		uploadBtn: t("voice.ref.uploadBtn"),
		replaceBtn: t("voice.ref.replaceBtn"),
		uploading: t("voice.ref.uploading"),
		cost: t("voice.ref.cost"),
		costLocal: t("voice.ref.costLocal"),
		localEngineOff: t("voice.ref.localEngineOff"),
		localEngineStarting: t("voice.ref.localEngineStarting"),
		localEngineStart: t("voice.ref.localEngineStart"),
		localEngineOffToggleHint: t("voice.ref.localEngineOffToggleHint"),
		err: {
			network: t("voice.ref.errNetwork"),
			auth: t("voice.ref.errAuth"),
			creditInsufficient: t(
				isSteamChannelNow()
					? "voice.ref.errCreditInsufficientSteam"
					: paymentLinksHiddenNow()
						? "voice.ref.errCreditInsufficientNoTopup"
						: "voice.ref.errCreditInsufficient",
			),
			format: t("voice.ref.errFormat"),
			tooLarge: t("voice.ref.errTooLarge"),
			uploadInProgress: t("voice.ref.errUploadInProgress"),
			soldOut: t("voice.ref.errSoldOut"),
			noActiveRef: t("voice.ref.errNoActiveRef"),
			record: t("voice.ref.errRecord"),
			unknown: t("voice.ref.errUnknown"),
		},
		uploadSuccess: (balance: string) =>
			t("voice.ref.uploadSuccess", { balance }),
		localRefApplied: t("voice.ref.localRefApplied"),
		removeSuccess: t("voice.ref.removeSuccess"),
		presetTitle: t("voice.ref.presetTitle"),
		presetLoading: t("voice.ref.presetLoading"),
		presetEmpty: t("voice.ref.presetEmpty"),
		presetPlay: t("voice.ref.presetPlay"),
		presetStop: t("voice.ref.presetStop"),
		presetApply: t("voice.ref.presetApply"),
		presetApplied: t("voice.ref.presetApplied"),
		presetApplySuccess: (name: string) =>
			t("voice.ref.presetApplySuccess", { name }),
		presetFilterAll: t("voice.ref.presetFilterAll"),
		presetFemale: t("voice.ref.presetFemale"),
		presetMale: t("voice.ref.presetMale"),
		presetDefault: t("voice.ref.presetDefault"),
		presetNotFound: t("voice.ref.presetNotFound"),
	};
}

/** Decode a raw base64 WAV (as produced by encodeRefAudio) into a Blob. */
function b64ToWavBlob(b64: string): Blob {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new Blob([bytes], { type: "audio/wav" });
}

function formatDate(iso: string): string {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

function formatBalance(balanceUsd: number): string {
	// Gateway reports the balance in USD; the app shows credits (1 credit = $0.001).
	return formatCreditsFromUsd(balanceUsd);
}

/** cc0-ko-female-01 → "여성 음색 1" — human name for a catalog file id, so the
 *  active card never shows a raw asset filename to the user. */
function humanizeCc0Id(
	id: string,
	S: ReturnType<typeof pickStrings>,
): string {
	const m = /^cc0-ko-(female|male)-0*(\d+)$/i.exec(id);
	if (!m) return id;
	const family = m[1].toLowerCase() === "male" ? S.presetMale : S.presetFemale;
	return `${family} ${m[2]}`;
}

function displayPresetName(
	preset: RefAudioPreset,
	S: ReturnType<typeof pickStrings>,
): string {
	if (preset.source !== "local-runtime") return preset.name;
	if (preset.gender !== "male" && preset.gender !== "female") {
		return preset.name;
	}
	const family = preset.gender === "male" ? S.presetMale : S.presetFemale;
	const index = preset.localIndex ? ` ${preset.localIndex}` : "";
	const suffix = preset.isDefault ? ` · ${S.presetDefault}` : "";
	return `${family}${index}${suffix}`;
}

function describeError(
	err: unknown,
	S: ReturnType<typeof pickStrings>,
): string {
	if (err instanceof RefAudioApiError) {
		switch (err.code) {
			case "network":
				return S.err.network;
			case "unauthenticated":
				return S.err.auth;
			case "credit-insufficient":
				return S.err.creditInsufficient;
			case "invalid-audio-format":
			case "duration-out-of-range":
				return S.err.format;
			case "file-too-large":
				return S.err.tooLarge;
			case "upload-in-progress":
				return S.err.uploadInProgress;
			case "sold-out":
				return S.err.soldOut;
			case "no-active-ref":
				return S.err.noActiveRef;
			case "preset-not-found":
				return S.presetNotFound;
			default:
				return S.err.unknown;
		}
	}
	return S.err.unknown;
}

interface RefAudioSectionProps {
	ensureLocalVoiceReady?: () => Promise<boolean>;
	/** SettingsTab already renders the engine start/stop toggle directly above
	 *  this section, so the inline engine-off start button here is a confusing
	 *  duplicate ("왜 시작 버튼이 두 개?"). When true, the off-state becomes an
	 *  informational hint pointing to that single toggle instead. */
	hideEngineStartControl?: boolean;
}

export function RefAudioSection({
	ensureLocalVoiceReady,
	hideEngineStartControl,
}: RefAudioSectionProps = {}) {
	// 로케일이 그대로면 같은 객체를 돌려준다. 예전 구현은 고정된 ko/en 표를
	// 그대로 반환해 참조가 안정적이었는데, t() 기반으로 바꾸면서 렌더마다
	// 새 객체가 되었다. S 는 훅 일곱 곳의 의존성이라 그대로 두면 렌더가
	// 끝없이 되풀이된다 — 실제로 테스트가 그 자리에서 멈췄다.
	const paymentLinksHidden = usePaymentLinksHidden();
	const isSteam = useIsSteamChannel();
	const S = useMemo(pickStrings, [getLocale(), paymentLinksHidden, isSteam]);
	// Naia Local runs on the user's own GPU — recording/uploading a reference
	// voice is free and never touches the gateway, so hide the $0.01 hints.
	const config = loadConfig();
	const isLocal = config?.ttsProvider === "naia-local-voice";
	// The persisted facade URL is available before the local runtime has finished
	// starting. Subscribe to CASCADE_READY so a failed initial request is retried
	// against the live facade as soon as it becomes available.
	const runtimeLocalFacadeUrl = useCascadeAvatarStore(
		(state) => state.localFacadeUrl,
	);
	const localVoiceHost = runtimeLocalFacadeUrl?.trim() || config?.vllmTtsHost;
	const [active, setActive] = useState<RefAudioActive | null>(null);
	const [loading, setLoading] = useState(true);
	// FR-VOICE.14 (#418): readiness is the façade /health verdict, not a
	// reachable port. "off" and "starting" render explicit states instead of a
	// generic network error, so a not-running engine is never a silent wait.
	const [localEngine, setLocalEngine] = useState<
		"unknown" | "off" | "starting" | "ready"
	>("unknown");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>("");
	const [steamPurchaseModalOpen, setSteamPurchaseModalOpen] = useState(false);
	const [notice, setNotice] = useState<string>("");
	const [confirmingRemove, setConfirmingRemove] = useState(false);

	// Recording state.
	const [recording, setRecording] = useState(false);
	const [recElapsed, setRecElapsed] = useState(0);
	const recorderRef = useRef<RefRecording | null>(null);

	// A finished take held for review (record -> preview -> apply/discard).
	// Not uploaded until the user confirms, so they can listen first.
	const [recordedTake, setRecordedTake] = useState<{
		blob: Blob;
		durationSeconds: number;
		url: string;
	} | null>(null);
	const [takePlaying, setTakePlaying] = useState(false);

	// Preview (active card) — shared <audio> element, tracked objectURL.
	const [previewState, setPreviewState] = useState<
		"idle" | "loading" | "playing"
	>("idle");
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const objectUrlRef = useRef<string | null>(null);

	// Presets (collapsible, lazy-loaded).
	const [presets, setPresets] = useState<RefAudioPreset[] | null>(null);
	const [presetsLoading, setPresetsLoading] = useState(false);
	const [playingPresetId, setPlayingPresetId] = useState<string | null>(null);
	const [genderFilter, setGenderFilter] = useState<string>("all");

	const refresh = useCallback(async () => {
		// The selected ADK owns the clip; hydrate the synchronous synthesis cache
		// before deciding which voice card is active.
		try {
			await hydrateLocalRefAudioB64();
		} catch (err) {
			Logger.warn(TAG, "ADK reference audio hydration failed", {
				error: String(err),
			});
		}
		// A Naia Local recorded clip lives only in localStorage (no gateway slot) —
		// reflect it directly so the card matches the voice actually being sent.
		if (isLocal) {
			// #429: 업로드/녹음된 로컬 레퍼런스가 있으면 그것이 활성 음성이다.
			// 프리셋 매칭이 이를 덮으면 ① 미리듣기가 기본 프리셋을 재생하고
			// ② setConfigVoiceRefUrl 이 업로드 선택을 프리셋으로 되돌려 쓴다.
			const localUploadB64 = getLocalRefAudioB64();
			Logger.debug(TAG, "refresh:local", {
				hasLocalUpload: !!localUploadB64,
				voiceRefUrl: config?.voiceRefUrl ?? null,
			});
			if (localUploadB64) {
				setActive({
					kind: "upload",
					uploadedAt: "",
					sizeBytes: 0,
					durationSeconds: 0,
				});
			} else {
				// The active card derives from config alone — NEVER from the engine's
				// /ref/voices (that fetch failed whenever the engine was still loading
				// and painted the whole section as "engine off"/network error). The
				// stored voiceRefUrl is the cloud preset the user picked; default to
				// "여성 음색 1" like realtime voice does.
				// canonicalRefAudioUrl: a previously stored GCS sample URL is rewritten
				// to the Azure host (GCP retirement) so preview keeps working.
				const stored = config?.voiceRefUrl
					? canonicalRefAudioUrl(config.voiceRefUrl)
					: "";
				const url = stored || DEFAULT_VOICE_REF_URL;
				if (url !== config?.voiceRefUrl) setConfigVoiceRefUrl(url);
				const name =
					url
						.split(/[?#]/)[0]
						.split(/[/\\]/)
						.pop()
						?.replace(/\.wav$/i, "") ?? "";
				setActive({
					kind: "preset",
					uploadedAt: "",
					sizeBytes: 0,
					durationSeconds: 0,
					presetId: name,
					// Never surface the raw asset id (cc0-ko-female-02) — show the
					// same human name the picker uses ("여성 음색 2").
					presetName: humanizeCc0Id(name, S),
				});
			}
			// Engine state stays informational (start/stop lives in SettingsTab);
			// browse/preview/upload no longer depend on it.
			const health = localVoiceHost
				? await fetchLocalVoiceHealth(localVoiceHost)
				: null;
			Logger.debug(TAG, "refresh:local-engine-health", {
				reachable: health !== null,
				ttsReady: health?.ttsReady ?? false,
			});
			if (health === null) setLocalEngine("off");
			else if (!health.ttsReady) setLocalEngine("starting");
			else setLocalEngine("ready");
			setError("");
			setLoading(false);
			return;
		}
		if (getLocalRefAudioB64()) {
			setActive({
				kind: "upload",
				uploadedAt: "",
				sizeBytes: 0,
				durationSeconds: 0,
			});
			setError("");
			setLoading(false);
			return;
		}
		try {
			const status = await getRefAudioStatus();
			setActive(status.active);
			setError("");
		} catch (err) {
			Logger.warn(TAG, "status fetch failed", { error: String(err) });
			setError(describeError(err, S));
		} finally {
			setLoading(false);
		}
	}, [S, config?.voiceRefUrl, isLocal, localVoiceHost]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const loadPresets = useCallback(async () => {
		if (presets !== null || presetsLoading) return;
		setPresetsLoading(true);
		try {
			// The preset picker is ALWAYS the cloud catalog (public sampleUrl) — for
			// naia-local-voice too. Binding the local picker to the engine's
			// /ref/voices made browse/preview require a running, authenticated engine
			// (모델로드 ~77s), so the picker was empty and preview dead until then —
			// the regression the user hit. The engine is only needed to SPEAK: the
			// picked preset's file basename matches the engine palette id
			// (prepare.ps1 downloads the same CC0 catalog), see naiaLocalVoiceId.
			const list = await getRefAudioPresets();
			Logger.debug(TAG, "loadPresets:result", {
				isLocal,
				count: list.length,
			});
			setPresets(list);
			setError("");
		} catch (err) {
			Logger.warn(TAG, "presets fetch failed", { error: String(err) });
			setError(describeError(err, S));
			setPresets([]);
		} finally {
			setPresetsLoading(false);
		}
	}, [
		presets,
		presetsLoading,
		S,
		isLocal,
		localVoiceHost,
		ensureLocalVoiceReady,
	]);

	// Stop any playback + free objectURL + abort a live recording on unmount.
	const stopPlayback = useCallback(() => {
		if (audioRef.current) {
			audioRef.current.pause();
			audioRef.current = null;
		}
		if (objectUrlRef.current) {
			URL.revokeObjectURL(objectUrlRef.current);
			objectUrlRef.current = null;
		}
		setPreviewState("idle");
		setPlayingPresetId(null);
		setTakePlaying(false);
	}, []);

	useEffect(() => {
		return () => {
			stopPlayback();
			recorderRef.current?.cancel();
			recorderRef.current = null;
		};
	}, [stopPlayback]);

	// Free the held-take objectURL when it's replaced or on unmount.
	useEffect(() => {
		return () => {
			if (recordedTake) URL.revokeObjectURL(recordedTake.url);
		};
	}, [recordedTake]);

	/** Play a URL through the shared <audio>; `revoke` frees it when done. */
	const playUrl = useCallback(
		(url: string, revoke: boolean, onStop: () => void) => {
			stopPlayback();
			const audio = new Audio(url);
			audio.preload = "none";
			const done = () => {
				if (revoke) {
					URL.revokeObjectURL(url);
					if (objectUrlRef.current === url) objectUrlRef.current = null;
				}
				onStop();
			};
			audio.onended = done;
			audio.onerror = () => {
				// Include the URL: a CSP media-src rejection or a dead host fails
				// here with no other signal, and without the URL the log cannot say
				// WHICH source was blocked (logging_principle P1).
				Logger.warn(TAG, "playback failed", {
					url: url.slice(0, 120),
					mediaError: audio.error?.code ?? null,
				});
				done();
			};
			audioRef.current = audio;
			if (revoke) objectUrlRef.current = url;
			void audio.play().catch(() => done());
		},
		[stopPlayback],
	);

	// ── Current-voice preview (active card) ──
	const onPreviewActive = useCallback(async () => {
		if (!active) return;
		if (previewState !== "idle") {
			stopPlayback();
			return;
		}
		setError("");
		try {
			if (active.kind === "preset") {
				// Presets store no GCS blob — the content endpoint 404s for them.
				// Preview via the preset's public sampleUrl. For naia-local-voice the
				// stored voiceRefUrl IS the public sampleUrl, so play it directly —
				// no engine, no cloud round-trip.
				if (isLocal && config?.voiceRefUrl) {
					setPreviewState("playing");
					playUrl(config.voiceRefUrl, false, () => setPreviewState("idle"));
					return;
				}
				const list = presets ?? (await getRefAudioPresets());
				if (presets === null) setPresets(list);
				const p = list.find((x) => x.id === active.presetId);
				if (!p) {
					setError(S.presetNotFound);
					return;
				}
				setPreviewState("playing");
				playUrl(p.sampleUrl, false, () => setPreviewState("idle"));
			} else {
				// Naia Local recorded/uploaded clip lives only in localStorage (no
				// gateway blob to GET) — play the local base64 directly.
				const localB64 = getLocalRefAudioB64();
				if (localB64) {
					const url = URL.createObjectURL(b64ToWavBlob(localB64));
					setPreviewState("playing");
					playUrl(url, true, () => setPreviewState("idle"));
				} else {
					setPreviewState("loading");
					const blob = await getRefAudioContent();
					const url = URL.createObjectURL(blob);
					setPreviewState("playing");
					playUrl(url, true, () => setPreviewState("idle"));
				}
			}
		} catch (err) {
			Logger.warn(TAG, "active preview failed", { error: String(err) });
			setError(describeError(err, S));
			setPreviewState("idle");
		}
	}, [
		active,
		previewState,
		presets,
		playUrl,
		stopPlayback,
		S,
		isLocal,
		localVoiceHost,
	]);

	// ── Upload (file) ──
	const handleUploadBlob = useCallback(
		async (input: Blob, sourceLabel: string) => {
			setBusy(true);
			setError("");
			setNotice("");
			try {
				// Naia Local: the voice WS is direct to the user's own container, so
				// the gateway upload+inject path can't reach it (and would charge
				// $0.01 → the 402 the user hit). Keep the clip locally as base64 and
				// send it straight to the container — no gateway, no credits.
				if (isLocal) {
					// Store the clip locally ONLY — no engine round-trip. The synthesis
					// path (synthNaiaLocalVoice) re-installs the stored base64 onto the
					// runtime on every sentence, so the engine gets the voice exactly
					// when it is needed. Gating the upload on a running, authenticated
					// engine made "업로드 에러" whenever the engine was still loading.
					const b64 = await encodeRefAudio(input);
					Logger.debug(TAG, "handleUploadBlob:local-stored", {
						sourceLabel,
						b64SizeBytes: b64.length,
					});
					await persistLocalRefAudioB64(b64);
					setConfigVoiceRefUrl(null); // recorded voice supersedes a preset
					// Best-effort duration for the card (encodeRefAudio normalises to
					// 16 kHz mono PCM16, so derive it from the WAV data length).
					let durationSeconds = 0;
					try {
						const dataBytes = atob(b64).length - 44; // strip RIFF/WAVE header
						durationSeconds = Math.max(0, dataBytes) / (16000 * 2);
					} catch {
						// non-fatal — leave 0
					}
					setActive({
						kind: "upload",
						uploadedAt: new Date().toISOString(),
						sizeBytes: input.size,
						durationSeconds,
					});
					// Switch a live session now (no reconnect); else applied on connect.
					window.dispatchEvent(
						new CustomEvent("naia:voice-ref-audio", { detail: b64 }),
					);
					setNotice(S.localRefApplied);
					// Prepay the uploaded voice's cold synthesis cost in the background
					// (install current.wav + one short synth) so the first real reply
					// doesn't stall ~40s and get aborted by a follow-up message.
					void warmLocalVoice({ voice: "current", localRefAudioBase64: b64 });
					return;
				}
				const b64 = await encodeRefAudio(input);
				const result = await uploadRefAudio(b64);
				// An upload supersedes any applied preset — clear the preset URL so
				// it never shadows the uploaded voice (gateway injects uploads).
				setConfigVoiceRefUrl(null);
				await persistLocalRefAudioB64(b64);
				// kind:"upload" must be explicit — the active card + replace/remove
				// affordances branch on it, and the gateway would only echo it on a
				// follow-up status GET otherwise.
				setActive({
					kind: "upload",
					uploadedAt: result.uploadedAt,
					sizeBytes: result.sizeBytes,
					durationSeconds: result.durationSeconds,
				});
				setNotice(S.uploadSuccess(formatBalance(result.newBalanceUsd)));
			} catch (err) {
				Logger.warn(TAG, `${sourceLabel} failed`, { error: String(err) });
				setError(describeError(err, S));
			} finally {
				setBusy(false);
			}
		},
		[S, isLocal, ensureLocalVoiceReady, localVoiceHost],
	);

	const onFileInput = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const f = e.target.files?.[0];
			e.target.value = ""; // allow re-pick after a failure
			if (f) void handleUploadBlob(f, "upload");
		},
		[handleUploadBlob],
	);

	// ── Record ──
	const finishRecording = useCallback(() => {
		const rec = recorderRef.current;
		if (!rec) return;
		recorderRef.current = null;
		setRecording(false);
		const { blob, durationSeconds } = rec.stop();
		if (durationSeconds < MIN_DURATION_S) {
			setError(S.recordTooShort);
			return;
		}
		// Hold the take for preview instead of uploading immediately — the user
		// listens (local objectURL, no server round-trip) and applies on confirm.
		setRecordedTake({ blob, durationSeconds, url: URL.createObjectURL(blob) });
	}, [S]);

	const discardTake = useCallback(() => {
		stopPlayback();
		setRecordedTake(null); // the effect revokes the url
	}, [stopPlayback]);

	const onPreviewTake = useCallback(() => {
		if (!recordedTake) return;
		if (takePlaying) {
			stopPlayback();
			return;
		}
		// revoke:false — discardTake / the unmount effect own the url's lifetime.
		playUrl(recordedTake.url, false, () => setTakePlaying(false));
		setTakePlaying(true);
	}, [recordedTake, takePlaying, playUrl, stopPlayback]);

	const applyRecordedTake = useCallback(async () => {
		if (!recordedTake) return;
		stopPlayback();
		// rec.stop() already returns a WAV Blob; encodeRefAudio (inside
		// uploadRefAudio) decodes + resamples to 16kHz on upload.
		await handleUploadBlob(recordedTake.blob, "record");
		setRecordedTake(null);
	}, [recordedTake, handleUploadBlob, stopPlayback]);

	const startRecording = useCallback(async () => {
		setError("");
		setNotice("");
		stopPlayback();
		setRecElapsed(0);
		try {
			const rec = await startRefRecording({
				maxSeconds: MAX_DURATION_S,
				onElapsed: (s) => setRecElapsed(s),
				onAutoStop: () => {
					void finishRecording();
				},
			});
			recorderRef.current = rec;
			setRecording(true);
		} catch (err) {
			Logger.warn(TAG, "record start failed", { error: String(err) });
			setError(S.err.record);
		}
	}, [finishRecording, stopPlayback, S]);

	const cancelRecording = useCallback(() => {
		recorderRef.current?.cancel();
		recorderRef.current = null;
		setRecording(false);
		setRecElapsed(0);
	}, []);

	// ── Presets ──
	const onPreviewPreset = useCallback(
		async (preset: RefAudioPreset) => {
			if (playingPresetId === preset.id) {
				stopPlayback();
				return;
			}
			setError("");
			try {
				// Preview plays the catalog's PUBLIC sampleUrl directly — no engine, no
				// token, no readiness gate. (Routing local preview through the engine's
				// auth-gated /ref/audio made preview dead until the engine finished
				// loading — the regression the user hit.)
				Logger.debug(TAG, "onPreviewPreset:entry", {
					presetId: preset.id,
					isLocal,
				});
				setPlayingPresetId(preset.id);
				playUrl(preset.sampleUrl, false, () => setPlayingPresetId(null));
			} catch (err) {
				Logger.warn(TAG, "preset preview failed", { error: String(err) });
				setPlayingPresetId(null);
				setError(describeError(err, S));
			}
		},
		[playingPresetId, playUrl, stopPlayback, isLocal, S],
	);

	const onApplyPreset = useCallback(
		async (preset: RefAudioPreset) => {
			const displayName = displayPresetName(preset, S);
			setBusy(true);
			setError("");
			setNotice("");
			// Persist the picked preset's public sampleUrl FIRST so realtime voice
			// sends it directly as ref_audio_url (web-demo parity) — even if the
			// server-side apply below fails (e.g. credit/auth on the dev gateway).
			// The voice must not depend on the apply round-trip or GET status.
			// 프리셋은 녹음본을 대체한다. 녹음해 둔 것이 있으면 그것이
			// 사라지므로 먼저 묻는다 — 녹음이 없으면 잃을 것이 없어 묻지
			// 않는다. 모든 선택마다 물으면 사용자는 읽지 않고 누른다.
			if (
				getLocalRefAudioB64() &&
				!globalThis.confirm(t("voice.deleteRefAudioConfirm"))
			)
				return;
			setConfigVoiceRefUrl(preset.sampleUrl);
			try {
				// A preset supersedes a recorded clip. Clearing the ADK copy is
				// best-effort: without a configured ADK path (tests, pre-setup boot)
				// the invoke rejects, and an unhandled rejection here would fail the
				// whole preset selection even though the URL switch above already
				// took effect.
				await clearLocalRefAudio();
			} catch (err) {
				Logger.warn(TAG, "clearing ADK reference audio failed", {
					error: String(err),
				});
			}
			window.dispatchEvent(
				new CustomEvent("naia:voice-ref-audio", { detail: null }),
			);
			try {
				if (isLocal) {
					setActive({
						kind: "preset",
						uploadedAt: new Date().toISOString(),
						sizeBytes: 0,
						durationSeconds: preset.durationSeconds,
						presetId: preset.id,
						presetName: displayName,
					});
					setNotice(S.presetApplySuccess(displayName));
					// Prepay the per-voice cold cost NOW (background) so the first chat
					// reply with this preset is seconds, not ~40s (which reads as
					// "broken" and triggers the abort-retry loop). Fire-and-forget.
					void warmLocalVoice({
						voice: preset.sampleUrl.split("/").pop() ?? "default",
					});
					return;
				}
				const result = await applyRefAudioPreset(preset.id);
				setActive({
					kind: "preset",
					uploadedAt: result.appliedAt,
					sizeBytes: 0,
					durationSeconds: preset.durationSeconds,
					presetId: result.presetId,
					presetName: result.presetName || preset.name,
				});
				setNotice(S.presetApplySuccess(result.presetName || preset.name));
			} catch (err) {
				Logger.warn(TAG, "preset apply failed", { error: String(err) });
				setError(describeError(err, S));
			} finally {
				setBusy(false);
			}
		},
		[S, isLocal],
	);

	// ── Remove (in-app confirm — WebKitGTK double-dialog parity with SettingsTab) ──
	const onRemove = useCallback(async () => {
		setConfirmingRemove(false);
		setBusy(true);
		setError("");
		setNotice("");
		try {
			stopPlayback();
			// Clear local-first so a local-only recorded clip (which has no gateway
			// slot to DELETE) is always removed and the live session reverts.
			const hadLocal = !!getLocalRefAudioB64();
			setConfigVoiceRefUrl(null);
			await clearLocalRefAudio();
			// Don't leave the session unconditioned (weird voice) — switch a live
			// session to the default "여성 음색 1" instead of clearing the ref.
			window.dispatchEvent(
				new CustomEvent("naia:voice-ref-audio", { detail: null }),
			);
			window.dispatchEvent(
				new CustomEvent("naia:voice-ref-url", {
					detail: DEFAULT_VOICE_REF_URL,
				}),
			);
			try {
				await deleteRefAudio();
			} catch (err) {
				// A local-only ref has nothing on the gateway → a 404 here is fine.
				if (!hadLocal) throw err;
				Logger.warn(TAG, "gateway delete skipped (local-only ref)", {
					error: String(err),
				});
			}
			setActive(null);
			setNotice(S.removeSuccess);
		} catch (err) {
			Logger.warn(TAG, "delete failed", { error: String(err) });
			setError(describeError(err, S));
		} finally {
			setBusy(false);
		}
	}, [stopPlayback, S]);

	const visiblePresets = (presets ?? []).filter(
		(p) => genderFilter === "all" || p.gender === genderFilter,
	);

	const previewLabel =
		previewState === "loading"
			? S.previewLoading
			: previewState === "playing"
				? S.previewStop
				: S.previewBtn;

	return (
		<>
			<div className="settings-section-divider">
				<span>{S.sectionTitle}</span>
			</div>
			<div className="settings-field">
				<span className="settings-hint">{S.hint}</span>

				{/* ── Current voice card ── */}
				<div
					className="ref-current-card"
					style={{
						marginTop: 10,
						padding: "10px 12px",
						border: "1px solid var(--border, #333)",
						borderRadius: 8,
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 8,
					}}
				>
					<div style={{ minWidth: 0 }}>
						<div style={{ fontSize: 12, opacity: 0.7 }}>{S.currentTitle}</div>
						<div style={{ marginTop: 2 }}>
							{loading ? (
								<span className="settings-hint">…</span>
							) : !active ? (
								<span className="settings-hint">{S.statusNone}</span>
							) : active.kind === "preset" ? (
								<span>
									{S.presetActiveLabel(
										active.presetName ?? active.presetId ?? "",
									)}
								</span>
							) : active.uploadedAt && active.sizeBytes > 0 ? (
								<span>
									{S.statusActiveUpload(
										active.durationSeconds.toFixed(1),
										Math.round(active.sizeBytes / 1024).toLocaleString(),
										formatDate(active.uploadedAt),
									)}
								</span>
							) : (
								// A restored local upload (page reload) has only the base64
								// blob — no recorded size/time. Rendering the empty metadata
								// showed "0.0초 · 0 KB · Invalid Date"; show the plain label.
								<span>{S.statusUploadRestored}</span>
							)}
						</div>
					</div>
					{active && !confirmingRemove && (
						<div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
							<button
								type="button"
								className="voice-preview-btn"
								disabled={previewState === "loading"}
								onClick={() => void onPreviewActive()}
							>
								{previewLabel}
							</button>
							<button
								type="button"
								className="voice-preview-btn"
								disabled={busy}
								onClick={() => setConfirmingRemove(true)}
							>
								{S.removeBtn}
							</button>
						</div>
					)}
					{active && confirmingRemove && (
						<div
							style={{
								display: "flex",
								gap: 6,
								flexShrink: 0,
								alignItems: "center",
							}}
						>
							<span className="settings-hint">{S.confirmRemove}</span>
							<button
								type="button"
								className="voice-preview-btn"
								disabled={busy}
								onClick={() => void onRemove()}
							>
								{S.confirmYes}
							</button>
							<button
								type="button"
								className="voice-preview-btn"
								onClick={() => setConfirmingRemove(false)}
							>
								{S.confirmNo}
							</button>
						</div>
					)}
				</div>

				{/* Recording and file upload work for both providers. Naia Local keeps
				    the normalized reference WAV on-device and sends it directly to the
				    host voice runtime, so this surface must remain visible in local mode. */}
				<div style={{ marginTop: 12 }}>
					<div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
						{S.myVoiceTitle}
					</div>
					<div
						style={{
							display: "flex",
							gap: 8,
							flexWrap: "wrap",
							alignItems: "center",
						}}
					>
						{recording ? (
							<>
								<button
									type="button"
									className="voice-preview-btn active"
									onClick={() => finishRecording()}
								>
									{S.recordStop}
								</button>
								<span className="settings-hint">
									{S.recording(recElapsed.toFixed(0))}
								</span>
								<button
									type="button"
									className="voice-preview-btn"
									onClick={cancelRecording}
								>
									{S.recordCancel}
								</button>
							</>
						) : recordedTake ? (
							<>
								<span className="settings-hint">
									{S.takeReady(recordedTake.durationSeconds.toFixed(0))}
								</span>
								<button
									type="button"
									className="voice-preview-btn"
									onClick={onPreviewTake}
								>
									{takePlaying ? S.previewStop : S.previewBtn}
								</button>
								<button
									type="button"
									className="voice-preview-btn"
									disabled={busy}
									onClick={() => void applyRecordedTake()}
								>
									{busy ? S.uploading : isLocal ? S.takeApplyFree : S.takeApply}
								</button>
								<button
									type="button"
									className="voice-preview-btn"
									disabled={busy}
									onClick={discardTake}
								>
									{S.takeDiscard}
								</button>
							</>
						) : (
							<>
								<button
									type="button"
									className="voice-preview-btn"
									disabled={busy}
									onClick={() => void startRecording()}
								>
									{busy ? S.uploading : S.recordBtn}
								</button>
								<label
									data-testid="ref-audio-file-button"
									className="voice-preview-btn"
									style={{ cursor: busy ? "not-allowed" : "pointer" }}
								>
									{active?.kind === "upload" ? S.replaceBtn : S.uploadBtn}
									<input
										data-testid="ref-audio-file-input"
										type="file"
										accept="audio/*"
										style={{ display: "none" }}
										disabled={busy}
										onChange={onFileInput}
									/>
								</label>
							</>
						)}
					</div>
					<div className="settings-hint" style={{ marginTop: 6 }}>
						{isLocal ? S.costLocal : S.cost}
					</div>
				</div>

				{/* ── Presets (collapsible, lazy-loaded) ── */}
				<details
					style={{ marginTop: 12 }}
					onToggle={(e) => {
						if ((e.target as HTMLDetailsElement).open) void loadPresets();
					}}
				>
					<summary style={{ cursor: "pointer", fontSize: 13 }}>
						{S.presetTitle}
					</summary>
					<div style={{ marginTop: 8 }}>
						<div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
							<select
								value={genderFilter}
								onChange={(e) => setGenderFilter(e.target.value)}
								aria-label={S.presetFilterAll}
							>
								<option value="all">{S.presetFilterAll}</option>
								<option value="female">{S.presetFemale}</option>
								<option value="male">{S.presetMale}</option>
							</select>
						</div>
						{presetsLoading ? (
							<span className="settings-hint">{S.presetLoading}</span>
						) : visiblePresets.length === 0 ? (
							<span className="settings-hint">
								{presets === null ? S.presetLoading : S.presetEmpty}
							</span>
						) : (
							<ul
								className="ref-preset-list"
								style={{ listStyle: "none", padding: 0, margin: 0 }}
							>
								{visiblePresets.map((p) => {
									const isActive =
										active?.kind === "preset" && active.presetId === p.id;
									return (
										<li
											key={p.id}
											className="ref-preset-item"
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												gap: 8,
												padding: "6px 0",
											}}
										>
											<div style={{ minWidth: 0 }}>
												<div>{displayPresetName(p, S)}</div>
												<div className="settings-hint">
													{p.durationSeconds.toFixed(0)}s · {p.locale} ·{" "}
													{p.source}
													{isActive ? ` · ${S.presetApplied}` : ""}
												</div>
											</div>
											<div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
												<button
													type="button"
													className="voice-preview-btn"
													onClick={() => void onPreviewPreset(p)}
												>
													{playingPresetId === p.id
														? S.presetStop
														: S.presetPlay}
												</button>
												<button
													type="button"
													className="voice-preview-btn"
													disabled={busy || isActive}
													onClick={() => void onApplyPreset(p)}
												>
													{S.presetApply}
												</button>
											</div>
										</li>
									);
								})}
							</ul>
						)}
					</div>
				</details>

				{notice && (
					<div
						className="settings-hint"
						style={{ marginTop: 6, color: "#3da76a" }}
					>
						{notice}
					</div>
				)}
				{error && (
					<div
						className="settings-error"
						style={{ display: "flex", flexDirection: "column", gap: 6 }}
					>
						<div>{error}</div>
						{isSteam && error === S.err.creditInsufficient && (
							<button
								type="button"
								className="voice-preview-btn"
								data-testid="ref-audio-steam-charge-btn"
								style={{ alignSelf: "flex-start", marginTop: 4 }}
								onClick={() => setSteamPurchaseModalOpen(true)}
							>
								{t("cost.labCharge")}
							</button>
						)}
					</div>
				)}
				{isLocal && localEngine === "off" && (
					<div className="settings-hint" data-testid="ref-audio-engine-off">
						{hideEngineStartControl ? (
							S.localEngineOffToggleHint
						) : (
							<>
								{S.localEngineOff}
								{ensureLocalVoiceReady && (
									<button
										type="button"
										className="voice-preview-btn"
										data-testid="ref-audio-engine-start"
										onClick={async () => {
											if (await ensureLocalVoiceReady()) {
												setLocalEngine("ready");
												void refresh();
											}
										}}
									>
										{S.localEngineStart}
									</button>
								)}
							</>
						)}
					</div>
				)}
				{isLocal && localEngine === "starting" && (
					<div
						className="settings-hint"
						data-testid="ref-audio-engine-starting"
					>
						{S.localEngineStarting}
					</div>
				)}
			</div>
			<SteamPurchaseModal
				isOpen={steamPurchaseModalOpen}
				onClose={() => setSteamPurchaseModalOpen(false)}
			/>
		</>
	);
}
