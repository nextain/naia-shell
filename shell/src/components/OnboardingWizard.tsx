import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { buildNaiaConfigEnv, getAdkPath, listNaiaAssets, toAssetUrl, toLocalBlobUrl, writeAgentKey, writeNaiaConfig } from "../lib/adk-store";
import { syncToGateway } from "../lib/gateway-sync";
import { DEFAULT_AVATAR_MODEL } from "../lib/avatar-presets";
import { sendAuthUpdate } from "../lib/chat-service";
import { loadConfig, saveConfig } from "../lib/config";
import { getLocale, t } from "../lib/i18n";
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
	return (
		import.meta.env.VITE_NAIA_WEB_BASE_URL?.trim() || "https://naia.nextain.io"
	);
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

	// Load VRM list from naia-settings
	useEffect(() => {
		listNaiaAssets("vrm-files").then((paths) => {
			const vrms = paths.filter((p) => p.toLowerCase().endsWith(".vrm"));
			setNaiaVrms(vrms);
			if (vrms.length > 0) setSelectedVrm((prev) => prev || vrms[0]);
		});
	}, []);

	// Reset background on mount
	useEffect(() => {
		if (!didMount.current) {
			didMount.current = true;
			setBackgroundVideoUrl("");
			setBackgroundMediaType("");
		}
	}, [setBackgroundMediaType, setBackgroundVideoUrl]);

	// Load backgrounds from naia-settings
	useEffect(() => {
		listNaiaAssets("background")
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
				source: "desktop",
			});
			if (state) params.set("state", state);
			await openUrl(
				`${getNaiaWebBaseUrl()}/${lang}/login?${params.toString()}`,
			);
		} catch {
			setNaiaLoginWaiting(false);
		}
	}

	function saveCompletedConfig(
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
		const base = loadConfig() ?? {
			provider: "nextain",
			model: "gemini-2.5-flash",
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

		saveConfig({
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
			...(snapshot.memoryEmbeddingProvider !== "none"
				? { memoryEmbeddingProvider: snapshot.memoryEmbeddingProvider }
				: {}),
			...(snapshot.memoryLlmProvider !== "none"
				? { memoryLlmProvider: snapshot.memoryLlmProvider }
				: {}),
		});

		setAvatarModelPath(vrmPath);
	}

	function handleComplete() {
		saveCompletedConfig(naiaAuthPayload ?? undefined);
		// G-01: sync to naia-settings/config.json so standalone agent picks up the onboarding result.
		const saved = loadConfig();
		if (saved) void writeNaiaConfig({ ...(saved as unknown as Record<string, unknown>), ...buildNaiaConfigEnv(saved) });
		// Write naiaKey to OS keychain so standalone naia-agent can read it.
		if (saved?.naiaKey) void writeAgentKey(saved.provider || "nextain", "naiaKey", saved.naiaKey);
		if (saved?.apiKey) void writeAgentKey(saved.provider || "anthropic", "apiKey", saved.apiKey);
		// Sync memory AI settings to memory-config.json via gateway config.
		if (saved) {
			void syncToGateway(
				saved.provider ?? "nextain",
				saved.model ?? "",
				saved.apiKey || undefined,
				saved.persona,
				saved.agentName,
				saved.userName,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				saved.naiaKey || undefined,
				undefined,
				{
					memoryEmbeddingProvider: saved.memoryEmbeddingProvider,
					memoryLlmProvider: saved.memoryLlmProvider,
				},
			);
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
						<h2 className="onboarding-step__title">{t("onboard.lab.title")}</h2>
						{naiaLoginDone ? (
							<>
								<div className="onboarding-step__provider-done">
									<span className="onboarding-step__provider-check">✓</span>
									<p>{t("onboard.lab.connected")}</p>
								</div>
								<button
									type="button"
									className="onboarding-step__link onboarding-step__link--muted"
									onClick={goNext}
									style={{ marginTop: 16 }}
								>
									다음 →
								</button>
							</>
					) : apiKeyMode ? (
							<>
								<p className="onboarding-step__hint">
									API 키를 입력하세요. 나중에 설정에서 변경할 수 있어요.
								</p>
								<input
									className="onboarding-step__input"
									value={apiKey}
									onChange={(e) => setApiKey(e.target.value)}
									placeholder="sk-... / gw-..."
									autoFocus
								/>
								<button
									type="button"
									className="onboarding-step__link"
									onClick={() => setApiKeyMode(false)}
								>
									← Naia 로그인으로 돌아가기
								</button>
							</>
						) : (
							<>
								<button
									type="button"
									className="onboarding-step__naia-btn"
									onClick={handleNaiaLogin}
									disabled={naiaLoginWaiting}
								>
									{naiaLoginWaiting
										? t("onboard.lab.waiting")
										: t("onboard.lab.login")}
								</button>
								<p className="onboarding-step__hint" style={{ whiteSpace: "pre-line" }}>{t("onboard.lab.naiaHint")}</p>
								<button
									className="onboarding-step__link onboarding-step__link--muted"
									type="button"
									onClick={goNext}
								>
									나중에 설정 →
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
