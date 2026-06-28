import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { buildNaiaConfigEnv, getAdkPath, listNaiaAssets, toAssetUrl, toLocalBlobUrl, writeAgentKey, writeNaiaConfig } from "../lib/adk-store";
import { DEFAULT_AVATAR_MODEL } from "../lib/avatar-presets";
import { isNewCore, sendAuthUpdate } from "../lib/chat-service";
import { type AppConfig, NAIA_WEB_BASE_URL, loadConfig, saveConfigSecure } from "../lib/config";
import { getDefaultLlmModel } from "../lib/llm";
import {
	makeOnboardingSession,
	type OnboardingSession,
	type StepInput,
} from "../lib/onboarding-core";
import { getLocale, t } from "../lib/i18n";
import { detectGpuVramGb } from "../lib/capabilities/gpu";
import {
	type VramTierId,
	selectVramTier,
} from "../lib/capabilities/vram-tiers";
import { useAvatarStore } from "../stores/avatar";
import { useChatStore } from "../stores/chat";

type Step =
	| "welcome"
	| "agentName"
	| "userName"
	| "speechStyle"
	| "character"
	| "background"
	| "provider"
	| "complete";

const STEPS_WITHOUT_NAIA: Step[] = [
	"welcome",
	"agentName",
	"userName",
	"speechStyle",
	"character",
	"background",
	"provider",
	"complete",
];

function vramTierLabelKey(id: VramTierId) {
	return `settings.vramTier.${id}` as const;
}

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "ogg", "avi"]);
function isVideo(url: string) {
	return VIDEO_EXTS.has(
		url.split("?")[0].split(".").pop()?.toLowerCase() ?? "",
	);
}

function stepChat(step: Step, name: string, user: string): string {
	const n = name || "나이아";
	const u = user ? `${user}님` : "";
	switch (step) {
		case "welcome":
			return "안녕하세요! 시작하기 전에 잠깐 확인해 주세요 😊";
		case "agentName":
			return "안녕하세요! 저는 나이아예요. 제 이름을 지어주세요! ✨";
		case "userName":
			return `${n}! 정말 좋은 이름이에요. 그럼 저는 당신을 어떻게 부를까요?`;
		case "speechStyle":
			return `${u || ""}! 어떤 말투로 대화할까요? 편한 걸 골라주세요 😊`;
		case "character":
			return "제 외모를 골라주세요! 마음에 드는 캐릭터가 있나요? 🌸";
		case "background":
			return "배경화면도 함께 골라볼까요? 클릭하면 바로 바뀌어요! 🌟";
		case "provider":
			return "거의 다 왔어요! 저의 두뇌를 연결해 주세요 🧠";
		case "complete":
			return `${u ? u + ", " : ""}준비 완료! ${n}와 함께 시작해요! 🎉`;
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
	backgrounds: BgOption[];
	selectedBg: string;
	apiKey: string;
	naiaLoginDone: boolean;
	memoryEmbeddingProvider: "none" | "offline" | "vllm" | "ollama" | "naia";
	memoryLlmProvider: "none" | "naia" | "vllm" | "ollama";
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
	const [selectedVrm, setSelectedVrm] = useState(DEFAULT_AVATAR_MODEL);
	const [backgrounds, setBackgrounds] = useState<BgOption[]>([]);
	const [selectedBg, setSelectedBg] = useState("");
	// Provider step state
	const [apiKey, setApiKey] = useState("");
	const [apiKeyMode, setApiKeyMode] = useState(false);
	const [naiaLoginWaiting, setNaiaLoginWaiting] = useState(false);
	const [naiaLoginDone, setNaiaLoginDone] = useState(hasNaiaKey);
	const [detectedVramGb, setDetectedVramGb] = useState<number | null>(null);
	// Auth payload from OAuth — held until wizard completes
	const [naiaAuthPayload, setNaiaAuthPayload] = useState<NaiaAuthPayload | null>(null);
	// memoryAI step state — default to "naia" when Naia key already present
	const [memoryEmbeddingProvider, setMemoryEmbeddingProvider] = useState<
		"none" | "offline" | "vllm" | "ollama" | "naia"
	>(hasNaiaKey ? "naia" : "none");
	const [memoryLlmProvider, setMemoryLlmProvider] = useState<
		"none" | "naia" | "vllm" | "ollama"
	>(hasNaiaKey ? "naia" : "none");
	const naiaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestRef = useRef<OnboardingSnapshot | null>(null);
	const recommendedVramTier =
		detectedVramGb != null ? selectVramTier(detectedVramGb) : null;
	const onboardingGpuSummary =
		detectedVramGb != null
			? t("onboard.connect.vramDetected").replace(
					"{vram}",
					String(detectedVramGb),
				)
			: t("onboard.connect.vramUnknown");
	const onboardingGpuRecommendation = recommendedVramTier
		? t("onboard.connect.vramTier").replace(
				"{tier}",
				t(vramTierLabelKey(recommendedVramTier.id)),
			)
		: t("onboard.connect.vramCloud");

	useEffect(() => {
		detectGpuVramGb().then(setDetectedVramGb);
	}, []);

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
	function buildStepInput(s: Step): StepInput {
		switch (s) {
			case "welcome":
				return { step: "welcome" };
			case "agentName":
				return { step: "agentName", agentName: agentName.trim() || "나이아" };
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
				return { step: "character", vrmModel: selectedVrm || undefined };
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
					...(apiKeyMode && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
				};
			case "complete":
				return { step: "complete" };
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
			backgrounds,
			selectedBg,
			apiKey,
			naiaLoginDone,
			memoryEmbeddingProvider,
			memoryLlmProvider,
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
				if (vrms.length > 0) setSelectedVrm((prev) => prev || vrms[0]);
			})
			.catch(() => {});
	}, []);

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
						const url = type === "video" ? toAssetUrl(p) : await toLocalBlobUrl(p);
						return {
							url,
							label: p.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") ?? p,
							path: p,
							type,
						};
					}),
				);
				setBackgrounds(bgs);
				if (bgs.length > 0) {
					// Default to the "space" background (naia 우주선) — it's the default shown in the app.
					// Fall back to the first available background if not found.
					const spaceBg =
						bgs.find((b) => b.path.toLowerCase().includes("space")) ??
						bgs[0];
					setSelectedBg(spaceBg.url);
				}
			})
			.catch(() => {});
	}, []);

	// Keep a ref to onComplete so the listener never needs to re-register when the
	// parent re-renders (which would create a new function reference each time).
	const onCompleteRef = useRef(onComplete);
	onCompleteRef.current = onComplete;

	// When Naia login completes, auto-select "naia" for memory AI providers.
	useEffect(() => {
		if (naiaLoginDone) {
			setMemoryEmbeddingProvider("naia");
			setMemoryLlmProvider("naia");
		}
	}, [naiaLoginDone]);

	// Listen for Naia OAuth callback in provider step.
	// [] dep — register once. onCompleteRef.current always points to latest prop.
	useEffect(() => {
		const unlisten = listen<NaiaAuthPayload>(
			"naia_auth_complete",
			(event) => {
				if (naiaTimerRef.current) clearTimeout(naiaTimerRef.current);
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
				void core()?.onNaiaAuthCallback(event.payload.naiaKey).catch(() => {});
				// Advance to complete step after Naia login
				setStep("complete");
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
		void core()
			?.submit(buildStepInput(step))
			.catch(() => {});
		transitioning.current = true;
		setStep(next);
		setTimeout(() => {
			// "complete" message is added by handleComplete after saving — skip here
			if (next !== "complete") {
				addMessage({
					role: "assistant",
					content: stepChat(next, agentName.trim() || "나이아", userName.trim()),
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

	function handleVrmSelect(path: string) {
		setSelectedVrm(path);
		setAvatarModelPath(path);
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
			// Onboarding runs before the browser panel is mounted, so
			// browser_open_login would succeed but the panel can't show.
			// Use the system browser directly instead.
			const state = await invoke<string>("generate_oauth_state").catch(
				() => "",
			);
			const params = new URLSearchParams({
				redirect: "desktop",
				// naia.nextain.io buildLoginRedirect requires BOTH redirect=desktop
				// AND app=naia-os (2026-05-28 security gate) — without `app` it
				// redirects to /dashboard and the desktop callback never fires.
				app: "naia-os",
				source: "desktop",
				// #341 옵션 B — Linux dev:tauri 에서 naia:// scheme OS 미등록
				// 우회. Rust 측이 127.0.0.1:18792/auth/callback 에서 HTTP 로
				// 받아 동일한 naia_auth_complete 이벤트 emit. 운영 웹 측이
				// redirect_uri 받으면 그 URL 로 redirect; 받지 못해도 기존
				// deep-link path 가 fallback.
				redirect_uri: "http://127.0.0.1:18792/auth/callback",
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
			backgrounds,
			selectedBg,
			apiKey,
			naiaLoginDone,
			memoryEmbeddingProvider,
			memoryLlmProvider,
		},
	) {
		const isByo = !!snapshot.apiKey.trim() && !snapshot.naiaLoginDone && !auth;
		const base = loadConfig() ?? {
			provider: isByo ? "gemini" : "nextain",
			model: isByo ? getDefaultLlmModel("gemini") : "gemini-2.5-flash",
			apiKey: "",
		};
		const vrmPath = snapshot.selectedVrm || DEFAULT_AVATAR_MODEL;
		const selectedBgOption = snapshot.backgrounds.find(
			(bg) => bg.url === snapshot.selectedBg,
		);
		const bgFilename =
			selectedBgOption?.path.split(/[/\\]/).pop() ?? undefined;

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

		const completedFlat: Record<string, unknown> = {
			...base,
			provider: auth ? "nextain" : base.provider,
			model: auth ? base.model || "gemini-2.5-flash" : base.model,
			agentName: snapshot.agentName.trim() || "Naia",
			userName: snapshot.userName.trim() || undefined,
			speechStyle: snapshot.speechStyle,
			honorific: snapshot.honorific.trim() || undefined,
			vrmModel: vrmPath,
			backgroundVideo: bgFilename,
			persona,
			...(snapshot.apiKey.trim() && !snapshot.naiaLoginDone && !auth
				? { apiKey: snapshot.apiKey.trim() }
				: {}),
			...(auth
				? { naiaKey: auth.naiaKey, naiaUserId: auth.naiaUserId }
				: {}),
			workspaceRoot: getAdkPath() || base.workspaceRoot || undefined,
			onboardingComplete: true,
			...(recommendedVramTier ? { localGpuTier: recommendedVramTier.id } : {}),
			...(snapshot.memoryEmbeddingProvider !== "none"
				? { memoryEmbeddingProvider: snapshot.memoryEmbeddingProvider }
				: {}),
			...(snapshot.memoryLlmProvider !== "none"
				? { memoryLlmProvider: snapshot.memoryLlmProvider }
				: {}),
		};
		await saveConfigSecure(completedFlat as unknown as AppConfig);

		setAvatarModelPath(vrmPath);
		return completedFlat;
	}

	async function handleComplete() {
		const completedFlat = await saveCompletedConfig(naiaAuthPayload ?? undefined);
		// UC12 graft (isNewCore): 새 core OnboardingController.completeWith(§D 신규계약)가
		// categorize(secret/ui/agent) + persist(secret=키체인 전담, stale-credential fix) + markComplete.
		// 미설정(기본)=기존 writeNaiaConfig/writeAgentKey 경로 보존(비파괴). UC1 chat-service graft 와 동일.
		if (newCore) {
			void core()?.completeWith(completedFlat);
		} else {
			// G-01: sync to naia-settings/config.json so standalone agent picks up the onboarding result.
			const saved = loadConfig();
			if (saved) void writeNaiaConfig({ ...(saved as unknown as Record<string, unknown>), ...buildNaiaConfigEnv(saved) });
			// Write naiaKey to OS keychain so standalone naia-agent can read it.
			if (typeof completedFlat.naiaKey === "string") void writeAgentKey(String(completedFlat.provider || "nextain"), "naiaKey", completedFlat.naiaKey);
			if (typeof completedFlat.apiKey === "string") void writeAgentKey(String(completedFlat.provider || "anthropic"), "apiKey", completedFlat.apiKey);
			// (gateway sync 제거됨 2026-06-12 — gateway.json 미사용 죽은 경로. config 영속=naia-settings,
			//  naiaKey/apiKey=키체인(위 writeAgentKey). memory 설정 연결=다른 세션 재설계.)
		}
		addMessage({
			role: "assistant",
			content: stepChat(
				"complete",
				agentName.trim() || "나이아",
				userName.trim(),
			),
		});
		setTimeout(onComplete, 1200);
	}

	const isFirst = stepIndex === 0;
	const isCompleteStep = step === "complete";
	const progressSteps = STEPS.slice(0, -1); // exclude "complete" from dot indicators

	return (
		<div className="onboarding-panel">
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
										openUrl("https://github.com/nextain/naia-os"),
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
										openUrl("https://naia.nextain.io/donation"),
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
								agentName.trim() || "나이아",
							)}
						</h2>
						<input
							className="onboarding-step__input"
							value={userName}
							onChange={(e) => setUserName(e.target.value)}
							placeholder="Luke"
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
								agentName.trim() || "나이아",
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
								.replace("{agent}", agentName.trim() || "나이아")}
						</h2>
						<div className="onboarding-step__avatar-list">
							{naiaVrms.length === 0 ? (
								<p className="onboarding-step__hint onboarding-step__hint--warn">
									naia-settings/vrm-files/ 폴더에 VRM 파일이 없습니다.
								</p>
							) : (
								naiaVrms.map((path) => {
									const filename = path.split(/[/\\]/).pop() ?? path;
									const label = filename.replace(/\.vrm$/i, "");
									const thumb = `/avatars/${filename.replace(/\.vrm$/i, ".webp")}`;
									return (
										<button
											key={path}
											type="button"
											className={`onboarding-step__avatar-item${selectedVrm === path ? " onboarding-step__avatar-item--selected" : ""}`}
											onClick={() => handleVrmSelect(path)}
										>
											<img
												src={thumb}
												className="onboarding-step__avatar-thumb"
												alt={label}
												onError={(e) => {
													(e.currentTarget as HTMLImageElement).style.display =
														"none";
												}}
											/>
											<span>{label}</span>
										</button>
									);
								})
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
										<div className="onboarding-step__bg-video-thumb">▶</div>
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
						) : apiKeyMode ? (
							<>
								<p className="onboarding-step__hint">
									{t("onboard.connect.byoHint")}
								</p>
								<input
									className="onboarding-step__input"
									value={apiKey}
									onChange={(e) => setApiKey(e.target.value)}
									placeholder={t("onboard.connect.apiKeyPlaceholder")}
									autoFocus
								/>
								<button
									type="button"
									className="onboarding-step__link"
									onClick={() => setApiKeyMode(false)}
								>
									{t("onboard.connect.backToNaia")}
								</button>
							</>
						) : (
							<>
								<div
									style={{
										display: "grid",
										gridTemplateColumns: "1fr 1fr",
										gap: 12,
										marginTop: 16,
									}}
								>
									<button
										type="button"
										className="onboarding-step__naia-btn"
										onClick={handleNaiaLogin}
										disabled={naiaLoginWaiting}
									>
										{naiaLoginWaiting
											? t("onboard.lab.waiting")
											: t("onboard.connect.naiaPath")}
									</button>
									<button
										type="button"
										className="onboarding-step__link"
										onClick={() => setApiKeyMode(true)}
									>
										{t("onboard.connect.byoPath")}
									</button>
								</div>
								<button
									className="onboarding-step__link onboarding-step__link--muted"
									type="button"
									onClick={goNext}
								>
									{t("onboard.connect.setupLater")}
								</button>
							</>
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
						</h2>
						<p className="onboarding-step__hint">
							{t("onboard.complete.ready").replace(
								"{agent}",
								agentName.trim() || "나이아",
							)}
						</p>
					</>
				)}
			</div>

			{/* Navigation */}
			<div className="onboarding-step__actions">
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
					>
						{isCompleteStep ? t("onboard.complete.start") : t("onboard.next")}
					</button>
				)}
				{step === "provider" && (naiaLoginDone || apiKeyMode) && (
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
