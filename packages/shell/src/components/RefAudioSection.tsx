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

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_VOICE_REF_URL, loadConfig, saveConfig } from "../lib/config";
import { getLocale } from "../lib/i18n";
import { Logger } from "../lib/logger";
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
	setLocalRefAudioB64,
	uploadRefAudio,
} from "../lib/voice/ref-audio-api";
import {
	type RefRecording,
	startRefRecording,
} from "../lib/voice/ref-recorder";

const TAG = "RefAudioSection";
const MIN_DURATION_S = 5;
const MAX_DURATION_S = 30;

/**
 * Persist the active voice-reference preset URL into AppConfig so the realtime
 * voice session (ChatPanel) sends it directly as `ref_audio_url` — the
 * deterministic source the web demo uses. Pass null on upload/remove so an
 * uploaded voice (injected server-side from GCS) is not shadowed by a preset.
 */
function setConfigVoiceRefUrl(url: string | null): void {
	const c = loadConfig();
	if (c) saveConfig({ ...c, voiceRefUrl: url ?? undefined });
	// Notify a live voice session (ChatPanel) to switch the cloned voice now,
	// without a reconnect (web-demo parity). No-op if no session is active.
	window.dispatchEvent(new CustomEvent("naia:voice-ref-url", { detail: url }));
}

const STRINGS = {
	ko: {
		sectionTitle: "음성 참조 (Voice Reference)",
		hint: "Naia Omni 실시간 음성이 사용할 음색입니다. 5–30초 녹음하거나 클립을 업로드하세요.",
		currentTitle: "현재 음색",
		statusNone: "설정된 음색 없음 — 기본 음색 사용 중",
		statusActiveUpload: (d: string, kb: string, when: string) =>
			`내 업로드 · ${d}초 · ${kb} KB · ${when}`,
		presetActiveLabel: (name: string) => `프리셋 · ${name}`,
		previewBtn: "▶ 듣기",
		previewStop: "■ 정지",
		previewLoading: "불러오는 중…",
		removeBtn: "제거",
		confirmRemove: "현재 음색을 제거할까요?",
		confirmYes: "제거",
		confirmNo: "취소",
		myVoiceTitle: "내 목소리로 만들기",
		recordBtn: "🎤 녹음",
		recordStop: "■ 녹음 정지",
		recording: (s: string) => `녹음 중… ${s}초`,
		recordTooShort: `너무 짧습니다 (최소 ${MIN_DURATION_S}초).`,
		recordCancel: "취소",
		takeReady: (s: string) => `녹음됨 · ${s}초 — 들어보고 적용하세요`,
		takeApply: "적용 ($0.01)",
		takeApplyFree: "적용 (무료)",
		takeDiscard: "다시 녹음",
		uploadBtn: "파일 업로드",
		replaceBtn: "파일로 교체",
		uploading: "업로드 중…",
		cost: "적용·업로드 시 1회당 $0.01 차감 (녹음만으로는 차감 없음)",
		costLocal: "로컬 모델 — 녹음·업로드 무료 (크레딧 차감 없음)",
		err: {
			network: "네트워크 오류 — 재시도해주세요.",
			auth: "naia 계정 로그인이 필요합니다.",
			creditInsufficient:
				"크레딧 잔액이 부족합니다. naia 계정에서 충전 후 다시 시도하세요.",
			format: "오디오 형식 오류 — 5–30초, 16 kHz mono 권장.",
			tooLarge: "파일이 너무 큽니다 (최대 4 MiB).",
			uploadInProgress: "동일한 업로드가 진행 중입니다.",
			soldOut:
				"현재 매진입니다. 잠시 후 다시 시도해주세요. naia OS 로컬 모델로 즉시 사용도 가능합니다.",
			noActiveRef: "재생할 음색이 없습니다.",
			record: "녹음을 시작할 수 없습니다 — 마이크 권한을 확인하세요.",
			unknown: "알 수 없는 오류 — 다시 시도해주세요.",
		},
		uploadSuccess: (newBal: string) => `완료 · 잔액 $${newBal}`,
		localRefApplied: "녹음 음색이 적용되었습니다 (로컬 · 무료).",
		removeSuccess: "음색이 제거되었습니다.",
		presetTitle: "프리셋에서 고르기",
		presetLoading: "프리셋 불러오는 중…",
		presetEmpty: "사용 가능한 프리셋이 없습니다.",
		presetPlay: "듣기",
		presetStop: "정지",
		presetApply: "적용",
		presetApplied: "적용 중",
		presetApplySuccess: (name: string) => `${name} 음색으로 변경되었습니다.`,
		presetFilterAll: "전체",
		presetNotFound: "선택한 프리셋을 찾을 수 없습니다.",
	},
	en: {
		sectionTitle: "Voice Reference",
		hint: "The voice Naia Omni clones for realtime replies. Record 5–30 s or upload a clip.",
		currentTitle: "Current voice",
		statusNone: "No voice set — using the default voice",
		statusActiveUpload: (d: string, kb: string, when: string) =>
			`My upload · ${d}s · ${kb} KB · ${when}`,
		presetActiveLabel: (name: string) => `Preset · ${name}`,
		previewBtn: "▶ Play",
		previewStop: "■ Stop",
		previewLoading: "Loading…",
		removeBtn: "Remove",
		confirmRemove: "Remove the current voice?",
		confirmYes: "Remove",
		confirmNo: "Cancel",
		myVoiceTitle: "Make your voice",
		recordBtn: "🎤 Record",
		recordStop: "■ Stop",
		recording: (s: string) => `Recording… ${s}s`,
		recordTooShort: `Too short (min ${MIN_DURATION_S}s).`,
		recordCancel: "Cancel",
		takeReady: (s: string) => `Recorded · ${s}s — preview, then apply`,
		takeApply: "Apply ($0.01)",
		takeApplyFree: "Apply (free)",
		takeDiscard: "Record again",
		uploadBtn: "Upload file",
		replaceBtn: "Replace with file",
		uploading: "Uploading…",
		cost: "$0.01 charged when you apply or upload (recording itself is free)",
		costLocal: "Local model — recording & upload are free (no credit charge)",
		err: {
			network: "Network error — please retry.",
			auth: "Please sign in to your naia account.",
			creditInsufficient:
				"Insufficient credits. Top up your naia account and retry.",
			format: "Invalid audio — please use a 5–30s 16 kHz mono clip.",
			tooLarge: "File too large (4 MiB max).",
			uploadInProgress: "An upload with the same key is in progress.",
			soldOut:
				"Sold out — please retry shortly. You can also switch to the naia OS local model.",
			noActiveRef: "No voice to play.",
			record: "Couldn't start recording — check microphone permission.",
			unknown: "Unknown error — please retry.",
		},
		uploadSuccess: (newBal: string) => `Done · balance $${newBal}`,
		localRefApplied: "Recorded voice applied (local · free).",
		removeSuccess: "Voice removed.",
		presetTitle: "Pick from presets",
		presetLoading: "Loading presets…",
		presetEmpty: "No presets available.",
		presetPlay: "Play",
		presetStop: "Stop",
		presetApply: "Apply",
		presetApplied: "Active",
		presetApplySuccess: (name: string) => `Voice changed to ${name}.`,
		presetFilterAll: "All",
		presetNotFound: "The selected preset was not found.",
	},
} as const;

function pickStrings() {
	return getLocale() === "ko" ? STRINGS.ko : STRINGS.en;
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

function formatBalance(balance: number): string {
	return balance.toFixed(2);
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

export function RefAudioSection() {
	const S = pickStrings();
	// Naia Local runs on the user's own GPU — recording/uploading a reference
	// voice is free and never touches the gateway, so hide the $0.01 hints.
	const isLocal = loadConfig()?.model === "naia-local";
	const [active, setActive] = useState<RefAudioActive | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>("");
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
		// A Naia Local recorded clip lives only in localStorage (no gateway slot) —
		// reflect it directly so the card matches the voice actually being sent.
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
	}, [S]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const loadPresets = useCallback(async () => {
		if (presets !== null || presetsLoading) return;
		setPresetsLoading(true);
		try {
			const list = await getRefAudioPresets();
			setPresets(list);
			setError("");
		} catch (err) {
			Logger.warn(TAG, "presets fetch failed", { error: String(err) });
			setError(describeError(err, S));
			setPresets([]);
		} finally {
			setPresetsLoading(false);
		}
	}, [presets, presetsLoading, S]);

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
				Logger.warn(TAG, "playback failed");
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
				// Preview via the preset's public sampleUrl instead.
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
	}, [active, previewState, presets, playUrl, stopPlayback, S]);

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
				if (loadConfig()?.model === "naia-local") {
					const b64 = await encodeRefAudio(input);
					setLocalRefAudioB64(b64);
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
					return;
				}
				const result = await uploadRefAudio(input);
				// An upload supersedes any applied preset — clear the preset URL so
				// it never shadows the uploaded voice (gateway injects uploads).
				setConfigVoiceRefUrl(null);
				setLocalRefAudioB64(null);
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
		[S],
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
		(preset: RefAudioPreset) => {
			if (playingPresetId === preset.id) {
				stopPlayback();
				return;
			}
			setPlayingPresetId(preset.id);
			playUrl(preset.sampleUrl, false, () => setPlayingPresetId(null));
		},
		[playingPresetId, playUrl, stopPlayback],
	);

	const onApplyPreset = useCallback(
		async (preset: RefAudioPreset) => {
			setBusy(true);
			setError("");
			setNotice("");
			// Persist the picked preset's public sampleUrl FIRST so realtime voice
			// sends it directly as ref_audio_url (web-demo parity) — even if the
			// server-side apply below fails (e.g. credit/auth on the dev gateway).
			// The voice must not depend on the apply round-trip or GET status.
			setConfigVoiceRefUrl(preset.sampleUrl);
			setLocalRefAudioB64(null); // a preset supersedes a local recorded clip
			window.dispatchEvent(
				new CustomEvent("naia:voice-ref-audio", { detail: null }),
			);
			try {
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
		[S],
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
			setLocalRefAudioB64(null);
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
							) : (
								<span>
									{S.statusActiveUpload(
										active.durationSeconds.toFixed(1),
										Math.round(active.sizeBytes / 1024).toLocaleString(),
										formatDate(active.uploadedAt),
									)}
								</span>
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

				{/* ── Make your voice: record + upload ── */}
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
									className="voice-preview-btn"
									style={{ cursor: busy ? "not-allowed" : "pointer" }}
								>
									{active?.kind === "upload" ? S.replaceBtn : S.uploadBtn}
									<input
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
								<option value="female">female</option>
								<option value="male">male</option>
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
												<div>{p.name}</div>
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
													onClick={() => onPreviewPreset(p)}
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
				{error && <div className="settings-error">{error}</div>}
			</div>
		</>
	);
}
