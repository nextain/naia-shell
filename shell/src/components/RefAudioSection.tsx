/**
 * Voice Reference Audio section for SettingsTab.
 *
 * Lets a signed-in user upload a 5-30 second voice clip to the
 * naia-anyllm gateway (POST /v1/ref-audio). The realtime proxy
 * picks it up automatically on every /v1/realtime connect — see
 * the gateway side commit naia-anyllm@69d133f and the Pod side
 * commit naia-model-infra@43dfa82.
 *
 * Plan SoT: alpha-adk/.agents/progress/ref-audio-service-plan-2026-05-29.md §7.
 *
 * Inline ko/en strings — i18n.ts 14-language dictionary expansion
 * (~210 entries) is intentionally deferred to a follow-up commit so
 * this can ship with the Naia Omni realtime-voice launch slice.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getLocale } from "../lib/i18n";
import { Logger } from "../lib/logger";
import {
	type RefAudioActive,
	RefAudioApiError,
	type RefAudioPreset,
	applyRefAudioPreset,
	deleteRefAudio,
	getRefAudioPresets,
	getRefAudioStatus,
	uploadRefAudio,
} from "../lib/voice/ref-audio-api";

const TAG = "RefAudioSection";

const STRINGS = {
	ko: {
		sectionTitle: "음성 참조 (Voice Reference)",
		hint: "5–30초 음성 클립을 업로드하면 Naia Omni 실시간 음성 세션이 사용자 음색으로 응답합니다. 16 kHz mono WAV 권장.",
		statusNone: "업로드된 참조 음성 없음",
		statusActive: (d: string, kb: string, when: string) =>
			`적용 중 · ${d}초 · ${kb} KB · ${when} 업로드`,
		uploadBtn: "업로드",
		replaceBtn: "교체",
		removeBtn: "제거",
		uploading: "업로드 중…",
		cost: "업로드당 $0.01 차감",
		confirmRemove: "참조 음성을 제거할까요? (히스토리는 90일간 보존)",
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
			unknown: "알 수 없는 오류 — 다시 시도해주세요.",
		},
		uploadSuccess: (newBal: string) => `업로드 완료 · 잔액 $${newBal}`,
		removeSuccess: "참조 음성이 제거되었습니다.",
		uploadTab: "내 업로드",
		presetTab: "프리셋 선택",
		presetLoading: "프리셋 불러오는 중…",
		presetEmpty: "사용 가능한 프리셋이 없습니다.",
		presetPlay: "듣기",
		presetStop: "정지",
		presetApply: "적용",
		presetApplied: "적용 중",
		presetApplySuccess: (name: string) => `${name} 음색으로 변경되었습니다.`,
		presetFilterAll: "전체",
		presetActiveLabel: (name: string) => `적용 중인 프리셋 · ${name}`,
		presetNotFound: "선택한 프리셋을 찾을 수 없습니다.",
	},
	en: {
		sectionTitle: "Voice Reference",
		hint: "Upload a 5–30 second clip; Naia Omni realtime-voice sessions will respond in your voice. 16 kHz mono WAV recommended.",
		statusNone: "No reference voice uploaded",
		statusActive: (d: string, kb: string, when: string) =>
			`Active · ${d}s · ${kb} KB · uploaded ${when}`,
		uploadBtn: "Upload",
		replaceBtn: "Replace",
		removeBtn: "Remove",
		uploading: "Uploading…",
		cost: "$0.01 charged per upload",
		confirmRemove: "Remove the reference voice? (history retained for 90 days)",
		err: {
			network: "Network error — please retry.",
			auth: "Please sign in to your naia account.",
			creditInsufficient:
				"Insufficient credits. Top up your naia account and retry.",
			format: "Invalid audio — please use a 5–30s 16 kHz mono clip.",
			tooLarge: "File too large (4 MiB max).",
			uploadInProgress: "An upload with the same key is in progress.",
			soldOut:
				"Sold out — please retry shortly. You can also switch to the naia OS local model for instant use.",
			unknown: "Unknown error — please retry.",
		},
		uploadSuccess: (newBal: string) => `Upload complete · balance $${newBal}`,
		removeSuccess: "Reference voice removed.",
		uploadTab: "My Upload",
		presetTab: "Preset",
		presetLoading: "Loading presets…",
		presetEmpty: "No presets available.",
		presetPlay: "Play",
		presetStop: "Stop",
		presetApply: "Apply",
		presetApplied: "Active",
		presetApplySuccess: (name: string) => `Voice changed to ${name}.`,
		presetFilterAll: "All",
		presetActiveLabel: (name: string) => `Active preset · ${name}`,
		presetNotFound: "The selected preset was not found.",
	},
} as const;

function pickStrings() {
	return getLocale() === "ko" ? STRINGS.ko : STRINGS.en;
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
	const [active, setActive] = useState<RefAudioActive | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>("");
	const [notice, setNotice] = useState<string>("");
	const [tab, setTab] = useState<"upload" | "preset">("upload");
	const [presets, setPresets] = useState<RefAudioPreset[] | null>(null);
	const [presetsLoading, setPresetsLoading] = useState(false);
	const [playingId, setPlayingId] = useState<string | null>(null);
	const [genderFilter, setGenderFilter] = useState<string>("all");
	const audioRef = useRef<HTMLAudioElement | null>(null);

	const refresh = useCallback(async () => {
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

	// Lazy-load presets the first time the preset tab is opened.
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

	useEffect(() => {
		if (tab === "preset") void loadPresets();
	}, [tab, loadPresets]);

	// Stop any preview playback on unmount.
	useEffect(() => {
		return () => {
			audioRef.current?.pause();
			audioRef.current = null;
		};
	}, []);

	const onPreview = useCallback((preset: RefAudioPreset) => {
		// Toggle: clicking the playing one stops it.
		if (audioRef.current) {
			audioRef.current.pause();
			audioRef.current = null;
		}
		setPlayingId((cur) => {
			if (cur === preset.id) return null;
			const audio = new Audio(preset.sampleUrl);
			audio.preload = "none";
			audio.onended = () => setPlayingId(null);
			audio.onerror = () => {
				Logger.warn(TAG, "preview play failed", { id: preset.id });
				setPlayingId(null);
			};
			audioRef.current = audio;
			void audio.play().catch(() => setPlayingId(null));
			return preset.id;
		});
	}, []);

	const onApplyPreset = useCallback(
		async (preset: RefAudioPreset) => {
			setBusy(true);
			setError("");
			setNotice("");
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

	const visiblePresets = (presets ?? []).filter(
		(p) => genderFilter === "all" || p.gender === genderFilter,
	);

	const handleFile = useCallback(
		async (file: File) => {
			setBusy(true);
			setError("");
			setNotice("");
			try {
				const result = await uploadRefAudio(file);
				setActive({
					uploadedAt: result.uploadedAt,
					sizeBytes: result.sizeBytes,
					durationSeconds: result.durationSeconds,
				});
				setNotice(S.uploadSuccess(formatBalance(result.newBalanceUsd)));
			} catch (err) {
				Logger.warn(TAG, "upload failed", { error: String(err) });
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
			// reset the input so the same file can be re-picked after a failure
			e.target.value = "";
			if (f) void handleFile(f);
		},
		[handleFile],
	);

	const onRemove = useCallback(async () => {
		if (!confirm(S.confirmRemove)) return;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await deleteRefAudio();
			setActive(null);
			setNotice(S.removeSuccess);
		} catch (err) {
			Logger.warn(TAG, "delete failed", { error: String(err) });
			setError(describeError(err, S));
		} finally {
			setBusy(false);
		}
	}, [S]);

	const activeLine = !active ? (
		<span>{S.statusNone}</span>
	) : active.kind === "preset" ? (
		<span>{S.presetActiveLabel(active.presetName ?? active.presetId ?? "")}</span>
	) : (
		<span>
			{S.statusActive(
				active.durationSeconds.toFixed(1),
				Math.round(active.sizeBytes / 1024).toLocaleString(),
				formatDate(active.uploadedAt),
			)}
		</span>
	);

	return (
		<>
			<div className="settings-section-divider">
				<span>{S.sectionTitle}</span>
			</div>
			<div className="settings-field">
				<span className="settings-hint">{S.hint}</span>

				{/* Tabs */}
				<div
					style={{ marginTop: 8, display: "flex", gap: 8 }}
					role="tablist"
				>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "upload"}
						className={`voice-preview-btn${tab === "upload" ? " active" : ""}`}
						onClick={() => setTab("upload")}
					>
						{S.uploadTab}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "preset"}
						className={`voice-preview-btn${tab === "preset" ? " active" : ""}`}
						onClick={() => setTab("preset")}
					>
						{S.presetTab}
					</button>
				</div>

				<div style={{ marginTop: 8 }}>
					{loading ? <span className="settings-hint">…</span> : activeLine}
				</div>

				{tab === "upload" ? (
					<>
						<div
							style={{
								marginTop: 8,
								display: "flex",
								gap: 8,
								flexWrap: "wrap",
							}}
						>
							<label
								className="voice-preview-btn"
								style={{ cursor: busy ? "not-allowed" : "pointer" }}
							>
								{busy
									? S.uploading
									: active?.kind === "upload"
										? S.replaceBtn
										: S.uploadBtn}
								<input
									type="file"
									accept="audio/*"
									style={{ display: "none" }}
									disabled={busy}
									onChange={onFileInput}
								/>
							</label>
							{active?.kind === "upload" && !busy && (
								<button
									type="button"
									className="voice-preview-btn"
									onClick={() => void onRemove()}
								>
									{S.removeBtn}
								</button>
							)}
						</div>
						<div className="settings-hint" style={{ marginTop: 6 }}>
							{S.cost}
						</div>
					</>
				) : (
					<div style={{ marginTop: 8 }}>
						{/* Gender filter */}
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
							<span className="settings-hint">{S.presetEmpty}</span>
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
													onClick={() => onPreview(p)}
												>
													{playingId === p.id ? S.presetStop : S.presetPlay}
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
				)}

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
