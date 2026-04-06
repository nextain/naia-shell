import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { AVATAR_PRESETS, DEFAULT_AVATAR_MODEL } from "../lib/avatar-presets";
import { directToolCall } from "../lib/chat-service";
import {
	DEFAULT_GATEWAY_URL,
	DEFAULT_OLLAMA_HOST,
	DEFAULT_VLLM_HOST,
	loadConfig,
	resolveGatewayUrl,
	saveConfig,
} from "../lib/config";
import { validateApiKey } from "../lib/db";
import { persistDiscordDefaults } from "../lib/discord-auth";
import { getLocale, t } from "../lib/i18n";
import { fetchLabConfig, pushConfigToLab } from "../lib/lab-sync";
import {
	fetchOllamaModels,
	fetchVllmModels,
	getDefaultLlmModel,
	listLlmProviders,
} from "../lib/llm";
import { Logger } from "../lib/logger";
import { syncToGateway } from "../lib/gateway-sync";
import { FORMALITY_LOCALES, buildSystemPrompt } from "../lib/persona";
import { saveSecretKey } from "../lib/secure-store";
import type { ProviderId } from "../lib/types";
import { useAvatarStore } from "../stores/avatar";
import { usePanelStore } from "../stores/panel";
import { VrmPreview } from "./VrmPreview";

type Step =
	| "provider"
	| "apiKey"
	| "ollamaConfig"
	| "agentName"
	| "userName"
	| "character"
	| "personality"
	| "speechStyle"
	| "complete";

const STEPS: Step[] = [
	"provider",
	"apiKey",
	"ollamaConfig",
	"agentName",
	"userName",
	"character",
	"personality",
	"speechStyle",
	"complete",
];

function looksLikeApiKey(value: string): boolean {
	const v = value.trim();
	if (!v) return false;
	return (
		/^AIza[0-9A-Za-z_\-]{20,}$/.test(v) ||
		/^sk-[0-9A-Za-z_\-]{16,}$/.test(v) ||
		/^gw-[0-9A-Za-z_\-]{10,}$/.test(v) ||
		/^xai-[0-9A-Za-z_\-]{16,}$/.test(v) ||
		/^claude_[0-9A-Za-z_\-]{10,}$/i.test(v)
	);
}

function sanitizeName(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return looksLikeApiKey(trimmed) ? "" : trimmed;
}

const PERSONALITY_PRESETS: {
	id: string;
	labelKey: string;
	descKey: string;
	persona: string;
}[] = [
	{
		id: "friendly",
		labelKey: "personality.friendly.label",
		descKey: "personality.friendly.desc",
		persona: `You are {name}, a warm and friendly AI companion.
Personality:
- Speaks casually and warmly
- Warm, caring, and supportive
- Uses friendly expressions naturally
- Gives concise, helpful answers`,
	},
	{
		id: "polite",
		labelKey: "personality.polite.label",
		descKey: "personality.polite.desc",
		persona: `You are {name}, a reliable and professional AI assistant.
Personality:
- Speaks politely and professionally
- Professional, reliable, and thorough
- Clear and organized communication
- Gives structured, detailed answers when needed`,
	},
	{
		id: "playful",
		labelKey: "personality.playful.label",
		descKey: "personality.playful.desc",
		persona: `You are {name}, a playful and humorous AI companion.
Personality:
- Speaks casually with humor
- Playful, witty, and cheerful
- Makes conversations fun and lighthearted
- Sneaks in jokes and clever remarks`,
	},
	{
		id: "calm",
		labelKey: "personality.calm.label",
		descKey: "personality.calm.desc",
		persona: `You are {name}, a calm and intellectual AI companion.
Personality:
- Speaks thoughtfully and analytically
- Calm, analytical, and knowledgeable
- Explains things clearly and logically
- Takes time to consider before answering`,
	},
];

// Providers for onboarding (exclude nextain — handled as Lab login)
const ONBOARDING_PROVIDERS = listLlmProviders().filter(
	(p) => p.id !== "nextain",
);

function getNaiaWebBaseUrl() {
	return (
		import.meta.env.VITE_NAIA_WEB_BASE_URL?.trim() || "https://naia.nextain.io"
	);
}

export function OnboardingWizard({
	onComplete,
}: {
	onComplete: () => void;
}) {
	const setAvatarModelPath = useAvatarStore((s) => s.setModelPath);
	const pushModal = usePanelStore((s) => s.pushModal);
	const popModal = usePanelStore((s) => s.popModal);
	const [step, setStep] = useState<Step>("provider");
	const [agentName, setAgentName] = useState("");
	const [userName, setUserName] = useState("");
	const [selectedVrm, setSelectedVrm] = useState(AVATAR_PRESETS[0].path);
	const [selectedPersonality, setSelectedPersonality] = useState("friendly");
	const [provider, setProvider] = useState<ProviderId>("gemini");
	const [apiKey, setApiKey] = useState("");
	const [validating, setValidating] = useState(false);
	const [validationResult, setValidationResult] = useState<
		"idle" | "success" | "error"
	>("idle");
	const [naiaKey, setNaiaKey] = useState("");
	const [naiaUserId, setNaiaUserId] = useState("");
	const [labWaiting, setLabWaiting] = useState(false);
	const [labBrowserVisible, setLabBrowserVisible] = useState(false);
	const labTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [labTimeout, setLabTimeout] = useState(false);
	// Tracks whether we temporarily revealed Chrome for login (needs pushModal on cleanup)
	const labBrowserVisibleRef = useRef(false);
	const [selectedSpeechStyle, setSelectedSpeechStyle] = useState("casual");
	const [honorificInput, setHonorificInput] = useState("");
	const [discordConnectLoading, setDiscordConnectLoading] = useState(false);
	const [discordConnected, setDiscordConnected] = useState(false);
	const [ollamaHost, setOllamaHost] = useState(DEFAULT_OLLAMA_HOST);
	const [ollamaModels, setOllamaModels] = useState<
		{ id: string; label: string }[]
	>([]);
	const [ollamaConnected, setOllamaConnected] = useState(false);
	const [selectedOllamaModel, setSelectedOllamaModel] = useState("");
	const [vllmHost, setVllmHost] = useState(DEFAULT_VLLM_HOST);
	const [vllmModels, setVllmModels] = useState<{ id: string; label: string }[]>(
		[],
	);
	const [vllmConnected, setVllmConnected] = useState(false);
	const [selectedVllmModel, setSelectedVllmModel] = useState("");

	// Hide Chrome X11 embed while onboarding modal is visible
	useEffect(() => {
		pushModal();
		return () => {
			popModal();
			if (labTimerRef.current) clearTimeout(labTimerRef.current);
		};
	}, [pushModal, popModal]);

	// Listen for deep-link Lab auth callback
	useEffect(() => {
		const unlisten = listen<{ naiaKey: string; naiaUserId?: string }>(
			"naia_auth_complete",
			async (event) => {
				Logger.info("OnboardingWizard", "Lab auth received", {});
				const key = event.payload.naiaKey;
				const userId = event.payload.naiaUserId ?? "";
				// Restore modal (re-hide Chrome) if we temporarily revealed it for login
				if (labBrowserVisibleRef.current) {
					labBrowserVisibleRef.current = false;
					setLabBrowserVisible(false);
					pushModal();
				}
				setNaiaKey(key);
				setNaiaUserId(userId);
				setProvider("nextain");
				setLabWaiting(false);
				setLabTimeout(false);

				// Try to pull settings from Lab
				const onlineConfig = userId ? await fetchLabConfig(key, userId) : null;

				// Restore from online or local
				const existing = loadConfig();
				const source = onlineConfig ?? existing;
				if (source?.agentName) {
					setAgentName(sanitizeName(source.agentName as string));
				}
				if (source?.userName) setUserName(source.userName as string);
				if (onlineConfig?.honorific) setHonorificInput(onlineConfig.honorific);
				if (onlineConfig?.speechStyle)
					setSelectedSpeechStyle(onlineConfig.speechStyle);

				const vrmSource = existing?.vrmModel;
				if (vrmSource) {
					const match = AVATAR_PRESETS.find((v) => v.path === vrmSource);
					if (match) setSelectedVrm(match.path);
				}

				const personaSource = onlineConfig?.persona ?? existing?.persona;
				if (personaSource) {
					const match = PERSONALITY_PRESETS.find((p) =>
						(personaSource as string).includes(p.id),
					);
					if (match) setSelectedPersonality(match.id);
				}

				// Returning user with existing settings → restore & complete
				// First-time user → go through name/character/personality
				if (source?.agentName && source?.userName) {
					// Immediately persist config to local storage
					// Prefer online values, fall back to local existing values
					const existing = loadConfig();
					const restored = {
						...existing,
						provider: "nextain" as ProviderId,
						model: getDefaultLlmModel("nextain"),
						apiKey: "",
						userName: (onlineConfig?.userName ??
							existing?.userName ??
							source.userName) as string,
						agentName: (onlineConfig?.agentName ??
							existing?.agentName ??
							source.agentName) as string,
						persona: (onlineConfig?.persona ?? existing?.persona) as
							| string
							| undefined,
						honorific: (onlineConfig?.honorific ?? existing?.honorific) as
							| string
							| undefined,
						speechStyle: (onlineConfig?.speechStyle ?? existing?.speechStyle) as
							| string
							| undefined,
						enableTools: true,
						onboardingComplete: true,
						naiaKey: key,
						naiaUserId: userId,
					};
					saveConfig(restored);
					await saveSecretKey("naiaKey", key);

					// Sync to Naia Gateway
					const fullPrompt = buildSystemPrompt(restored.persona, {
						agentName: restored.agentName,
						userName: restored.userName,
						honorific: restored.honorific,
						speechStyle: restored.speechStyle,
						locale: restored.locale || getLocale(),
						discordDefaultUserId: restored.discordDefaultUserId,
						discordDmChannelId: restored.discordDmChannelId,
					});
					syncToGateway(
						restored.provider,
						restored.model,
						restored.apiKey,
						restored.persona,
						restored.agentName,
						restored.userName,
						fullPrompt,
						restored.locale || getLocale(),
						restored.discordDmChannelId,
						restored.discordDefaultUserId,
						undefined,
						undefined,
						undefined,
						undefined,
						key,
						restored.ollamaHost,
					);

					// Push to Lab if not yet saved online
					if (!onlineConfig) {
						pushConfigToLab(key, userId, restored);
					}

					// Restore avatar and skip directly to chat
					if (restored.vrmModel) {
						setAvatarModelPath(restored.vrmModel);
					}
					onComplete();
				} else {
					setStep("agentName");
				}
			},
		);
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Listen for Discord auth deep-link callback
	useEffect(() => {
		const unlisten = listen<{
			discordUserId?: string | null;
			discordChannelId?: string | null;
			discordTarget?: string | null;
		}>("discord_auth_complete", (event) => {
			const next = persistDiscordDefaults(event.payload);
			if (!next) return;
			setDiscordConnected(true);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	useEffect(() => {
		if (step !== "complete") return;
		let cancelled = false;
		const refreshDiscordStatus = async () => {
			try {
				const cfg = loadConfig();
				const gatewayUrl = resolveGatewayUrl(cfg) || DEFAULT_GATEWAY_URL;
				const result = await directToolCall({
					toolName: "skill_channels",
					args: { action: "status" },
					requestId: `onboard-discord-status-${Date.now()}`,
					gatewayUrl,
					gatewayToken: cfg?.gatewayToken,
				});
				if (!result.success || !result.output || cancelled) return;
				const channels = JSON.parse(result.output) as Array<{
					id?: string;
					accounts?: Array<{ connected?: boolean }>;
				}>;
				const discord = channels.find((ch) => ch.id === "discord");
				const connected =
					discord?.accounts?.some((acc) => acc.connected === true) ?? false;
				setDiscordConnected(connected);
			} catch {
				// Keep optional flow non-blocking
			}
		};
		void refreshDiscordStatus();
		return () => {
			cancelled = true;
		};
	}, [step]);

	const stepIndex = STEPS.indexOf(step);
	const safeAgentName = sanitizeName(agentName);
	const displayName = safeAgentName || "Naia";

	// Enter key advances to next step
	function handleKeyDown(e: React.KeyboardEvent) {
		if (e.key === "Enter" && canProceed()) {
			e.preventDefault();
			if (step === "complete") {
				handleComplete();
			} else {
				goNext();
			}
		}
	}

	function goNext() {
		const skipApiKey =
			naiaKey ||
			provider === "claude-code-cli" ||
			provider === "ollama" ||
			provider === "vllm";
		const skipOllamaConfig = provider !== "ollama" && provider !== "vllm";
		const skipSpeechStyle = !FORMALITY_LOCALES.has(getLocale());
		if (stepIndex < STEPS.length - 1) {
			let next = stepIndex + 1;
			if (STEPS[next] === "apiKey" && skipApiKey) next++;
			if (STEPS[next] === "ollamaConfig" && skipOllamaConfig) next++;
			if (STEPS[next] === "speechStyle" && skipSpeechStyle) next++;
			setStep(STEPS[next]);
		}
	}

	function goBack() {
		const skipApiKey =
			naiaKey ||
			provider === "claude-code-cli" ||
			provider === "ollama" ||
			provider === "vllm";
		const skipOllamaConfig = provider !== "ollama" && provider !== "vllm";
		const skipSpeechStyle = !FORMALITY_LOCALES.has(getLocale());
		if (stepIndex > 0) {
			let prev = stepIndex - 1;
			if (STEPS[prev] === "speechStyle" && skipSpeechStyle) prev--;
			if (STEPS[prev] === "ollamaConfig" && skipOllamaConfig) prev--;
			if (STEPS[prev] === "apiKey" && skipApiKey) prev--;
			setStep(STEPS[prev]);
		}
	}

	async function handleLabLogin() {
		setLabWaiting(true);
		setLabTimeout(false);
		// Register timeout first — before any await — so it always fires
		// even if browser_embed_navigate or browser_check stalls indefinitely.
		if (labTimerRef.current) clearTimeout(labTimerRef.current);
		labTimerRef.current = setTimeout(() => {
			// Restore modal if Chrome was revealed for login
			if (labBrowserVisibleRef.current) {
				labBrowserVisibleRef.current = false;
				setLabBrowserVisible(false);
				pushModal();
			}
			setLabWaiting(false);
			setLabTimeout(true);
			labTimerRef.current = null;
		}, 60_000);
		try {
			const chromeAvailable = await invoke<boolean>("browser_check").catch(() => false);
			if (chromeAvailable) {
				// source=embedded: CDP monitor detects /desktop/auth-complete URL
				// (naia:// deep links don't work inside Flatpak-sandboxed Chrome)
				const loginUrl = `${getNaiaWebBaseUrl()}/${getLocale()}/login?redirect=desktop&source=embedded`;
				// Switch to browser panel u2014 this mounts BrowserCenterPanel which calls browser_embed_init
				const { usePanelStore } = await import("../stores/panel");
				usePanelStore.getState().setActivePanel("browser");
				// Poll until Chrome is ready (browser_embed_port > 0), up to ~10 s
				let port = 0;
				for (let i = 0; i < 20; i++) {
					port = await invoke<number>("browser_embed_port").catch(() => 0);
					if (port !== 0) break;
					await new Promise<void>((r) => setTimeout(r, 500));
				}
				if (port !== 0) {
					if (!labBrowserVisibleRef.current) {
						labBrowserVisibleRef.current = true;
						setLabBrowserVisible(true);
						popModal();
					}
					await invoke("browser_embed_navigate", { url: loginUrl }).catch(() => {});
				}
			} else {
				// Chrome not installed: system browser fallback (deep link; works on Windows/macOS)
				const loginUrl = `${getNaiaWebBaseUrl()}/${getLocale()}/login?redirect=desktop`;
				await openUrl(loginUrl);
			}
		} catch {
			const loginUrl = `${getNaiaWebBaseUrl()}/${getLocale()}/login?redirect=desktop`;
			try {
				await openUrl(loginUrl);
			} catch {
				/* ignore */
			}
		}
	}

	async function handleValidate() {
		if (provider === "claude-code-cli" || provider === "ollama") {
			setValidationResult("success");
			return;
		}
		if (!apiKey.trim()) return;
		setValidating(true);
		setValidationResult("idle");
		try {
			const ok = await validateApiKey(provider, apiKey.trim());
			setValidationResult(ok ? "success" : "error");
		} catch (err) {
			Logger.warn("OnboardingWizard", "Validation failed", {
				error: String(err),
			});
			setValidationResult("error");
		} finally {
			setValidating(false);
		}
	}

	function handleComplete() {
		const preset = PERSONALITY_PRESETS.find(
			(p) => p.id === selectedPersonality,
		);
		const persona = preset
			? preset.persona.replace(/\{name\}/g, displayName)
			: undefined;

		const defaultVrm = DEFAULT_AVATAR_MODEL;
		const effectiveProvider: ProviderId = naiaKey ? "nextain" : provider;
		// Merge with existing config to preserve fields set by discord_auth_complete etc.
		const existing = loadConfig();
		const config = {
			...existing,
			provider: effectiveProvider,
			model:
				effectiveProvider === "ollama"
					? selectedOllamaModel
					: effectiveProvider === "vllm"
						? selectedVllmModel
						: getDefaultLlmModel(effectiveProvider),
			apiKey:
				naiaKey ||
				provider === "claude-code-cli" ||
				provider === "ollama" ||
				provider === "vllm"
					? ""
					: apiKey.trim(),
			userName: userName.trim() || undefined,
			agentName: safeAgentName || undefined,
			vrmModel: selectedVrm !== defaultVrm ? selectedVrm : undefined,
			persona,
			honorific: honorificInput.trim() || undefined,
			speechStyle: selectedSpeechStyle,
			enableTools: true,
			onboardingComplete: true,
			naiaKey: naiaKey || undefined,
			naiaUserId: naiaUserId || undefined,
			ollamaHost: effectiveProvider === "ollama" ? ollamaHost : undefined,
			vllmHost: effectiveProvider === "vllm" ? vllmHost : undefined,
		};
		saveConfig(config);
		if (naiaKey) void saveSecretKey("naiaKey", naiaKey);

		// Sync provider/model + full system prompt to Naia Gateway config
		const fullPrompt = buildSystemPrompt(config.persona, {
			agentName: config.agentName,
			userName: config.userName,
			honorific: config.honorific,
			speechStyle: config.speechStyle,
			locale: config.locale || getLocale(),
			discordDefaultUserId: config.discordDefaultUserId,
			discordDmChannelId: config.discordDmChannelId,
		});
		syncToGateway(
			config.provider,
			config.model,
			config.apiKey,
			config.persona,
			config.agentName,
			config.userName,
			fullPrompt,
			config.locale || getLocale(),
			config.discordDmChannelId,
			config.discordDefaultUserId,
			undefined,
			undefined,
			undefined,
			undefined,
			naiaKey || undefined,
			config.ollamaHost || undefined,
		);

		// Sync to Lab if connected
		if (naiaKey && naiaUserId) {
			pushConfigToLab(naiaKey, naiaUserId, config);
		}

		setAvatarModelPath(selectedVrm);
		onComplete();
	}

	function canProceed(): boolean {
		switch (step) {
			case "provider":
				return true;
			case "apiKey":
				return (
					!!apiKey.trim() ||
					!!naiaKey ||
					provider === "claude-code-cli" ||
					provider === "ollama" ||
					provider === "vllm"
				);
			case "ollamaConfig":
				if (provider === "vllm") return vllmConnected && !!selectedVllmModel;
				return ollamaConnected && !!selectedOllamaModel;
			case "agentName":
				return !!sanitizeName(agentName);
			case "userName":
				return !!userName.trim();
			default:
				return true;
		}
	}

	async function handleOptionalDiscordConnect() {
		setDiscordConnectLoading(true);
		try {
			const lang = getLocale();
			const connectUrl = `${getNaiaWebBaseUrl()}/${lang}/settings/integrations?channel=discord&source=naia-shell`;
			await openUrl(connectUrl);
		} catch (err) {
			Logger.warn("OnboardingWizard", "Optional discord connect failed", {
				error: String(err),
			});
		} finally {
			setDiscordConnectLoading(false);
		}
	}

	return (
		<div className="onboarding-overlay" onKeyDown={handleKeyDown}>
			<div className="onboarding-card">
				{/* Step indicators */}
				<div className="onboarding-steps">
					{STEPS.map((s, i) => (
						<div
							key={s}
							className={`onboarding-step-dot${i <= stepIndex ? " active" : ""}`}
						/>
					))}
				</div>

				{/* Step: Provider (FIRST) */}
				{step === "provider" && (
					<div className="onboarding-content">
						<h2>{t("onboard.provider.title")}</h2>

						{/* Browser hint shown while Chrome is open for login */}
						{labBrowserVisible && (
							<div className="onboarding-browser-hint">
								<span>→</span>
								<span>{t("onboard.lab.browser.hint")}</span>
							</div>
						)}

						{/* Lab login — prominent card at top */}
						<button
							type="button"
							className={`onboarding-provider-card lab-card${naiaKey ? " selected" : ""}`}
							disabled={labWaiting}
							onClick={handleLabLogin}
						>
							<span className="provider-card-label">
								{naiaKey
									? t("onboard.apiKey.success")
									: labWaiting
										? t("onboard.lab.waiting")
										: "Naia"}
							</span>
							<span className="provider-card-desc">
								{t("onboard.lab.description")}
							</span>
						</button>

						{labTimeout && (
							<div className="onboarding-validation-error">
								{t("onboard.lab.timeout")}
							</div>
						)}

						<div className="onboarding-divider">
							<span>{t("onboard.lab.or")}</span>
						</div>

						<div className="onboarding-provider-cards">
							{ONBOARDING_PROVIDERS.map((p) => (
								<button
									key={p.id}
									type="button"
									className={`onboarding-provider-card${!naiaKey && provider === p.id ? " selected" : ""}${p.disabled ? " disabled" : ""}`}
									disabled={p.disabled}
									onClick={() => {
										if (p.disabled) return;
										setProvider(p.id as ProviderId);
										setNaiaKey("");
										setNaiaUserId("");
										setLabTimeout(false);
									}}
								>
									<span className="provider-card-label">{p.name}</span>
									<span className="provider-card-desc">
										{t((p.descKey ?? "provider.apiKeyRequired") as any)}
									</span>
								</button>
							))}
						</div>
					</div>
				)}

				{/* Step: API Key */}
				{step === "apiKey" && (
					<div className="onboarding-content">
						<h2>{t("onboard.apiKey.title")}</h2>
						<input
							type="password"
							className="onboarding-input"
							value={apiKey}
							onChange={(e) => {
								setApiKey(e.target.value);
								setValidationResult("idle");
							}}
							placeholder="API key..."
						/>
						<button
							type="button"
							className="onboarding-validate-btn"
							onClick={handleValidate}
							disabled={!apiKey.trim() || validating}
						>
							{validating
								? t("onboard.apiKey.validating")
								: t("onboard.apiKey.validate")}
						</button>
						{validationResult === "success" && (
							<div className="onboarding-validation-success">
								{t("onboard.apiKey.success")}
							</div>
						)}
						{validationResult === "error" && (
							<div className="onboarding-validation-error">
								{t("onboard.apiKey.error")}
							</div>
						)}
					</div>
				)}

				{/* Step: Local Server Config (Ollama / vLLM) */}
				{step === "ollamaConfig" && provider === "ollama" && (
					<div className="onboarding-content">
						<h2>Ollama 설정</h2>
						<div className="settings-field">
							<label>Host URL</label>
							<input
								type="text"
								className="onboarding-input"
								value={ollamaHost}
								onChange={(e) => setOllamaHost(e.target.value)}
								placeholder={DEFAULT_OLLAMA_HOST}
							/>
						</div>
						<button
							type="button"
							className="onboarding-validate-btn"
							onClick={async () => {
								const result = await fetchOllamaModels(ollamaHost);
								setOllamaConnected(result.connected);
								setOllamaModels(result.models);
								if (result.models.length > 0 && !selectedOllamaModel) {
									setSelectedOllamaModel(result.models[0].id);
								}
							}}
						>
							연결 확인
						</button>
						{ollamaConnected && ollamaModels.length > 0 && (
							<select
								className="onboarding-input"
								value={selectedOllamaModel}
								onChange={(e) => setSelectedOllamaModel(e.target.value)}
							>
								{ollamaModels.map((m) => (
									<option key={m.id} value={m.id}>
										{m.label}
									</option>
								))}
							</select>
						)}
						{ollamaConnected && ollamaModels.length === 0 && (
							<div className="onboarding-validation-error">
								모델 없음 — `ollama pull` 명령으로 모델을 설치하세요
							</div>
						)}
						{!ollamaConnected && ollamaModels.length === 0 && (
							<div className="settings-hint">
								Ollama 서버에 연결하려면 위 버튼을 클릭하세요
							</div>
						)}
					</div>
				)}
				{step === "ollamaConfig" && provider === "vllm" && (
					<div className="onboarding-content">
						<h2>vLLM 설정</h2>
						<div className="settings-field">
							<label>Server URL</label>
							<input
								type="text"
								className="onboarding-input"
								value={vllmHost}
								onChange={(e) => setVllmHost(e.target.value)}
								placeholder={DEFAULT_VLLM_HOST}
							/>
						</div>
						<button
							type="button"
							className="onboarding-validate-btn"
							onClick={async () => {
								const result = await fetchVllmModels(vllmHost);
								setVllmConnected(result.connected);
								setVllmModels(result.models);
								if (result.models.length > 0 && !selectedVllmModel) {
									setSelectedVllmModel(result.models[0].id);
								}
							}}
						>
							연결 확인
						</button>
						{vllmConnected && vllmModels.length > 0 && (
							<select
								className="onboarding-input"
								value={selectedVllmModel}
								onChange={(e) => setSelectedVllmModel(e.target.value)}
							>
								{vllmModels.map((m) => (
									<option key={m.id} value={m.id}>
										{m.label}
									</option>
								))}
							</select>
						)}
						{vllmConnected && vllmModels.length === 0 && (
							<div className="onboarding-validation-error">
								모델 없음 — vLLM 서버에 모델이 로드되어 있는지 확인하세요
							</div>
						)}
						{!vllmConnected && vllmModels.length === 0 && (
							<div className="settings-hint">
								vLLM 서버에 연결하려면 위 버튼을 클릭하세요
							</div>
						)}
					</div>
				)}

				{/* Step: Agent Name */}
				{step === "agentName" && (
					<div className="onboarding-content">
						<h2>{t("onboard.agentName.title")}</h2>
						<input
							type="text"
							className="onboarding-input"
							value={agentName}
							onChange={(e) => setAgentName(e.target.value)}
							placeholder={t("onboard.name.placeholder")}
						/>
					</div>
				)}

				{/* Step: User Name */}
				{step === "userName" && (
					<div className="onboarding-content">
						<h2>
							{t("onboard.userName.title").replace("{agent}", displayName)}
						</h2>
						<input
							type="text"
							className="onboarding-input"
							value={userName}
							onChange={(e) => setUserName(e.target.value)}
							placeholder={t("onboard.name.placeholder")}
						/>
					</div>
				)}

				{/* Step: Character (VRM) with preview */}
				{step === "character" && (
					<div className="onboarding-content">
						<h2>
							{t("onboard.character.title")
								.replace("{user}", userName.trim() || "")
								.replace("{agent}", displayName)}
						</h2>
						<VrmPreview modelPath={selectedVrm} />
						<div className="onboarding-vrm-cards">
							{AVATAR_PRESETS.map((v) => (
								<button
									key={v.path}
									type="button"
									className={`onboarding-vrm-card${selectedVrm === v.path ? " selected" : ""}`}
									onClick={() => setSelectedVrm(v.path)}
									style={
										v.previewImage
											? {
													padding: 0,
													overflow: "hidden",
													display: "flex",
													flexDirection: "column",
												}
											: {}
									}
								>
									{v.previewImage && (
										<img
											src={v.previewImage}
											alt={v.label}
											style={{
												width: "100%",
												height: "60px",
												objectFit: "cover",
												flexShrink: 0,
											}}
										/>
									)}
									<span
										className="onboarding-vrm-label"
										style={
											v.previewImage
												? {
														flexGrow: 1,
														display: "flex",
														alignItems: "center",
														justifyContent: "center",
														padding: "4px",
													}
												: {}
										}
									>
										{v.label}
									</span>
								</button>
							))}
						</div>
						<p className="onboarding-description">
							{t("onboard.character.hint")}
						</p>
					</div>
				)}

				{/* Step: Personality */}
				{step === "personality" && (
					<div className="onboarding-content">
						<h2>
							{t("onboard.personality.title").replace("{agent}", displayName)}
						</h2>
						<div className="onboarding-personality-cards">
							{PERSONALITY_PRESETS.map((p) => (
								<button
									key={p.id}
									type="button"
									className={`onboarding-personality-card${selectedPersonality === p.id ? " selected" : ""}`}
									onClick={() => {
										setSelectedPersonality(p.id);
										setSelectedSpeechStyle(
											p.id === "polite" || p.id === "calm"
												? "formal"
												: "casual",
										);
									}}
								>
									<span className="personality-card-label">
										{t(p.labelKey as any)}
									</span>
									<span className="personality-card-desc">
										{t(p.descKey as any)}
									</span>
								</button>
							))}
						</div>
						<p className="onboarding-description">
							{t("onboard.personality.hint")}
						</p>
					</div>
				)}

				{/* Step: Speech Style */}
				{step === "speechStyle" && (
					<div className="onboarding-content">
						<h2>
							{t("onboard.speechStyle.title").replace("{agent}", displayName)}
						</h2>
						<div className="onboarding-personality-cards">
							<button
								type="button"
								className={`onboarding-personality-card${selectedSpeechStyle === "casual" ? " selected" : ""}`}
								onClick={() => setSelectedSpeechStyle("casual")}
							>
								<span className="personality-card-label">
									{t("onboard.speechStyle.casual")}
								</span>
								<span className="personality-card-desc">
									{t("onboard.speechStyle.casualDesc")}
								</span>
							</button>
							<button
								type="button"
								className={`onboarding-personality-card${selectedSpeechStyle === "formal" ? " selected" : ""}`}
								onClick={() => setSelectedSpeechStyle("formal")}
							>
								<span className="personality-card-label">
									{t("onboard.speechStyle.formal")}
								</span>
								<span className="personality-card-desc">
									{t("onboard.speechStyle.formalDesc")}
								</span>
							</button>
						</div>
						<div className="settings-field" style={{ marginTop: 16 }}>
							<label>{t("onboard.speechStyle.honorificLabel")}</label>
							<input
								type="text"
								className="onboarding-input"
								value={honorificInput}
								onChange={(e) => setHonorificInput(e.target.value)}
								placeholder={t("onboard.speechStyle.honorificPlaceholder")}
							/>
						</div>
						<p className="onboarding-description">
							{t("onboard.speechStyle.hint")}
						</p>
					</div>
				)}

				{/* Step: Complete */}
				{step === "complete" && (
					<div className="onboarding-content">
						<h2>
							{t("onboard.complete.greeting").replace(
								"{name}",
								userName.trim() || "User",
							)}
						</h2>
						<p className="onboarding-description">
							{t("onboard.complete.ready").replace("{agent}", displayName)}
						</p>
						<div
							style={{
								marginTop: 12,
								display: "flex",
								flexDirection: "column",
								gap: 8,
							}}
						>
							<span className="onboarding-description">
								선택: Discord 봇도 지금 연결할 수 있어요.
							</span>
							<div style={{ display: "flex", gap: 8 }}>
								<button
									type="button"
									className="onboarding-back-btn"
									onClick={() => void handleOptionalDiscordConnect()}
									disabled={discordConnectLoading}
									data-testid="onboarding-discord-connect-btn"
								>
									{discordConnectLoading
										? t("onboard.discordConnecting")
										: t("onboard.discordConnect")}
								</button>
								<span className="onboarding-description">
									{discordConnected
										? t("onboard.discordConnected")
										: t("onboard.discordStatus")}
								</span>
							</div>
						</div>
					</div>
				)}

				{/* Navigation */}
				<div className="onboarding-nav">
					{stepIndex > 0 && step !== "complete" && (
						<button
							type="button"
							className="onboarding-back-btn"
							onClick={goBack}
						>
							{t("onboard.back")}
						</button>
					)}
					<div className="onboarding-nav-spacer" />
					{step === "complete" ? (
						<button
							type="button"
							className="onboarding-next-btn"
							onClick={handleComplete}
						>
							{t("onboard.complete.start")}
						</button>
					) : (
						<button
							type="button"
							className="onboarding-next-btn"
							onClick={goNext}
							disabled={!canProceed()}
						>
							{t("onboard.next")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
