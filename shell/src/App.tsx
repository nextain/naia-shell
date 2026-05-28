import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdkSetupScreen } from "./components/AdkSetupScreen";
import { AiControlBar } from "./components/AiControlBar";
import { AvatarCanvas } from "./components/AvatarCanvas";
import { ChatPanel } from "./components/ChatPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ModeBar } from "./components/ModeBar";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { PanelInstallDialog } from "./components/PanelInstallDialog";
import { SplashScreen } from "./components/SplashScreen";
import { TitleBar } from "./components/TitleBar";
import { UpdateBanner } from "./components/UpdateBanner";
import { getBridgeForPanel } from "./lib/active-bridge";
import {
	copyBundledAssets,
	getAdkPath,
	isAdkInitialized,
	listNaiaAssets,
	setAdkPath,
	toLocalBlobUrl,
	buildNaiaConfigEnv,
	writeNaiaConfig,
} from "./lib/adk-store";
import { agentAuthReceived } from "./lib/agent-ipc";
import {
	AuthStatusContext,
	startAuthStatusTracking,
	type AuthStatusSnapshot,
} from "./lib/auth-status-store";
import { emitAiInterferenceEvent } from "./lib/ai-interference";
import { syncLinkedChannels } from "./lib/channel-sync";
import {
	sendAuthUpdate,
	sendCredsUpdate,
	sendGetConfig,
	sendNotifyConfig,
	sendPanelSkills,
	sendPanelSkillsClear,
} from "./lib/chat-service";
import {
	type ThemeId,
	addAllowedTool,
	isOnboardingComplete,
	loadConfig,
	loadConfigWithSecrets,
	migrateLabKeyToNaiaKey,
	migrateLiveProviderToUnifiedModel,
	migrateSpeechStyleValues,
	saveConfig,
} from "./lib/config";
import { persistDiscordDefaults } from "./lib/discord-auth";
import { startIframeBridge } from "./lib/iframe-bridge";
import { Logger } from "./lib/logger";
import { loadInstalledPanels } from "./lib/panel-loader";
import {
	shouldMigrateDevOnlyModel,
	shouldMigrateNextainModel,
} from "./lib/llm/registry";
import { panelRegistry } from "./lib/panel-registry";
import { type UpdateInfo, checkForUpdate } from "./lib/updater";
import {
	type Announcement,
	fetchUnreadAnnouncements,
} from "./lib/announcements";
import { AnnouncementBanner } from "./components/AnnouncementBanner";
import { useAvatarStore } from "./stores/avatar";
import "./panels/browser/index"; // register browser panel
import "./panels/workspace/index"; // register workspace panel
import "./panels/settings/index"; // register settings panel
// sample-note panel removed — will be replaced by a proper memo app later
import { usePanelStore } from "./stores/panel";

const NAIA_WIDTH_DEFAULT = 320;
const NAIA_WIDTH_MIN = 120;
const NAIA_WIDTH_MAX = 1200;

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "ogg", "avi"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);

function getFileExt(url: string): string {
	return url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
}
function isVideoFile(url: string): boolean {
	return VIDEO_EXTS.has(getFileExt(url));
}
function isImageFile(url: string): boolean {
	return IMAGE_EXTS.has(getFileExt(url));
}
function getBackgroundMediaType(path: string): "image" | "video" | "" {
	if (isVideoFile(path)) return "video";
	if (isImageFile(path)) return "image";
	return "";
}

type WinResizeDir =
	| "North"
	| "South"
	| "East"
	| "West"
	| "NorthEast"
	| "NorthWest"
	| "SouthEast"
	| "SouthWest";

function resolveSystemTheme(): string {
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "midnight"
		: "espresso";
}

function applyTheme(theme: ThemeId) {
	const resolved = theme === "system" ? resolveSystemTheme() : theme;
	document.documentElement.setAttribute("data-theme", resolved);
}

/**
 * Readiness gate for the splash screen (#254).
 *
 * Branch handling:
 *  - ADK setup screen → ready immediately (AvatarCanvas never mounts)
 *  - Onboarding screen → ready immediately (AvatarCanvas never mounts)
 *  - Normal path → wait for VRM avatar `isLoaded`, with 5 s timeout fallback
 *
 * The timeout is the safety net for VRM load failure / slow GPU init —
 * without it, a single asset failure would freeze the splash indefinitely.
 */
function useAppReady(showAdkSetup: boolean, showOnboarding: boolean): boolean {
	const avatarLoaded = useAvatarStore((s) => s.isLoaded);
	const [timedOut, setTimedOut] = useState(false);
	const skipAvatarWait = showAdkSetup || showOnboarding;

	useEffect(() => {
		if (skipAvatarWait || avatarLoaded) return;
		const t = setTimeout(() => {
			Logger.warn("App", "useAppReady: 5 s timeout — forcing splash dismiss");
			setTimedOut(true);
		}, 5000);
		return () => clearTimeout(t);
	}, [skipAvatarWait, avatarLoaded]);

	if (skipAvatarWait) return true;
	return avatarLoaded || timedOut;
}

export function App() {
	const [showSplash, setShowSplash] = useState(true);
	const [showAdkSetup, setShowAdkSetup] = useState(!isAdkInitialized());
	const [showOnboarding, setShowOnboarding] = useState(false);
	const [showPanelInstall, setShowPanelInstall] = useState(false);
	const [naiaVisible, setNaiaVisible] = useState(true);
	const [naiaWidth, setNaiaWidth] = useState(NAIA_WIDTH_DEFAULT);
	const [appTitle, setAppTitle] = useState(
		() => loadConfig()?.agentName?.trim() || "Naia",
	);
	const [chatVisible, setChatVisible] = useState(true);
	const [chatHeight, setChatHeight] = useState(() =>
		Math.round(window.innerHeight * 0.4),
	);
	const chatDragRef = useRef<{
		startY: number;
		startH: number;
		moved: boolean;
	} | null>(null);
	const naiaWidthDragRef = useRef<{
		startX: number;
		startW: number;
		currentW: number;
		moved: boolean;
	} | null>(null);
	const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
	const [announcements, setAnnouncements] = useState<Announcement[]>([]);

	// #337 Phase 6a — tri-state auth status sourced from the agent (not from
	// secure-keys.dat slot). Legacy `naiaKey`-derived UI gating in SettingsTab
	// stays additive during this phase; Phase 6c removes it entirely.
	const [authStatus, setAuthStatus] = useState<AuthStatusSnapshot>({
		status: "checking",
		mode: "prod",
	});
	const backgroundVideoUrl = useAvatarStore((s) => s.backgroundVideoUrl);
	const backgroundMediaType = useAvatarStore((s) => s.backgroundMediaType);
	const setBackgroundVideoUrl = useAvatarStore((s) => s.setBackgroundVideoUrl);
	const setBackgroundMediaType = useAvatarStore(
		(s) => s.setBackgroundMediaType,
	);

	// Window starts hidden (visible:false in tauri.conf.json) to prevent white flash.
	// Show it on first render — splash screen's dark background is already painted.
	useEffect(() => {
		// getCurrentWindow() can throw synchronously in test environments
		try {
			void getCurrentWindow()
				.show()
				.catch((err) => {
					Logger.warn("App", "failed to show window", { error: String(err) });
				});
		} catch (err) {
			Logger.warn("App", "failed to show window (sync)", {
				error: String(err),
			});
		}
		Logger.debug("App", "window shown on first render");
	}, []);

	// Readiness gate: splash stays until the active branch has something to show
	const appReady = useAppReady(showAdkSetup, showOnboarding);
	const onSplashDone = useCallback(() => setShowSplash(false), []);

	const {
		activePanel,
		toggleAiInterferenceEnabled,
		setTtsEnabled,
	} = usePanelStore();

	// Initialise ttsEnabled from persisted config on mount
	useEffect(() => {
		const cfg = loadConfig();
		if (cfg?.ttsEnabled !== undefined) setTtsEnabled(cfg.ttsEnabled);
	}, [setTtsEnabled]);

	// Sync panel tools with agent on panel switch, and call lifecycle hooks
	const prevPanelRef = useRef<string | null>(null);
	useEffect(() => {
		const prev = prevPanelRef.current;
		prevPanelRef.current = activePanel;

		if (prev && prev !== activePanel) {
			// keepAlive panels stay mounted — don't clear their skills so the
			// LLM can still call them (e.g. skill_browser_navigate from Chat).
			const prevDescriptor = panelRegistry.get(prev);
			if (!prevDescriptor?.keepAlive) {
				sendPanelSkillsClear(prev).catch(() => {});
			}
			prevDescriptor?.onDeactivate?.();
		}
		if (activePanel) {
			const descriptor = panelRegistry.get(activePanel);
			descriptor?.onActivate?.();
			if (descriptor?.tools && descriptor.tools.length > 0) {
				sendPanelSkills(activePanel, descriptor.tools).catch(() => {});
			}
		}
	}, [activePanel]);

	useEffect(() => {
		if (!activePanel) return;
		emitAiInterferenceEvent({
			source: "panel",
			action: "activated",
			panelId: activePanel,
			summary: `${activePanel} panel activated`,
		});
	}, [activePanel]);

	useEffect(() => {
		const stopIframeBridge = startIframeBridge();
		return stopIframeBridge;
	}, []);

	// Register keepAlive panel tools with the agent at startup so the LLM can
	// call them regardless of which panel is currently active (e.g. asking Naia
	// to open a website while on the Chat panel).
	useEffect(() => {
		const all = panelRegistry.list();
		for (const descriptor of all) {
			if (
				descriptor.keepAlive &&
				descriptor.tools &&
				descriptor.tools.length > 0
			) {
				sendPanelSkills(descriptor.id, descriptor.tools)
					.then(() => {
						Logger.info("App", "startup panel skills registered", {
							panel: descriptor.id,
							tools: descriptor.tools?.map((t) => t.name),
						});
					})
					.catch((err) => {
						Logger.warn("App", "startup panel skills failed", {
							panel: descriptor.id,
							error: String(err),
						});
					});
			}
		}
	}, []);

	// Load background video from naia-settings/background/
	useEffect(() => {
		if (showAdkSetup) return;
		listNaiaAssets("background").then(async (paths) => {
			if (paths.length === 0) return;
			const config = loadConfig();
			const saved = config?.backgroundVideo as string | undefined;
			if (!saved) {
				// Default: use morning-coffee background if available
				const defaultBg = paths.find((p) =>
					p.toLowerCase().includes("morning-coffee") ||
					p.toLowerCase().includes("morning_coffee")
				);
				if (defaultBg) {
					setBackgroundMediaType(getBackgroundMediaType(defaultBg));
					setBackgroundVideoUrl(await toLocalBlobUrl(defaultBg));
				}
				return;
			}
			const match = paths.find((p) => p.endsWith(saved));
			if (match) {
				setBackgroundMediaType(getBackgroundMediaType(match));
				setBackgroundVideoUrl(await toLocalBlobUrl(match));
			}
		});
	}, [showAdkSetup, setBackgroundMediaType, setBackgroundVideoUrl]);

	// Re-register asset protocol scope for the existing adk path on startup.
	// copy_bundled_assets is only called during setup; on restart the dynamic
	// scope extension must be re-applied so asset:// URLs work for naia-settings.
	useEffect(() => {
		if (showAdkSetup) return;
		const existingPath = getAdkPath();
		if (existingPath) copyBundledAssets(existingPath).catch(() => {});
	}, [showAdkSetup]);

	// Listen for config_sync from naia-agent (pushed on startup + in response to get_config).
	// Merges agent-loaded config into localStorage so shell never reads config.json directly.
	useEffect(() => {
		const UI_ONLY_KEYS = new Set([
			"theme", "backgroundImage", "backgroundVideo", "vrmModel", "customVrms", "customBgs",
			"sttProvider", "sttModel", "naiaCloudSttBackend",
			"ttsEnabled", "ttsVoice", "ttsProvider", "naiaCloudTtsBackend", "ttsEngine",
			"ttsOutputDeviceId", "sttInputDeviceId", "vllmSttHost", "vllmSttModel", "vllmTtsHost",
			"liveProvider", "liveVoice", "liveModel", "openaiRealtimeVoice", "voice", "voiceConversation",
			"panelPosition", "panelVisible", "panelSize", "deletedPanels",
			"bgmTrack", "bgmSource", "bgmYoutubeVideoId", "bgmYoutubeTitle",
			"bgmYoutubeChannel", "bgmYoutubeThumbnail", "bgmVolume", "bgmPlaying",
			"gatewayTtsAuto", "gatewayTtsMode",
			"discordSessionMigrated", "lastProcessedDiscordMessageId",
			"locale", "naiaUserId",
		]);
		const SECRET_KEYS = new Set([
			"apiKey", "naiaKey", "googleApiKey",
			"openaiTtsApiKey", "elevenlabsApiKey", "gatewayToken", "openaiRealtimeApiKey",
			"memoryEmbeddingApiKey", "memoryLlmApiKey", "qdrantApiKey",
			"NAIA_ANYLLM_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GLM_API_KEY",
		]);
		let unlisten: (() => void) | undefined;
		listen<string>("agent_response", (event) => {
			try {
				const msg = JSON.parse(event.payload);
				// When agent restarts and signals ready, request a fresh config sync.
				if (msg?.type === "ready") {
					sendGetConfig().catch(() => {});
					return;
				}
				if (msg?.type !== "config_sync" || !msg.config) return;
				const incoming = msg.config as Record<string, string>;
				const local = loadConfig();
				const patch: Record<string, string> = {};
				for (const [k, v] of Object.entries(incoming)) {
					// Skip env-var keys (NAIA_ / OPENAI_ / ANTHROPIC_ prefix), UI-only, and secrets
					if (k.match(/^[A-Z_]+$/) || UI_ONLY_KEYS.has(k) || SECRET_KEYS.has(k)) continue;
					if (v) patch[k] = v;
				}
				if (Object.keys(patch).length > 0) {
					saveConfig({ ...local, ...patch } as Parameters<typeof saveConfig>[0]);
				}
			} catch {
				// Malformed payload — ignore
			}
		}).then((fn) => { unlisten = fn; }).catch(() => {});
		return () => { unlisten?.(); };
	}, []);

	// Auto-allow built-in skills that are always available (no per-session approval needed).
	// Same pattern as BrowserCenterPanel auto-allowing browser tools on mount.
	useEffect(() => {
		addAllowedTool("skill_panel");
		addAllowedTool("skill_youtube_bgm");
	}, []);

	useEffect(() => {
		void migrateLabKeyToNaiaKey();
		migrateSpeechStyleValues();
		migrateLiveProviderToUnifiedModel();
		loadInstalledPanels().catch(() => {});

		const config = loadConfig();
		const adkPath = getAdkPath();
		if (config?.workspaceRoot && config.workspaceRoot !== adkPath) {
			setAdkPath(config.workspaceRoot);
		} else if (config && adkPath && !config.workspaceRoot) {
			saveConfig({ ...config, workspaceRoot: adkPath });
		}
		applyTheme(config?.theme ?? "midnight");
		// Suppress build-time panels the user has explicitly deleted
		if (config?.deletedPanels?.length) {
			for (const id of config.deletedPanels) {
				panelRegistry.unregister(id);
			}
		}
		if (config?.panelVisible === false) setNaiaVisible(false);
		if (config?.panelSize) {
			// panelSize was 15-80 (%) — convert to px for fixed naia panel
			const px = Math.round((config.panelSize / 100) * 1200);
			setNaiaWidth(Math.max(NAIA_WIDTH_MIN, Math.min(NAIA_WIDTH_MAX, px)));
		}

		const needsOnboarding = !isOnboardingComplete();
		if (showAdkSetup) return; // wait for ADK setup first

		if (needsOnboarding) setShowOnboarding(true);

		navigator.mediaDevices
			?.getUserMedia({ audio: true })
			.then((stream) => {
				for (const track of stream.getTracks()) track.stop();
			})
			.catch(() => {});
	}, [showAdkSetup]);

	useEffect(() => {
		// Debounced file sync: write naia-settings/config.json on every saveConfig call.
		// Covers all saveConfig callers without patching each one individually.
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		const syncConfigToFile = () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				const cfg = loadConfig();
				if (cfg) void writeNaiaConfig({
					...(cfg as unknown as Record<string, unknown>),
					...buildNaiaConfigEnv(cfg),
				});
			}, 800);
		};

		// #333 follow-up — boot-time sync. When the user switches between
		// `pnpm run tauri:dev` / `tauri:prod`, the resolved LAB_GATEWAY_URL
		// (config.ts:561, derived from VITE_NAIA_USE_DEV_GATEWAY flag) changes,
		// but the persisted naia-settings/config.json carries the previous
		// mode's NAIA_ANYLLM_BASE_URL until something fires
		// `naia-config-changed`. That caused a stale dev URL to load into the
		// agent and 401 against the wrong gateway after a mode switch.
		// Force one sync on mount so the file always reflects the current
		// build-time gateway resolution.
		syncConfigToFile();

		const updateTitle = () => {
			setAppTitle(loadConfig()?.agentName?.trim() || "Naia");
		};
		const handleConfigChanged = () => {
			updateTitle();
			syncConfigToFile();
		};
		window.addEventListener("naia-config-changed", handleConfigChanged);
		window.addEventListener("storage", updateTitle);
		return () => {
			window.removeEventListener("naia-config-changed", handleConfigChanged);
			window.removeEventListener("storage", updateTitle);
			// G-10: flush pending debounced write immediately on unmount / app close.
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				const cfg = loadConfig();
				if (cfg) void writeNaiaConfig({ ...(cfg as unknown as Record<string, unknown>), ...buildNaiaConfigEnv(cfg) });
			}
		};
	}, []);

	useEffect(() => {
		if (showOnboarding) return;
		let active = true;
		checkForUpdate()
			.then((info) => {
				if (active && info) setUpdateInfo(info);
			})
			.catch(() => {});
		fetchUnreadAnnouncements()
			.then((list) => {
				if (active && list.length > 0) setAnnouncements(list);
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [showOnboarding]);

	// Follow OS color scheme changes — apply only when saved theme is "system"
	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => {
			const config = loadConfig();
			if ((config?.theme ?? "midnight") === "system") {
				applyTheme("system");
			}
		};
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	// Ctrl+B — toggle Naia panel
	const toggleNaia = useCallback(() => {
		setNaiaVisible((prev) => {
			const next = !prev;
			const config = loadConfig();
			if (config) saveConfig({ ...config, panelVisible: next });
			return next;
		});
	}, []);

	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "b") {
				e.preventDefault();
				toggleNaia();
			}
			if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "a") {
				e.preventDefault();
				toggleAiInterferenceEnabled();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [toggleAiInterferenceEnabled, toggleNaia]);

	useEffect(() => {
		void naiaWidth;
		window.dispatchEvent(new CustomEvent("naia-width-changed"));
	}, [naiaWidth]);

	useEffect(() => {
		const unlisten = listen<{
			discordUserId?: string | null;
			discordChannelId?: string | null;
			discordTarget?: string | null;
		}>("discord_auth_complete", (event) => {
			persistDiscordDefaults(event.payload);
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	useEffect(() => {
		const unlisten = listen<{ naiaKey?: string; deepLinkUrl?: string }>(
			"naia_auth_complete",
			(event) => {
				// #337 Phase 5b — forward the raw deep-link URL to the agent so it
				// can validate state + persist the encrypted auth file. The Rust side
				// is changed to include `deepLinkUrl` in this payload alongside the
				// pre-existing parsed fields. Legacy `naiaKey` path is retained until
				// Phase 6 removes the shell-side secure-keys.dat slot.
				const rawUrl = event.payload.deepLinkUrl;
				if (rawUrl) {
					void agentAuthReceived(rawUrl)
						.then((result) => {
							if (!result.ok) {
								Logger.warn("App", "[auth] agentAuthReceived not ok", {
									reason: result.reason ?? "unknown",
								});
							}
						})
						.catch((err: unknown) => {
							Logger.warn("App", "[auth] agentAuthReceived threw", {
								error: String(err),
							});
						});
				}

				const key = event.payload.naiaKey;
				if (key) {
					// Cache before sending so crash-restart can replay the key.
					invoke("store_startup_message", {
						message: JSON.stringify({ type: "auth_update", naiaKey: key }),
					})
						.catch(() => {})
						.then(() => sendAuthUpdate(key).catch(() => {}));
				}
				void syncLinkedChannels();
			},
		);
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// #337 Phase 6a — start tri-state auth status tracking on mount. Agent is
	// SoT; we synchronously render "checking" until agentAuthQuery resolves,
	// then flip to "logged_in" or "logged_out". Subsequent flips arrive via
	// the agent's `auth_changed` push events.
	useEffect(() => {
		const unsubscribe = startAuthStatusTracking(setAuthStatus);
		return unsubscribe;
	}, []);

	// On init: push auth + credentials + webhooks to the agent (backend).
	// Uses sequential await so store_startup_message caching precedes the IPC
	// send — guaranteeing the Rust cache is populated before the message
	// reaches the agent (safe replay after any future crash/restart).
	useEffect(() => {
		// Migrate saved config that points at a removed gateway model (#248).
		// Previously-saved gemini-3.x selections on the Naia provider now
		// fail with "gateway returned 0 bytes" — auto-swap to the provider's
		// defaultModel (gemini-2.5-pro) and persist before any chat call.
		const preMigrate = loadConfig();
		if (preMigrate) {
			const decision = shouldMigrateNextainModel(
				preMigrate.provider,
				preMigrate.model,
			);
			if (decision.migrate) {
				Logger.warn("App", "#248 model migration", {
					from: preMigrate.model,
					to: decision.to,
				});
				saveConfig({ ...preMigrate, model: decision.to });
			}

			// Dev-only models (naia-omni-*, backlog #33) saved on dev builds
			// would silently fail in prod (HTTP 400 for unknown model). Swap to
			// the provider's defaultModel before any chat call.
			const latest = loadConfig() ?? preMigrate;
			const devOnlyDecision = shouldMigrateDevOnlyModel(
				latest.provider,
				latest.model,
			);
			if (devOnlyDecision.migrate) {
				Logger.warn("App", "dev-only model migration (prod build)", {
					from: latest.model,
					to: devOnlyDecision.to,
				});
				saveConfig({ ...latest, model: devOnlyDecision.to });
			}
		}

		let active = true; // unmount guard: prevents stale invocations after cleanup

		async function initAuth() {
			const cfg = await loadConfigWithSecrets();
			if (!cfg || !active) return;

			// auth_update: cache first, then send
			const naiaKey = cfg.naiaKey;
			if (naiaKey && active) {
				await invoke("store_startup_message", {
					message: JSON.stringify({ type: "auth_update", naiaKey }),
				}).catch(() => {});
				if (active) await sendAuthUpdate(naiaKey).catch(() => {});
			}

			if (!active) return;

			// notify_config: cache first, then send
			const notifyPayload = {
				slackWebhookUrl: cfg.slackWebhookUrl,
				discordWebhookUrl: cfg.discordWebhookUrl,
				googleChatWebhookUrl: cfg.googleChatWebhookUrl,
				discordDefaultUserId: cfg.discordDefaultUserId,
				discordDefaultTarget: cfg.discordDefaultTarget,
				discordDmChannelId: cfg.discordDmChannelId,
			};
			await invoke("store_startup_message", {
				message: JSON.stringify({ type: "notify_config", ...notifyPayload }),
			}).catch(() => {});
			if (active) await sendNotifyConfig(notifyPayload).catch(() => {});

			if (!active) return;

			// creds_update: cache first, then send
			// Push all per-session credentials once at startup (#260 follow-up).
			const ttsKeys: Record<string, string> = {};
			if (cfg.googleApiKey) ttsKeys.google = cfg.googleApiKey;
			if (cfg.openaiTtsApiKey) ttsKeys.openai = cfg.openaiTtsApiKey;
			if (cfg.elevenlabsApiKey) ttsKeys.elevenlabs = cfg.elevenlabsApiKey;
			// G-11: map naia-os provider → naia-agent creds_update keyMap
			const credsProvider = cfg.provider === "nextain" ? "naia-anyllm" : cfg.provider;
			const credsPayload = {
				keys:
					cfg.apiKey && cfg.provider
						? { [credsProvider]: cfg.apiKey }
						: {},
				...(Object.keys(ttsKeys).length > 0 && { ttsKeys }),
				...(cfg.gatewayToken !== undefined && {
					gatewayToken: cfg.gatewayToken,
				}),
			};
			await invoke("store_startup_message", {
				message: JSON.stringify({ type: "creds_update", ...credsPayload }),
			}).catch(() => {});
			if (active) await sendCredsUpdate(credsPayload).catch(() => {});
		}

		void initAuth();

		return () => {
			active = false; // cancel any in-flight async operations on unmount
		};
	}, []);

	const handleWinResize = (dir: WinResizeDir) => (e: React.PointerEvent) => {
		e.preventDefault();
		getCurrentWindow().startResizeDragging(dir);
	};

	const handleNaiaWidthPointerDown = (e: React.PointerEvent) => {
		e.preventDefault();
		naiaWidthDragRef.current = {
			startX: e.clientX,
			startW: naiaWidth,
			currentW: naiaWidth,
			moved: false,
		};
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		document.body.classList.add("resizing-col");
	};

	const handleNaiaWidthPointerMove = (e: React.PointerEvent) => {
		const ref = naiaWidthDragRef.current;
		if (!ref) return;
		const delta = e.clientX - ref.startX;
		if (!ref.moved && Math.abs(delta) > 4) ref.moved = true;
		if (!ref.moved) return;
		const nextWidth = Math.max(
			NAIA_WIDTH_MIN,
			Math.min(NAIA_WIDTH_MAX, ref.startW + delta),
		);
		ref.currentW = nextWidth;
		setNaiaWidth(nextWidth);
	};

	const handleNaiaWidthPointerUp = () => {
		const ref = naiaWidthDragRef.current;
		naiaWidthDragRef.current = null;
		document.body.classList.remove("resizing-col");
		if (!ref?.moved) return;
		const config = loadConfig();
		if (config) {
			saveConfig({
				...config,
				panelSize: Math.round((ref.currentW / 1200) * 100),
			});
		}
	};

	const winResizeHandles = (
		<>
			<div className="wr-nw" onPointerDown={handleWinResize("NorthWest")} />
			<div className="wr-n" onPointerDown={handleWinResize("North")} />
			<div className="wr-ne" onPointerDown={handleWinResize("NorthEast")} />
			<div className="wr-w" onPointerDown={handleWinResize("West")} />
			<div className="wr-e" onPointerDown={handleWinResize("East")} />
			<div className="wr-sw" onPointerDown={handleWinResize("SouthWest")} />
			<div className="wr-s" onPointerDown={handleWinResize("South")} />
			<div className="wr-se" onPointerDown={handleWinResize("SouthEast")} />
		</>
	);

	const activePanelDescriptor = activePanel
		? panelRegistry.get(activePanel)
		: null;
	const CenterComponent = activePanelDescriptor?.center ?? null;

	const keepAlivePanels = useMemo(
		() =>
			panelRegistry.list().filter((p) => p.builtIn && p.keepAlive !== false),
		[],
	);

	// Single return — SplashScreen always mounts first as a fixed overlay,
	// app content loads underneath, splash removed when ready.
	return (
		<AuthStatusContext.Provider value={authStatus}>
		<div
			className="app-root"
			style={{ "--naia-width": `${naiaWidth}px` } as React.CSSProperties}
		>
			{/* ① Background — always the base layer, z-index:0 */}
			{backgroundMediaType === "iframe" && backgroundVideoUrl ? (
				<iframe
					key={backgroundVideoUrl}
					className="app-bg-iframe"
					src={backgroundVideoUrl}
					allow="autoplay"
					sandbox="allow-scripts allow-same-origin allow-presentation"
					title="BGM"
				/>
			) : backgroundVideoUrl &&
			(backgroundMediaType === "video" ||
				(!backgroundMediaType && isVideoFile(backgroundVideoUrl))) ? (
				<video
					key={backgroundVideoUrl}
					className="app-bg-video"
					src={backgroundVideoUrl}
					autoPlay
					loop
					muted
					playsInline
				/>
			) : backgroundVideoUrl &&
				(backgroundMediaType === "image" ||
					(!backgroundMediaType && isImageFile(backgroundVideoUrl))) ? (
				<img
					key={backgroundVideoUrl}
					className="app-bg-image"
					src={backgroundVideoUrl}
					alt=""
				/>
			) : (
				<img
					className="app-bg-image"
					src="/assets/background/background-space.png"
					alt=""
				/>
			)}

			{/* ② Splash — position:fixed covers everything */}
			{showSplash && <SplashScreen onDone={onSplashDone} ready={appReady} />}

			{/* ③ Window resize handles */}
			{winResizeHandles}

			{/* ④ ADK setup */}
			{showAdkSetup && (
				<>
					<TitleBar
						panelVisible={naiaVisible}
						onTogglePanel={toggleNaia}
						title={appTitle}
					/>
					<AdkSetupScreen
						onComplete={() => {
							setShowSplash(true);
							setShowAdkSetup(false);
							if (!isOnboardingComplete()) setShowOnboarding(true);
						}}
					/>
				</>
			)}

			{/* ⑤ Main app — always visible after ADK setup */}
			{!showAdkSetup && (
				<>
					<TitleBar
						panelVisible={naiaVisible}
						onTogglePanel={toggleNaia}
						title={appTitle}
					/>

					{updateInfo && !showOnboarding && (
						<UpdateBanner
							info={updateInfo}
							onDismiss={() => setUpdateInfo(null)}
						/>
					)}
					{announcements.length > 0 && !showOnboarding && (
						<AnnouncementBanner
							announcements={announcements}
							onDismissOne={(id) =>
								setAnnouncements((prev) => prev.filter((a) => a.id !== id))
							}
							onDismissAll={() => setAnnouncements([])}
						/>
					)}
					{naiaVisible && !showOnboarding && (
						<div
							className="naia-work-rail"
							onPointerDown={handleNaiaWidthPointerDown}
							onPointerMove={handleNaiaWidthPointerMove}
							onPointerUp={handleNaiaWidthPointerUp}
							onPointerCancel={handleNaiaWidthPointerUp}
							title="작업영역 경계 드래그"
						/>
					)}
					{naiaVisible && (
						<>
							{/* Full-screen avatar canvas — renders behind all UI panels */}
							<div className="avatar-canvas-layer">
								<AvatarCanvas />
							</div>
							<div className="naia-overlay">
								{/* AI + avatar controls — top of avatar column, independent */}
								<AiControlBar />
								{/* Chat floats over avatar — absolute at bottom */}
								<div className="naia-chat-area">
									<button
										type="button"
										className="naia-chat-toggle"
										aria-label={chatVisible ? "대화창 닫기" : "대화창 열기"}
										onPointerDown={(e) => {
											chatDragRef.current = {
												startY: e.clientY,
												startH: chatHeight,
												moved: false,
											};
											(e.currentTarget as HTMLElement).setPointerCapture(
												e.pointerId,
											);
										}}
										onPointerMove={(e) => {
											const ref = chatDragRef.current;
											if (!ref) return;
											const delta = ref.startY - e.clientY;
											if (!ref.moved && Math.abs(delta) > 4) ref.moved = true;
											if (ref.moved) {
												setChatHeight(
													Math.max(120, Math.min(600, ref.startH + delta)),
												);
											}
										}}
										onPointerUp={() => {
											const ref = chatDragRef.current;
											chatDragRef.current = null;
											if (!ref?.moved) setChatVisible((v) => !v);
										}}
									>
										{chatVisible ? "▼" : "▲"}
									</button>
									<div
										className={`naia-chat-wrapper${chatVisible ? "" : " naia-chat-wrapper--hidden"}`}
										style={chatVisible ? { height: chatHeight } : undefined}
									>
										<ErrorBoundary scope="ChatPanel">
											<ChatPanel />
										</ErrorBoundary>
									</div>
								</div>
							</div>
						</>
					)}

					<div
						className="app-layout"
						style={
							{
								left: showOnboarding ? 0 : naiaVisible ? naiaWidth : 0,
							} as React.CSSProperties
						}
					>
						<div className="right-area">
							{!showSplash && !showOnboarding && (
								<>
									<ModeBar onAddMode={() => setShowPanelInstall(true)} />
									{showPanelInstall && (
										<PanelInstallDialog
											onClose={() => setShowPanelInstall(false)}
										/>
									)}
								</>
							)}
							<div
								className={`right-content${showOnboarding ? " right-content--onboarding" : ""}`}
							>
								{showOnboarding ? (
									<OnboardingWizard
										onComplete={() => {
											Logger.info("App", "Onboarding complete — mounting main app panels");
											setShowOnboarding(false);
										}}
									/>
								) : (
									<div
										className={`content-panel${!activePanel ? " content-panel--hidden" : ""}`}
									>
										{keepAlivePanels.map((panel) => {
											const PanelCenter = panel.center;
											return (
												<div
													key={panel.id}
													className={`content-panel__slot${activePanel === panel.id ? " content-panel__slot--active" : ""}`}
												>
													<ErrorBoundary scope={`Panel(${panel.id})`}>
														<PanelCenter naia={getBridgeForPanel(panel.id)} />
													</ErrorBoundary>
												</div>
											);
										})}
										{activePanel &&
											!keepAlivePanels.some((p) => p.id === activePanel) && (
												<div className="content-panel__slot content-panel__slot--active">
													<ErrorBoundary scope={`Panel(${activePanel})`}>
														{CenterComponent ? (
															<CenterComponent
																naia={getBridgeForPanel(activePanel)}
															/>
														) : (
															<div className="content-panel__home" />
														)}
													</ErrorBoundary>
												</div>
											)}
									</div>
								)}
							</div>
						</div>
					</div>
				</>
			)}
		</div>
		</AuthStatusContext.Provider>
	);
}
