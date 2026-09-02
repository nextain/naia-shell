import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import {
	buildNaiaConfigEnv,
	getAdkPath,
	listNaiaAssets,
	toAssetUrl,
	toLocalBlobUrl,
	writeAgentKeyStrict,
	writeNaiaConfig,
	writeSlotsManifest,
} from "../lib/adk-store";
import {
	DEFAULT_NVA_MODEL,
	isLegacyBundledVrmModel,
} from "../lib/avatar-presets";
import { detectGpuVramGb } from "../lib/capabilities/gpu";
import {
	activateNaiaLlm,
	isNewCore,
	reloadAgentSettings,
	sendAuthUpdate,
	sendAuthUpdateStrict,
} from "../lib/chat-service";
import {
	type AppConfig,
	DEFAULT_LOCAL_VOICE_HOST,
	LAB_GATEWAY_URL,
	NAIA_WEB_BASE_URL,
	loadConfig,
	saveConfig,
	saveConfigSecure,
} from "../lib/config";
import { getLocale, t, type Locale, type TranslationKey } from "../lib/i18n";
import {
	fetchLabBalancePayload,
	parseLabCredits,
	primeLabCredits,
} from "../lib/lab-balance";
import {
	defaultClipOf,
	parseNvaManifest,
	resolveNvaAssetPath,
} from "../lib/nva";
import { OAUTH_CALLBACK_URL } from "../lib/oauth-callback-url";
import {
	type OnboardingSession,
	type StepInput,
	makeOnboardingSession,
} from "../lib/onboarding-core";
import { deleteSecretKey, saveSecretKey } from "../lib/secure-store";
import { NAIA_SLOT_DEFAULTS, applyNaiaSlotDefaults } from "../lib/slots/model";
import {
	clearLocalVoiceAccessToken,
	localVoiceFacadeUrlFromReady,
} from "../lib/voice/local-runtime";
import { useAppStore } from "../stores/app";
import { useAvatarStore } from "../stores/avatar";
import { useCascadeAvatarStore } from "../stores/cascade-avatar";
import { useChatStore } from "../stores/chat";

type Step =
	| "welcome"
	| "agentName"
	| "userName"
	| "speechStyle"
	| "character"
	| "background"
	| "provider"
	| "voice"
	| "complete";

const STEPS_WITHOUT_NAIA: Step[] = [
	"welcome",
	"agentName",
	"userName",
	"speechStyle",
	"character",
	"background",
	"provider",
	"voice",
	"complete",
];

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "ogg", "avi"]);
function isVideo(url: string) {
	return VIDEO_EXTS.has(
		url.split("?")[0].split(".").pop()?.toLowerCase() ?? "",
	);
}

// Languages whose completion line opens with the name rather than embedding it
// mid-sentence. Keep in step with onboard.chat.complete.
const LEADS_WITH_NAME = new Set<Locale>(["ko", "ja", "zh"]);

function stepChat(step: Step, name: string, user: string): string {
	// These strings used to be Korean literals, so a person on an English system
	// met an English UI with Naia speaking Korean at them. The translations for
	// the rest of onboarding were already here and simply were not being used.
	const n = name || t("onboard.defaultAgentName");
	// Korean attaches an honorific to the name; other languages do not, so the
	// suffix belongs to the Korean string rather than to this interpolation.
	const u = user ? (getLocale() === "ko" ? `${user}님` : user) : "";
	const fill = (key: TranslationKey) =>
		t(key).replace("{agent}", n).replace("{user}", u);

	switch (step) {
		case "welcome":
			return t("onboard.chat.welcome");
		case "agentName":
			return t("onboard.chat.agentName");
		case "userName":
			return fill("onboard.chat.userName");
		case "speechStyle":
			return fill("onboard.chat.speechStyle");
		case "character":
			return t("onboard.chat.character");
		case "background":
			return t("onboard.chat.background");
		case "provider":
			return t("onboard.chat.provider");
		case "voice":
			return t("onboard.chat.voice");
		case "complete":
			// The line leads with the user's name when there is one, so {user}
			// carries its own separator rather than being a bare name.
			// Where the name belongs differs by language, so each string places
			// {user} itself and this only supplies the separator its position
			// needs. Empty when there is no name, and the line still reads.
			return t("onboard.chat.complete")
				.replace("{user}", u ? (LEADS_WITH_NAME.has(getLocale()) ? `${u}, ` : `, ${u}`) : "")
				.replace("{agent}", n);
	}
}

interface BgOption {
	url: string;
	label: string;
	path: string;
	type: "image" | "video" | "";
}

interface NaiaAuthPayload {
	naiaKey: string;
	naiaUserId?: string;
}

interface OnboardingSnapshot {
	agentName: string;
	userName: string;
	speechStyle: "casual" | "formal";
	honorific: string;
	extraPersona: string;
	selectedVrm: string;
	avatarProvider: "vrm" | "naia-video-avatar";
	selectedNva: string;
	backgrounds: BgOption[];
	selectedBg: string;
	naiaLoginDone: boolean;
	memoryEmbeddingProvider: "none" | "offline" | "vllm" | "ollama" | "naia";
	memoryLlmProvider: "none" | "naia" | "vllm" | "ollama";
	ttsEnabled: boolean;
	webVoiceLang: string;
	localVoiceEnabled: boolean;
}

function BackgroundThumbnail({
	background,
	className = "onboarding-step__bg-img",
}: {
	background: BgOption;
	className?: string;
}) {
	const [capturedFrame, setCapturedFrame] = useState("");

	useEffect(() => {
		if (background.type !== "video") return;
		const video = document.createElement("video");
		video.src = background.url;
		video.muted = true;
		video.preload = "auto";
		video.playsInline = true;
		let settled = false;
		const cleanup = () => {
			video.removeAttribute("src");
			video.load();
		};
		const capture = () => {
			if (settled || !video.videoWidth || !video.videoHeight) return;
			settled = true;
			const canvas = document.createElement("canvas");
			canvas.width = video.videoWidth;
			canvas.height = video.videoHeight;
			canvas.getContext("2d")?.drawImage(video, 0, 0);
			try {
				setCapturedFrame(canvas.toDataURL("image/jpeg", 0.82));
			} catch {
				// asset:// may be canvas-tainted on some WebView2 versions.
			}
			cleanup();
		};
		video.onloadeddata = () => {
			const seekTo = Number.isFinite(video.duration)
				? Math.min(0.25, Math.max(0, video.duration / 20))
				: 0;
			if (seekTo > 0) video.currentTime = seekTo;
			else capture();
		};
		video.onseeked = capture;
		video.onerror = cleanup;
		video.load();
		return cleanup;
	}, [background.type, background.url]);

	if (capturedFrame) {
		return (
			<img src={capturedFrame} alt={background.label} className={className} />
		);
	}
	return (
		// #447-2: when the single-frame capture can't produce a still (e.g. a VP9
		// alpha .webm whose early frames are transparent, or a tainted canvas), a
		// metadata-only <video> paints nothing and the tile looks empty. Autoplay a
		// muted loop so the avatar/background is always visible in the grid.
		<video
			src={background.url}
			className={className}
			muted
			loop
			autoPlay
			preload="metadata"
			playsInline
			aria-label={background.label}
		/>
	);
}

function NvaThumbnail({ path, label }: { path: string; label: string }) {
	const [preview, setPreview] = useState<BgOption | null>(null);
	const bundleName = path.split(/[/\\]/).filter(Boolean).pop()?.toLowerCase();
	const isLiveActionNaia =
		bundleName === "naia" || label.trim().toLowerCase() === "naia";

	useEffect(() => {
		let disposed = false;
		const adkPath = getAdkPath();
		if (!adkPath) return;
		const sep = adkPath.includes("\\") ? "\\" : "/";
		const bundleDir =
			path.includes("/") || path.includes("\\")
				? path
				: `${adkPath}${sep}naia-settings${sep}nva-files${sep}${path}`;
		void invoke<string>("read_local_binary", {
			path: `${bundleDir}${sep}manifest.json`,
			allowedBase: adkPath,
		})
			.then(async (base64) => {
				const raw = atob(base64);
				const manifest = parseNvaManifest(
					new TextDecoder().decode(
						Uint8Array.from(raw, (char) => char.charCodeAt(0)),
					),
				);
				const clipPath = resolveNvaAssetPath(
					bundleDir,
					defaultClipOf(manifest).video,
				);
				const url = await toLocalBlobUrl(clipPath);
				if (!disposed)
					setPreview({ url, label, path: clipPath, type: "video" });
			})
			.catch(() => {});
		return () => {
			disposed = true;
		};
	}, [label, path]);

	if (!preview) {
		return <span className="onboarding-step__avatar-img" aria-hidden="true" />;
	}
	// #447-2: NVA clips are tall full-body 720×1280 portraits. object-fit alone
	// only picks a vertical band (still shows the whole body). Zoom into the head
	// by oversizing the media inside a fixed, clipped, top-aligned frame.
	return (
		<span
			className={`onboarding-step__avatar-img onboarding-step__nva-crop${isLiveActionNaia ? " onboarding-step__nva-crop--live-naia" : ""}`}
		>
			<BackgroundThumbnail
				background={preview}
				className="onboarding-step__nva-crop-media"
			/>
		</span>
	);
}

function getBackgroundMediaType(path: string): "image" | "video" | "" {
	if (isVideo(path)) return "video";
	const ext = path.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
	if (["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(ext)) {
		return "image";
	}
	return "";
}

function getNaiaWebBaseUrl() {
	return NAIA_WEB_BASE_URL;
}

export function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
	const setAvatarModelPath = useAvatarStore((s) => s.setModelPath);
	const setBackgroundVideoUrl = useAvatarStore((s) => s.setBackgroundVideoUrl);
	const setBackgroundMediaType = useAvatarStore(
		(s) => s.setBackgroundMediaType,
	);
	const addMessage = useChatStore((s) => s.addMessage);

	const hasNaiaKey = !!localStorage.getItem("naia-remote-key");
	// Always use full steps so user can see/confirm the provider connection during onboarding
	const STEPS = STEPS_WITHOUT_NAIA;

	const [step, setStep] = useState<Step>("welcome");
	const [agentName, setAgentName] = useState("");
	const [userName, setUserName] = useState("");
	const [speechStyle, setSpeechStyle] = useState<"casual" | "formal">("casual");
	const [honorific, setHonorific] = useState("");
	const [extraPersona, setExtraPersona] = useState("");
	const [naiaVrms, setNaiaVrms] = useState<string[]>([]);
	const [selectedVrm, setSelectedVrm] = useState("");
	const [naiaNvas, setNaiaNvas] = useState<string[]>([]);
	// 기본 아바타 = NVA(비디오). GPU 없이도 동작하므로 가장 넓은 사용자 도달을 위해
	// 신규 온보딩 기본값으로 밀어준다. VRM 은 명시 선택 시에만.
	const [avatarProvider, setAvatarProvider] = useState<
		"vrm" | "naia-video-avatar"
	>("naia-video-avatar");
	const [selectedNva, setSelectedNva] = useState("");
	const [backgrounds, setBackgrounds] = useState<BgOption[]>([]);
	const [selectedBg, setSelectedBg] = useState("");
	// Provider step state
	const [naiaLoginWaiting, setNaiaLoginWaiting] = useState(false);
	const [naiaLoginDone, setNaiaLoginDone] = useState(hasNaiaKey);
	const [detectedVramGb, setDetectedVramGb] = useState<number | null>(null);
	// Voice step state — default ON with the free Web TTS engine (FR-VOICE onboarding).
	const [ttsEnabled, setTtsEnabled] = useState(true);
	const [webVoiceURI, setWebVoiceURI] = useState("");
	const [webVoices, setWebVoices] = useState<SpeechSynthesisVoice[]>([]);
	const [voicePreviewing, setVoicePreviewing] = useState(false);
	const [localVoiceEnabled, setLocalVoiceEnabled] = useState(false);
	const [localVoiceBusy, setLocalVoiceBusy] = useState(false);
	const [localVoiceMsg, setLocalVoiceMsg] = useState("");
	const [localVoiceInstallation, setLocalVoiceInstallation] = useState<{
		phase: string;
		canStart: boolean;
		ready: boolean;
		summary: string;
		steps: Array<{ actionAvailable: boolean }>;
	} | null>(null);
	const localVoiceInstallationRequestRef = useRef(0);
	// Auth payload from OAuth — held until wizard completes
	const [naiaAuthPayload, setNaiaAuthPayload] =
		useState<NaiaAuthPayload | null>(null);
	const [completing, setCompleting] = useState(false);
	const [completionError, setCompletionError] = useState("");
	// memoryAI step state — default to "naia" when Naia key already present
	const [memoryEmbeddingProvider, setMemoryEmbeddingProvider] = useState<
		"none" | "offline" | "vllm" | "ollama" | "naia"
	>(hasNaiaKey ? "naia" : "none");
	const [memoryLlmProvider, setMemoryLlmProvider] = useState<
		"none" | "naia" | "vllm" | "ollama"
	>(hasNaiaKey ? "naia" : "none");
	const naiaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestRef = useRef<OnboardingSnapshot | null>(null);
	const onboardingGpuSummary =
		detectedVramGb != null
			? t("onboard.connect.vramDetected").replace(
					"{vram}",
					String(detectedVramGb),
				)
			: t("onboard.connect.vramUnknown");
	const onboardingGpuRecommendation =
		detectedVramGb != null
			? t("onboard.connect.localVoiceAvailable")
			: t("onboard.connect.vramCloud");

	useEffect(() => {
		detectGpuVramGb().then(setDetectedVramGb);
	}, []);

	// Populate the Web TTS voice list. Some platforms (WebView2 included)
	// deliver the real list asynchronously via `onvoiceschanged` instead of
	// synchronously from getVoices() on first call.
	useEffect(() => {
		if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
		const applyVoices = () => {
			const voices = window.speechSynthesis.getVoices();
			if (voices.length === 0) return;
			setWebVoices(voices);
			setWebVoiceURI((current) => {
				if (current && voices.some((voice) => voice.voiceURI === current))
					return current;
				const locale = getLocale();
				const matched =
					voices.find((voice) =>
						voice.lang?.toLowerCase().startsWith(locale),
					) ??
					voices.find((voice) =>
						voice.lang?.toLowerCase().startsWith(locale.split("-")[0]),
					) ??
					voices[0];
				return matched?.voiceURI ?? "";
			});
		};
		applyVoices();
		window.speechSynthesis.onvoiceschanged = applyVoices;
		return () => {
			window.speechSynthesis.onvoiceschanged = null;
		};
	}, []);

	function previewWebVoice() {
		if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
		window.speechSynthesis.cancel();
		const voice = webVoices.find((item) => item.voiceURI === webVoiceURI);
		const utter = new SpeechSynthesisUtterance(t("onboard.voice.previewText"));
		if (voice) utter.voice = voice;
		utter.lang = voice?.lang || getLocale();
		utter.onstart = () => setVoicePreviewing(true);
		utter.onend = () => setVoicePreviewing(false);
		utter.onerror = () => setVoicePreviewing(false);
		window.speechSynthesis.speak(utter);
	}

	async function refreshVoxCpm2InstallationForOnboarding(): Promise<{
		phase: string;
		canStart: boolean;
		ready: boolean;
		summary: string;
		steps: Array<{ actionAvailable: boolean }>;
	} | null> {
		const generation = ++localVoiceInstallationRequestRef.current;
		try {
			const status = await invoke<unknown>("voxcpm2_installation_status");
			if (generation !== localVoiceInstallationRequestRef.current) return null;
			if (
				!status ||
				typeof status !== "object" ||
				typeof (status as { phase?: unknown }).phase !== "string" ||
				typeof (status as { canStart?: unknown }).canStart !== "boolean" ||
				typeof (status as { ready?: unknown }).ready !== "boolean" ||
				typeof (status as { summary?: unknown }).summary !== "string" ||
				!Array.isArray((status as { steps?: unknown }).steps)
			) {
				return null;
			}
			const installation = status as {
				phase: string;
				canStart: boolean;
				ready: boolean;
				summary: string;
				steps: Array<{ actionAvailable: boolean }>;
			};
			setLocalVoiceInstallation(installation);
			return installation;
		} catch {
			if (generation !== localVoiceInstallationRequestRef.current) return null;
			setLocalVoiceInstallation(null);
			return null;
		}
	}

	useEffect(() => {
		if (detectedVramGb != null && detectedVramGb >= 6) {
			void refreshVoxCpm2InstallationForOnboarding();
		}
	}, [detectedVramGb]);

	/**
	 * Actually starts/stops the local VoxCPM2 runtime (same start_voxcpm2 /
	 * stop_voxcpm2 lifecycle SettingsTab's Voice toggle uses) instead of only
	 * saving a preference flag — a saved-but-never-started flag would be a
	 * false "ready" state (WNV-06).
	 */
	async function toggleLocalVoice() {
		if (localVoiceBusy) return;
		setLocalVoiceMsg("");
		if (localVoiceEnabled) {
			setLocalVoiceBusy(true);
			try {
				clearLocalVoiceAccessToken();
				await invoke("stop_voxcpm2");
			} catch {
				/* best-effort teardown — onboarding never blocks on this */
			} finally {
				useCascadeAvatarStore.getState().setLocalFacadeUrl(null);
				setLocalVoiceEnabled(false);
				setLocalVoiceBusy(false);
			}
			return;
		}
		if (detectedVramGb == null || detectedVramGb < 6) return;
		if (!naiaLoginDone) {
			setLocalVoiceMsg(t("settings.ttsNaiaRequired"));
			return;
		}
		setLocalVoiceBusy(true);
		try {
			let installation = await refreshVoxCpm2InstallationForOnboarding();
			if (!installation?.canStart) {
				setLocalVoiceMsg(t("voice.hostEngineInstalling"));
				await invoke("install_voxcpm2_runtime");
				installation = await refreshVoxCpm2InstallationForOnboarding();
				if (!installation?.canStart)
					throw new Error("voxcpm2_installation_verification_failed");
			}
			// Mirror SettingsTab's selection transaction (config → naia config →
			// slots manifest → start). Onboarding used to call start_voxcpm2 with
			// NO manifest, so Rust's profile gate failed with
			// voxcpm2_profile_manifest_not_ready, and the voice choice never
			// reached the persisted config (TTS stayed off after onboarding) —
			// #455. During onboarding the config file may not exist yet, so build
			// on a minimal base; the final completeWith snapshot merges over it.
			const naiaKeyForVoice =
				loadConfig()?.naiaKey ??
				localStorage.getItem("naia-remote-key") ??
				undefined;
			const voiceConfig = {
				...(loadConfig() ?? ({} as AppConfig)),
				localVoiceEnabled: true,
				ttsProvider: "naia-local-voice" as const,
				ttsEnabled: true,
				vllmTtsHost: DEFAULT_LOCAL_VOICE_HOST,
			} as AppConfig;
			saveConfig(voiceConfig);
			await writeNaiaConfig({
				...voiceConfig,
				...(naiaKeyForVoice ? { naiaKey: naiaKeyForVoice } : {}),
			} as unknown as Record<string, unknown>);
			await writeSlotsManifest(
				{
					...voiceConfig,
					...(naiaKeyForVoice ? { naiaKey: naiaKeyForVoice } : {}),
				},
				detectedVramGb ?? undefined,
			);
			// A resolved CASCADE_READY payload only proves ports were bound — Rust
			// checks the facade too, so re-confirm readiness the same way
			// SettingsTab's startCascadeAndConfirm does before trusting "ready".
			const ready = await invoke<string>("start_voxcpm2", {
				expectedLoaderProfile: "windows_trt_6g",
			});
			const afterStart = await refreshVoxCpm2InstallationForOnboarding();
			if (!afterStart?.ready) {
				setLocalVoiceMsg(t("settings.localVoiceInstallFailed"));
				return;
			}
			useCascadeAvatarStore
				.getState()
				.setLocalFacadeUrl(localVoiceFacadeUrlFromReady(ready));
			setLocalVoiceEnabled(true);
		} catch (error) {
			if (String(error).includes("voxcpm2_naia_member_login_required")) {
				await deleteSecretKey("naiaKey");
				localStorage.removeItem("naia-remote-key");
				setNaiaLoginDone(false);
				setLocalVoiceEnabled(false);
				setLocalVoiceMsg(t("settings.ttsNaiaRequired"));
			} else {
				setLocalVoiceMsg(t("settings.localVoiceInstallFailed"));
			}
		} finally {
			setLocalVoiceBusy(false);
		}
	}

	// UC12 step-flow graft(step2): isNewCore 일 때 assets/단계 전이/auth 를 core 컨트롤러 경유(mirror).
	// React=nav 권위(back/skip 견고), core=forward mirror(draft 누적·순서 불변식·provider-naia 게이트).
	// 영속은 completeWith(snapshot, step1) 유지. 미설정=old 경로 비파괴.
	const newCore = isNewCore();
	const sessionRef = useRef<OnboardingSession | null>(null);
	function core(): OnboardingSession | null {
		if (!newCore) return null;
		if (!sessionRef.current) sessionRef.current = makeOnboardingSession();
		return sessionRef.current;
	}
	// 현재 React state → core StepInput(전진 mirror용; core draft 는 persist 에 안 쓰임 = 값은 상태일관성/게이트용).
	// "voice"는 core-domain(@nextain/naia-os-core onboarding.ts)의 Step 에 없는 셸-전용 단계라 mirror 대상이
	// 아니다 — null 을 반환해 goNext 가 submit 을 건너뛴다(core 상태머신은 이 단계를 모르는 채 비파괴 유지).
	function buildStepInput(s: Step): StepInput | null {
		switch (s) {
			case "welcome":
				return { step: "welcome" };
			case "agentName":
				return { step: "agentName", agentName: agentName.trim() || t("onboard.defaultAgentName") };
			case "userName":
				return {
					step: "userName",
					userName: userName.trim(),
					honorific: honorific.trim() || undefined,
				};
			case "speechStyle":
				return {
					step: "speechStyle",
					speechStyle,
					extraPersona: extraPersona.trim() || undefined,
				};
			case "character":
				return {
					step: "character",
					vrmModel:
						avatarProvider === "vrm" ? selectedVrm || undefined : undefined,
				};
			case "background": {
				const bgPath = backgrounds.find((b) => b.url === selectedBg)?.path;
				return { step: "background", background: bgPath };
			}
			case "provider":
				return {
					step: "provider",
					// naiaLoginDone → nextain(게이트는 onNaiaAuthCallback 가 해제); 아니면 저장 provider 또는 nextain 기본.
					provider: naiaLoginDone
						? "nextain"
						: (loadConfig()?.provider ?? "nextain"),
				};
			case "complete":
				return { step: "complete" };
			case "voice":
				return null;
		}
	}

	const stepIndex = STEPS.indexOf(step);
	const didMount = useRef(false);
	const transitioning = useRef(false);

	useEffect(() => {
		latestRef.current = {
			agentName,
			userName,
			speechStyle,
			honorific,
			extraPersona,
			selectedVrm,
			avatarProvider,
			selectedNva,
			backgrounds,
			selectedBg,
			naiaLoginDone,
			memoryEmbeddingProvider,
			memoryLlmProvider,
			ttsEnabled,
			webVoiceLang:
				webVoices.find((voice) => voice.voiceURI === webVoiceURI)?.lang ?? "",
			localVoiceEnabled,
		};
	});

	// Load VRM list from naia-settings (newCore: core 가 LISTING 소유 → path 만 사용)
	useEffect(() => {
		const c = core();
		const load = c
			? c.assets("vrm-files").then((refs) => refs.map((r) => r.path))
			: listNaiaAssets("vrm-files");
		load
			.then((paths) => {
				const vrms = paths.filter((p) => p.toLowerCase().endsWith(".vrm"));
				setNaiaVrms(vrms);
				if (vrms.length > 0) {
					setSelectedVrm((prev) => {
						const savedFilename = prev.split(/[/\\]/).pop() ?? "";
						const isInstalled = vrms.some(
							(path) => path.split(/[/\\]/).pop() === savedFilename,
						);
						return !prev || isLegacyBundledVrmModel(prev) || !isInstalled
							? vrms[0]
							: prev;
					});
				}
			})
			.catch(() => {});
	}, []);

	useEffect(() => {
		listNaiaAssets("nva-files")
			.then((paths) => {
				setNaiaNvas(paths);
				if (paths.length === 0) return;
				// 기본은 나이아 실사(naia) — 목록 순서상 첫 항목(alpha 등)이 아니라
				// DEFAULT_NVA_MODEL 을 우선한다. 없으면 첫 항목으로 폴백.
				const naia = paths.find(
					(p) => p.split(/[/\\]/).pop() === DEFAULT_NVA_MODEL,
				);
				const chosen = naia ?? paths[0];
				let seeded = false;
				setSelectedNva((prev) => {
					if (prev) return prev;
					seeded = true;
					return chosen;
				});
				// #447-2: default provider is NVA — surface the default pick on the
				// live canvas behind the wizard without waiting for a click.
				if (seeded && avatarProvider === "naia-video-avatar") {
					publishAvatarChoice(
						"naia-video-avatar",
						chosen.split(/[/\\]/).pop() ?? chosen,
					);
				}
			})
			.catch(() => {});
	}, []);

	// Asset discovery can finish before App's parent effect has installed the
	// preview listener. Re-publish the resolved selection when the user actually
	// enters the character step; no click on the already-selected default card is
	// required. Explicit selections update these same values and therefore cannot
	// be overwritten by a stale default.
	useEffect(() => {
		if (
			step !== "character" ||
			avatarProvider !== "naia-video-avatar" ||
			!selectedNva
		)
			return;
		publishAvatarChoice(
			"naia-video-avatar",
			selectedNva.split(/[/\\]/).pop() ?? selectedNva,
		);
	}, [step, avatarProvider, selectedNva]);

	// Reset background on mount
	useEffect(() => {
		if (!didMount.current) {
			didMount.current = true;
			setBackgroundVideoUrl("");
			setBackgroundMediaType("");
		}
	}, [setBackgroundMediaType, setBackgroundVideoUrl]);

	// Load backgrounds from naia-settings (newCore: core LISTING → path; 셸은 path 에서 blob/asset URL 재유도)
	useEffect(() => {
		const c = core();
		const load = c
			? c.assets("background").then((refs) => refs.map((r) => r.path))
			: listNaiaAssets("background");
		load
			.then(async (paths) => {
				const bgs: BgOption[] = await Promise.all(
					paths.map(async (p) => {
						const type = getBackgroundMediaType(p);
						// Videos: use asset:// URL (blob URL crashes WebView2 for large files).
						const url =
							type === "video" ? toAssetUrl(p) : await toLocalBlobUrl(p);
						return {
							url,
							label:
								p
									.split(/[/\\]/)
									.pop()
									?.replace(/\.[^.]+$/, "") ?? p,
							path: p,
							type,
						};
					}),
				);
				setBackgrounds(bgs);
				if (bgs.length > 0) {
					// #447-3: default to naia-dawn-city (matches App DEFAULT_BG_VIDEO).
					// Fall back to the first available background if not found.
					const defaultBg =
						bgs.find((b) => b.path.toLowerCase().includes("dawn-city")) ??
						bgs[0];
					setSelectedBg(defaultBg.url);
				}
			})
			.catch(() => {});
	}, []);

	// Keep a ref to onComplete so the listener never needs to re-register when the
	// parent re-renders (which would create a new function reference each time).
	const onCompleteRef = useRef(onComplete);
	onCompleteRef.current = onComplete;

	// When Naia login completes: 게이트 해제. sub-LLM = naia(Gemini flash-lite 경로),
	// embedding = CPU offline(R2-1). 6슬롯 전체 기본값은 saveCompletedConfig 의 applyNaiaSlotDefaults 가 일괄 적용.
	useEffect(() => {
		if (naiaLoginDone) {
			setMemoryEmbeddingProvider("offline");
			setMemoryLlmProvider("naia");
		}
	}, [naiaLoginDone]);

	// Listen for Naia OAuth callback in provider step.
	// [] dep — register once. onCompleteRef.current always points to latest prop.
	useEffect(() => {
		const unlisten = listen<NaiaAuthPayload>(
			"naia_auth_complete",
			async (event) => {
				if (naiaTimerRef.current) clearTimeout(naiaTimerRef.current);
				try {
					// Local voice activation reads the native secure store. Persist the
					// credential before exposing the voice step so an immediate click
					// cannot race the keychain write.
					await saveSecretKey("naiaKey", event.payload.naiaKey);
					// The agent checkout may not exist yet during first-run onboarding.
					// Native secure storage is the activation gate; the agent mirror is
					// best-effort and will be reconciled once a checkout is selected.
					await writeAgentKeyStrict(
						"nextain",
						"naiaKey",
						event.payload.naiaKey,
					).catch(() => {});
				} catch (error) {
					setNaiaLoginWaiting(false);
					setCompletionError(String(error));
					return;
				}
				localStorage.setItem("naia-remote-key", event.payload.naiaKey);
				if (event.payload.naiaUserId) {
					localStorage.setItem("naia-remote-user-id", event.payload.naiaUserId);
				}
				setNaiaLoginWaiting(false);
				setNaiaLoginDone(true);
				setNaiaAuthPayload(event.payload);
				// Cache before sending so crash-restart can replay the key.
				invoke("store_startup_message", {
					message: JSON.stringify({
						type: "auth_update",
						naiaKey: event.payload.naiaKey,
					}),
				})
					.catch(() => {})
					.then(() => sendAuthUpdate(event.payload.naiaKey).catch(() => {}));
				// core mirror(비파괴 추가): naiaLoginDone=게이트 해제 + NAIA_ANYLLM_API_KEY 키체인
				// (idempotent, completeWith 와 동값). 기존 sendAuthUpdate(런타임 push)·store_startup_message 유지 = 보완.
				await core()
					?.onNaiaAuthCallback(event.payload.naiaKey)
					.catch(() => {});
				// Voice choice is part of onboarding. Login must not skip it.
				setStep("voice");
			},
		);
		return () => {
			unlisten.then((fn) => fn());
			if (naiaTimerRef.current) clearTimeout(naiaTimerRef.current);
		};
	}, []);

	function goNext() {
		if (transitioning.current) return;
		const next = STEPS[stepIndex + 1];
		if (!next) return;
		// core forward mirror(비차단): 떠나는 현재 step 의 input 을 컨트롤러에 제출(draft·순서·게이트 행사).
		// 게이트 차단/step-mismatch 시 no-op — UI nav 는 막지 않음(persist=snapshot 무영향).
		// buildStepInput 이 null(core-domain 에 없는 셸-전용 단계, 예: voice)이면 제출을 건너뛴다.
		const stepInput = buildStepInput(step);
		if (stepInput) {
			void core()
				?.submit(stepInput)
				.catch(() => {});
		}
		transitioning.current = true;
		setStep(next);
		setTimeout(() => {
			// "complete" message is added by handleComplete after saving — skip here
			if (next !== "complete") {
				addMessage({
					role: "assistant",
					content: stepChat(
						next,
						agentName.trim() || t("onboard.defaultAgentName"),
						userName.trim(),
					),
				});
			}
			transitioning.current = false;
		}, 300);
	}

	function goBack() {
		const prev = STEPS[stepIndex - 1];
		if (!prev) return;
		setStep(prev);
	}

	// #447-2: reflect the avatar choice on the live canvas behind the wizard.
	// A fresh install has no saved config yet during onboarding, so writing to
	// config here would no-op (loadConfig() === null). Instead announce the pick
	// on a dedicated preview event that App applies to the live avatar canvas
	// directly (VRM via the avatar store, NVA via the video canvas). Completion
	// still persists avatarProvider/nvaModel through saveCompletedConfig.
	function publishAvatarChoice(
		provider: "vrm" | "naia-video-avatar",
		model: string,
	) {
		window.dispatchEvent(
			new CustomEvent("naia-avatar-preview", {
				detail: { provider, model },
			}),
		);
	}

	function handleVrmSelect(path: string) {
		setAvatarProvider("vrm");
		setSelectedVrm(path);
		setAvatarModelPath(path);
		publishAvatarChoice("vrm", path.split(/[/\\]/).pop() ?? path);
	}

	function handleNvaSelect(path: string) {
		setAvatarProvider("naia-video-avatar");
		setSelectedNva(path);
		publishAvatarChoice("naia-video-avatar", path.split(/[/\\]/).pop() ?? path);
	}

	function handleBgSelect(url: string) {
		setSelectedBg(url);
		const bg = backgrounds.find((item) => item.url === url);
		setBackgroundMediaType(bg?.type ?? "");
		setBackgroundVideoUrl(url);
	}

	async function handleNaiaLogin() {
		setNaiaLoginWaiting(true);
		naiaTimerRef.current = setTimeout(
			() => setNaiaLoginWaiting(false),
			180_000,
		);
		try {
			const lang = getLocale();
			// Onboarding runs before the browser app is mounted, so
			// browser_open_login would succeed but the app can't show.
			// Use the system browser directly instead.
			const state = await invoke<string>("generate_oauth_state").catch(
				() => "",
			);
			const params = new URLSearchParams({
				redirect: "desktop",
				// www.naia.land buildLoginRedirect requires BOTH redirect=desktop
				// AND app=naia-os (2026-05-28 security gate) — without `app` it
				// redirects to /dashboard and the desktop callback never fires.
				app: "naia-os",
				source: "desktop",
				// #341 옵션 B — Linux dev:tauri 에서 naia:// scheme OS 미등록
				// 우회. Rust 측이 127.0.0.1:18792/auth/callback 에서 HTTP 로
				// 받아 동일한 naia_auth_complete 이벤트 emit. 운영 웹 측이
				// redirect_uri 받으면 그 URL 로 redirect; 받지 못해도 기존
				// deep-link path 가 fallback.
				redirect_uri: OAUTH_CALLBACK_URL,
			});
			if (state) params.set("state", state);
			await openUrl(
				`${getNaiaWebBaseUrl()}/${lang}/login?${params.toString()}`,
			);
		} catch {
			setNaiaLoginWaiting(false);
		}
	}

	async function saveCompletedConfig(
		auth?: NaiaAuthPayload,
		snapshot: OnboardingSnapshot = {
			agentName,
			userName,
			speechStyle,
			honorific,
			extraPersona,
			selectedVrm,
			avatarProvider,
			selectedNva,
			backgrounds,
			selectedBg,
			naiaLoginDone,
			memoryEmbeddingProvider,
			memoryLlmProvider,
			ttsEnabled,
			webVoiceLang:
				webVoices.find((voice) => voice.voiceURI === webVoiceURI)?.lang ?? "",
			localVoiceEnabled,
		},
	) {
		// Own-key setup is no longer collected in onboarding (#447-5) — the full
		// Settings screen owns provider + model + key. A fresh install defaults to
		// the Naia account provider; returning users keep their saved config.
		// Typed as a partial so optional carry-over fields (workspaceRoot,
		// ttsProvider) read as `string | undefined` off the fresh-install fallback.
		const base: Partial<AppConfig> = loadConfig() ?? {
			provider: "nextain",
			model: NAIA_SLOT_DEFAULTS.main.model,
		};
		const vrmPath =
			snapshot.avatarProvider === "vrm"
				? snapshot.selectedVrm || naiaVrms[0] || undefined
				: undefined;
		const nvaPath =
			snapshot.avatarProvider === "naia-video-avatar"
				? snapshot.selectedNva || naiaNvas[0] || undefined
				: undefined;
		const selectedBgOption = snapshot.backgrounds.find(
			(bg) => bg.url === snapshot.selectedBg,
		);
		const bgFilename = selectedBgOption?.path.split(/[/\\]/).pop() ?? undefined;

		const speechDesc =
			snapshot.speechStyle === "casual"
				? "casually and warmly"
				: snapshot.speechStyle === "formal"
					? "formally and professionally"
					: "respectfully using honorifics";
		const personaBase = `You are ${snapshot.agentName.trim() || "Naia"}, an AI companion. Speak ${speechDesc}.`;
		const persona = snapshot.extraPersona?.trim()
			? `${personaBase}\n\n${snapshot.extraPersona.trim()}`
			: personaBase;
		// auth(naia 로그인) 시: 6슬롯 Gemini 기본값은 applyNaiaSlotDefaults 가 아래서 일괄 적용.
		// 따라서 auth 시에는 스냅샣 memory provider 를 주입하지 않고(비파괴 기본값 적용이 채움),
		// BYO 시에만 사용자 선택값을 유지한다.
		const completedFlat: Record<string, unknown> = {
			...base,
			provider: auth ? "nextain" : base.provider,
			model: auth ? base.model || NAIA_SLOT_DEFAULTS.main.model : base.model,
			agentName: snapshot.agentName.trim() || "Naia",
			userName: snapshot.userName.trim() || undefined,
			speechStyle: snapshot.speechStyle,
			honorific: snapshot.honorific.trim() || undefined,
			vrmModel: vrmPath,
			avatarProvider: snapshot.avatarProvider,
			nvaModel: nvaPath,
			backgroundVideo: bgFilename,
			persona,
			...(auth ? { naiaKey: auth.naiaKey, naiaUserId: auth.naiaUserId } : {}),
			workspaceRoot: getAdkPath() || base.workspaceRoot || undefined,
			onboardingComplete: false,
			...(snapshot.localVoiceEnabled
				? {
						ttsEnabled: true,
						ttsProvider: "naia-local-voice" as const,
						localVoiceEnabled: true,
						vllmTtsHost: DEFAULT_LOCAL_VOICE_HOST,
					}
				: {
						ttsEnabled: snapshot.ttsEnabled,
						ttsProvider: snapshot.ttsEnabled
							? ("browser" as const)
							: base.ttsProvider,
						...(snapshot.ttsEnabled && snapshot.webVoiceLang
							? { voice: snapshot.webVoiceLang }
							: {}),
					}),
			...(!auth && snapshot.memoryEmbeddingProvider !== "none"
				? { memoryEmbeddingProvider: snapshot.memoryEmbeddingProvider }
				: {}),
			...(!auth && snapshot.memoryLlmProvider !== "none"
				? { memoryLlmProvider: snapshot.memoryLlmProvider }
				: {}),
		};
		// FR-SLOT.3 / R2-1: naia 게이트 통과 시 미설정 슬롯에 Gemini 기본값 자동 적용(비파괴).
		const finalConfig: AppConfig = auth
			? applyNaiaSlotDefaults(completedFlat as unknown as AppConfig)
			: (completedFlat as unknown as AppConfig);
		await saveConfigSecure(finalConfig);

		if (vrmPath) setAvatarModelPath(vrmPath);
		return finalConfig as unknown as Record<string, unknown>;
	}

	async function handleComplete() {
		if (completing) return;
		setCompleting(true);
		setCompletionError("");
		try {
			const completedFlat = await saveCompletedConfig(
				naiaAuthPayload ?? undefined,
			);
			// G-01: sync to naia-settings/config.json so the standalone agent picks
			// up the onboarding result. This MUST be the freshly completed config —
			// loadConfig() here returned the PRE-LOGIN snapshot (completedFlat is
			// only persisted below), so reloadAgentSettings() re-read a config
			// without naiaKey/provider and the FIRST session answered with empty
			// 0-token replies until an app restart (#449 재발, 2026-08-18 실기).
			await writeNaiaConfig({
				...(completedFlat as Record<string, unknown>),
				...buildNaiaConfigEnv(completedFlat as unknown as AppConfig),
			});
			// Write naiaKey to OS keychain so standalone naia-agent can read it.
			if (typeof completedFlat.naiaKey === "string")
				await writeAgentKeyStrict(
					String(completedFlat.provider || "nextain"),
					"naiaKey",
					completedFlat.naiaKey,
				);
			if (typeof completedFlat.naiaKey === "string") {
				await sendAuthUpdateStrict(completedFlat.naiaKey);
				await activateNaiaLlm(
					completedFlat.naiaKey,
					String(completedFlat.provider || "nextain"),
					String(completedFlat.model || NAIA_SLOT_DEFAULTS.main.model),
				);
				// Do not leave the renderer with the pre-login zero balance. Fetch with
				// the same credential before committing onboarding, then prime the shared
				// dashboard cache for the app that mounts after this wizard unmounts.
				const balancePayload = await fetchLabBalancePayload(
					LAB_GATEWAY_URL,
					completedFlat.naiaKey,
				);
				const credits = parseLabCredits(balancePayload);
				if (credits == null)
					throw new Error("authenticated balance response is invalid");
				primeLabCredits(credits);
			} else {
				await reloadAgentSettings();
			}
			const committedFlat = { ...completedFlat, onboardingComplete: true };
			if (newCore) {
				await core()?.completeWith(committedFlat);
			} else {
				await saveConfigSecure(committedFlat as unknown as AppConfig);
				const committed = loadConfig();
				if (committed)
					await writeNaiaConfig({
						...(committed as unknown as Record<string, unknown>),
						...buildNaiaConfigEnv(committed),
						onboardingComplete: true,
					});
			}
			addMessage({
				role: "assistant",
				content: stepChat(
					"complete",
					agentName.trim() || t("onboard.defaultAgentName"),
					userName.trim(),
				),
			});
			setTimeout(() => {
				onComplete();
				window.dispatchEvent(
					new CustomEvent("naia_auth_ready", {
						detail: { source: "auth-complete" },
					}),
				);
			}, 1200);
		} catch (error) {
			setCompletionError(
				getLocale() === "ko"
					? `설정을 적용하지 못했습니다. 다시 시도해 주세요. (${String(error)})`
					: `Could not apply settings. Please try again. (${String(error)})`,
			);
		} finally {
			setCompleting(false);
		}
	}

	// #447-5: "직접 설정" no longer collects a provider-less key inline. It finishes
	// onboarding with the Naia-account default and opens the full Settings screen,
	// which owns provider + model + key selection. setActiveApp persists in the app
	// store, so Settings is focused once the main app mounts after onboarding.
	function handleGoToSettings() {
		useAppStore.getState().setActiveApp("settings");
		void handleComplete();
	}

	const isFirst = stepIndex === 0;
	const isCompleteStep = step === "complete";
	const progressSteps = STEPS.slice(0, -1); // exclude "complete" from dot indicators

	return (
		<div className="onboarding-app">
			{/* Progress dots */}
			<div className="onboarding-progress">
				{progressSteps.map((s, i) => (
					<div
						key={s}
						className={`onboarding-progress__dot${
							s === step ? " onboarding-progress__dot--active" : ""
						}${i < stepIndex ? " onboarding-progress__dot--done" : ""}`}
					/>
				))}
			</div>

			{/* Step content */}
			<div className="onboarding-step">
				{step === "welcome" && (
					<>
						<h2 className="onboarding-step__title">Naia Alpha</h2>
						<div className="onboarding-welcome">
							<p className="onboarding-welcome__text">
								{t("onboard.welcome.opensourceDesc")}
							</p>
							<div className="onboarding-welcome__badge">⚠ Alpha</div>
							<p className="onboarding-welcome__text">
								{t("onboard.welcome.alphaDesc")}
							</p>
							<button
								type="button"
								className="onboarding-welcome__github-btn"
								onClick={() =>
									import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
										openUrl("https://github.com/nextain/naia-shell"),
									)
								}
							>
								{t("onboard.welcome.githubBtn")}
							</button>
							<button
								type="button"
								className="onboarding-welcome__github-btn"
								onClick={() =>
									import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
										openUrl("https://discord.com/invite/FGYJN7auty"),
									)
								}
							>
								{t("onboard.welcome.discordBtn")}
							</button>
							<button
								type="button"
								className="onboarding-welcome__github-btn"
								onClick={() =>
									import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
										openUrl("https://www.naia.land/donation"),
									)
								}
							>
								{t("onboard.welcome.donationBtn")}
							</button>
						</div>
					</>
				)}

				{step === "agentName" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.agentName.title")}
						</h2>
						<input
							className="onboarding-step__input"
							value={agentName}
							onChange={(e) => setAgentName(e.target.value)}
							placeholder="Naia"
							maxLength={20}
							autoFocus
							onKeyDown={(e) => e.key === "Enter" && goNext()}
						/>
						<p className="onboarding-step__hint">
							{t("onboard.agentName.description")}
						</p>
					</>
				)}

				{step === "userName" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.userName.title").replace(
								"{agent}",
								agentName.trim() || t("onboard.defaultAgentName"),
							)}
						</h2>
						<input
							className="onboarding-step__input"
							value={userName}
							onChange={(e) => setUserName(e.target.value)}
							placeholder={t("onboard.name.placeholder")}
							maxLength={20}
							autoFocus
							onKeyDown={(e) => e.key === "Enter" && goNext()}
						/>
						<p className="onboarding-step__hint">
							{t("onboard.userName.description")}
						</p>
					</>
				)}

				{step === "speechStyle" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.speechStyle.title").replace(
								"{agent}",
								agentName.trim() || t("onboard.defaultAgentName"),
							)}
						</h2>
						<div className="onboarding-step__options">
							{(["casual", "formal"] as const).map((style) => (
								<button
									key={style}
									type="button"
									className={`onboarding-step__option${speechStyle === style ? " onboarding-step__option--selected" : ""}`}
									onClick={() => setSpeechStyle(style)}
								>
									<span className="onboarding-step__option-label">
										{style === "casual"
											? t("onboard.speechStyle.casual")
											: t("onboard.speechStyle.formal")}
									</span>
									<span className="onboarding-step__option-desc">
										{style === "casual"
											? t("onboard.speechStyle.casualDesc")
											: t("onboard.speechStyle.formalDesc")}
									</span>
								</button>
							))}
						</div>
						<input
							className="onboarding-step__input onboarding-step__input--sm"
							value={honorific}
							onChange={(e) => setHonorific(e.target.value)}
							placeholder={t("onboard.speechStyle.honorificPlaceholder")}
							maxLength={10}
						/>
						<textarea
							className="onboarding-step__input onboarding-step__input--persona"
							value={extraPersona}
							onChange={(e) => setExtraPersona(e.target.value)}
							placeholder="추가 페르소나 설정 (선택) — 성격, 말투 스타일, 행동 규칙 등을 자유롭게 입력하세요."
							rows={5}
						/>
					</>
				)}

				{step === "character" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.character.title")
								.replace("{user}", userName.trim() || "")
								.replace("{agent}", agentName.trim() || t("onboard.defaultAgentName"))}
						</h2>
						<div className="onboarding-step__avatar-grid">
							{naiaVrms.length === 0 && naiaNvas.length === 0 ? (
								<p className="onboarding-step__hint onboarding-step__hint--warn">
									{t("onboard.character.empty")}
								</p>
							) : (
								<>
									{naiaVrms.map((path) => {
										const filename = path.split(/[/\\]/).pop() ?? path;
										const label = filename.replace(/\.vrm$/i, "");
										const thumb = `/avatars/${filename.replace(/\.vrm$/i, ".webp")}`;
										return (
											<button
												key={path}
												type="button"
												aria-pressed={
													avatarProvider === "vrm" && selectedVrm === path
												}
												className={`onboarding-step__avatar-card${avatarProvider === "vrm" && selectedVrm === path ? " onboarding-step__avatar-card--selected" : ""}`}
												onClick={() => handleVrmSelect(path)}
											>
												<img
													src={thumb}
													className="onboarding-step__avatar-img"
													alt={label}
													onError={(e) => {
														(
															e.currentTarget as HTMLImageElement
														).style.display = "none";
													}}
												/>
												<span className="onboarding-step__avatar-badge">
													VRM
												</span>
												<span className="onboarding-step__avatar-label">
													{label}
												</span>
											</button>
										);
									})}
									{naiaNvas.map((path) => {
										const filename = path.split(/[/\\]/).pop() ?? path;
										const label = filename.replace(/\.nva$/i, "");
										return (
											<button
												key={path}
												type="button"
												aria-pressed={
													avatarProvider === "naia-video-avatar" &&
													selectedNva === path
												}
												className={`onboarding-step__avatar-card${avatarProvider === "naia-video-avatar" && selectedNva === path ? " onboarding-step__avatar-card--selected" : ""}`}
												onClick={() => handleNvaSelect(path)}
											>
												<NvaThumbnail path={path} label={label} />
												<span className="onboarding-step__avatar-badge">
													NVA
												</span>
												<span className="onboarding-step__avatar-label">
													{label}
												</span>
											</button>
										);
									})}
								</>
							)}
						</div>
						<p className="onboarding-step__hint">
							{t("onboard.character.hint")}
						</p>
					</>
				)}

				{step === "background" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.background.title")}
						</h2>
						<div className="onboarding-step__bg-grid">
							{backgrounds.map((bg) => (
								<button
									key={bg.url}
									type="button"
									className={`onboarding-step__bg-card${selectedBg === bg.url ? " onboarding-step__bg-card--selected" : ""}`}
									onClick={() => handleBgSelect(bg.url)}
								>
									{bg.type === "video" ? (
										<BackgroundThumbnail background={bg} />
									) : (
										<img
											src={bg.url}
											alt={bg.label}
											className="onboarding-step__bg-img"
										/>
									)}
									<span className="onboarding-step__bg-label">{bg.label}</span>
								</button>
							))}
						</div>
						<p className="onboarding-step__hint">
							{t("onboard.background.hint")}
						</p>
					</>
				)}

				{step === "provider" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.connect.title")}
						</h2>
						<p className="onboarding-step__hint">
							{t("onboard.connect.description")}
						</p>
						<div className="onboarding-step__provider-done">
							<span className="onboarding-step__provider-check">
								{t("onboard.connect.gpuBadge")}
							</span>
							<p>
								{onboardingGpuSummary}
								<br />
								{onboardingGpuRecommendation}
								<br />
								{t("onboard.connect.runtimeBoundary")}
							</p>
						</div>
						{naiaLoginDone ? (
							<>
								<div className="onboarding-step__provider-done">
									<span className="onboarding-step__provider-check">
										{t("onboard.connect.okBadge")}
									</span>
									<p>{t("onboard.lab.connected")}</p>
								</div>
								<button
									type="button"
									className="onboarding-step__link onboarding-step__link--muted"
									onClick={goNext}
									style={{ marginTop: 16 }}
								>
									{t("onboard.next")}
								</button>
							</>
						) : (
							<>
								<button
									type="button"
									className="onboarding-step__naia-btn"
									onClick={handleNaiaLogin}
									disabled={naiaLoginWaiting}
									style={{ marginTop: 16, width: "100%" }}
								>
									{naiaLoginWaiting
										? t("onboard.lab.waiting")
										: t("onboard.connect.naiaPath")}
								</button>
								{/* #447-5: own-key/provider setup moved out of onboarding —
								    "직접 설정" finishes onboarding and opens the full Settings
								    screen (provider + model + key) instead of a provider-less
								    inline key box. "나중에 설정" keeps configuring later. */}
								<div
									style={{
										display: "flex",
										flexDirection: "column",
										gap: 8,
										marginTop: 12,
									}}
								>
									<button
										type="button"
										className="onboarding-step__link"
										onClick={handleGoToSettings}
									>
										{t("onboard.connect.byoPath")}
									</button>
									<button
										type="button"
										className="onboarding-step__link onboarding-step__link--muted"
										onClick={goNext}
									>
										{t("onboard.connect.setupLater")}
									</button>
								</div>
							</>
						)}
					</>
				)}

				{step === "voice" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.voice.title")}
						</h2>
						<p className="onboarding-step__hint">
							{t("onboard.voice.description")}
						</p>
						<div className="onboarding-step__options">
							<button
								type="button"
								className={`onboarding-step__option${ttsEnabled ? " onboarding-step__option--selected" : ""}`}
								onClick={() => setTtsEnabled(true)}
							>
								<span className="onboarding-step__option-label">
									{t("onboard.voice.on")}
								</span>
							</button>
							<button
								type="button"
								className={`onboarding-step__option${!ttsEnabled ? " onboarding-step__option--selected" : ""}`}
								onClick={() => setTtsEnabled(false)}
							>
								<span className="onboarding-step__option-label">
									{t("onboard.voice.off")}
								</span>
							</button>
						</div>
						{ttsEnabled && webVoices.length > 0 && (
							<div className="onboarding-step__voice-picker">
								<select
									className="onboarding-step__input"
									value={webVoiceURI}
									onChange={(e) => setWebVoiceURI(e.target.value)}
								>
									{webVoices.map((voice) => (
										<option key={voice.voiceURI} value={voice.voiceURI}>
											{voice.name} ({voice.lang})
										</option>
									))}
								</select>
								<button
									type="button"
									className="onboarding-step__link"
									onClick={previewWebVoice}
									disabled={voicePreviewing}
								>
									{voicePreviewing
										? t("onboard.voice.previewing")
										: t("onboard.voice.preview")}
								</button>
							</div>
						)}
						{detectedVramGb != null && detectedVramGb >= 6 && (
							<div className="onboarding-step__provider-done">
								<span className="onboarding-step__provider-check">
									{t("onboard.voice.localBadge")}
								</span>
								<p>{t("onboard.voice.localHint")}</p>
								<button
									type="button"
									className={`onboarding-step__option${localVoiceEnabled ? " onboarding-step__option--selected" : ""}`}
									style={{ marginTop: 8 }}
									onClick={toggleLocalVoice}
									disabled={localVoiceBusy || !naiaLoginDone}
								>
									<span className="onboarding-step__option-label">
										{localVoiceBusy
											? t("onboard.voice.localBusy")
											: localVoiceEnabled
												? t("onboard.voice.localOn")
												: t("onboard.voice.localOff")}
									</span>
								</button>
								{!naiaLoginDone && (
									<p className="onboarding-step__hint onboarding-step__hint--warn">
										{t("settings.ttsNaiaRequired")}
									</p>
								)}
								{localVoiceMsg && (
									<p className="onboarding-step__hint onboarding-step__hint--warn">
										{localVoiceMsg}
									</p>
								)}
							</div>
						)}
					</>
				)}

				{step === "complete" && (
					<>
						<h2 className="onboarding-step__title">
							{t("onboard.complete.greeting").replace(
								"{name}",
								userName.trim() || "게스트",
							)}
							{localVoiceInstallation?.canStart === false && !localVoiceMsg && (
								<p className="onboarding-step__hint onboarding-step__hint--warn">
									{t("settings.localVoiceInstallRequired")}
								</p>
							)}
						</h2>
						<p className="onboarding-step__hint">
							{t("onboard.complete.ready").replace(
								"{agent}",
								agentName.trim() || t("onboard.defaultAgentName"),
							)}
						</p>
					</>
				)}
			</div>

			{/* Navigation */}
			<div className="onboarding-step__actions">
				{isCompleteStep && completionError && (
					<p
						role="alert"
						className="onboarding-step__hint onboarding-step__hint--warn onboarding-step__completion-error"
					>
						{completionError}
					</p>
				)}
				{!isFirst && !isCompleteStep && (
					<button
						type="button"
						className="onboarding-step__back-btn"
						onClick={goBack}
					>
						{t("onboard.back")}
					</button>
				)}
				{/* Provider step: skip handled internally; other steps show Next/Start */}
				{step !== "provider" && (
					<button
						type="button"
						className="onboarding-step__next-btn"
						onClick={isCompleteStep ? handleComplete : goNext}
						disabled={isCompleteStep && completing}
					>
						{isCompleteStep && completing
							? getLocale() === "ko"
								? "설정 적용 중…"
								: "Applying settings…"
							: isCompleteStep
								? t("onboard.complete.start")
								: t("onboard.next")}
					</button>
				)}
				{step === "provider" && naiaLoginDone && (
					<button
						type="button"
						className="onboarding-step__next-btn"
						onClick={goNext}
					>
						{t("onboard.next")}
					</button>
				)}
			</div>
		</div>
	);
}
