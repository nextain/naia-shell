import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdkSetupScreen } from "./components/AdkSetupScreen";
import { AvatarCanvas } from "./components/AvatarCanvas";
import { BgmPlayer } from "./components/BgmPlayer";
import { ChatPanel } from "./components/ChatPanel";
import { ModeBar } from "./components/ModeBar";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { PanelInstallDialog } from "./components/PanelInstallDialog";
import { SplashScreen } from "./components/SplashScreen";
import { TitleBar } from "./components/TitleBar";
import { UpdateBanner } from "./components/UpdateBanner";
import { getBridgeForPanel } from "./lib/active-bridge";
import {
	getAdkPath,
	isAdkInitialized,
	listNaiaAssets,
	setAdkPath,
	toLocalBlobUrl,
} from "./lib/adk-store";
import { syncLinkedChannels } from "./lib/channel-sync";
import {
	sendAuthUpdate,
	sendPanelSkills,
	sendPanelSkillsClear,
} from "./lib/chat-service";
import { emitAiInterferenceEvent } from "./lib/ai-interference";
import {
	type ThemeId,
	isOnboardingComplete,
	loadConfig,
	migrateLabKeyToNaiaKey,
	migrateLiveProviderToUnifiedModel,
	migrateSpeechStyleValues,
	saveConfig,
} from "./lib/config";
import { persistDiscordDefaults } from "./lib/discord-auth";
import { startIframeBridge } from "./lib/iframe-bridge";
import { Logger } from "./lib/logger";
import { loadInstalledPanels } from "./lib/panel-loader";
import { panelRegistry } from "./lib/panel-registry";
import { type UpdateInfo, checkForUpdate } from "./lib/updater";
import { useAvatarStore } from "./stores/avatar";
import "./panels/browser/index"; // register browser panel
import "./panels/workspace/index"; // register workspace panel
import "./panels/settings/index"; // register settings panel
// sample-note panel removed — will be replaced by a proper memo app later
import { usePanelStore } from "./stores/panel";

const NAIA_WIDTH_DEFAULT = 320;
const NAIA_WIDTH_MIN = 240;
const NAIA_WIDTH_MAX = 560;

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
 * Readiness gate for the splash screen.
 *
 * ADK/onboarding paths signal ready immediately (synchronous render).
 * Normal path waits for VRM avatar load, with a 5 s timeout for VRM failure.
 */
function useAppReady(showAdkSetup: boolean): boolean {
	const avatarLoaded = useAvatarStore((s) => s.isLoaded);
	const [timedOut, setTimedOut] = useState(false);

	useEffect(() => {
		if (showAdkSetup) return;
		const t = setTimeout(() => {
			Logger.warn("App", "useAppReady: 5 s timeout — forcing splash dismiss");
			setTimedOut(true);
		}, 5000);
		return () => clearTimeout(t);
	}, [showAdkSetup]);

	if (showAdkSetup) return true;
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
	const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
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
	const appReady = useAppReady(showAdkSetup);
	const onSplashDone = useCallback(() => setShowSplash(false), []);

	const { activePanel, toggleAiInterferenceEnabled } = usePanelStore();

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
			if (!saved) return; // no saved preference → keep default space background
			const match = paths.find((p) => p.endsWith(saved));
			if (match) {
				setBackgroundMediaType(getBackgroundMediaType(match));
				setBackgroundVideoUrl(await toLocalBlobUrl(match));
			}
		});
	}, [showAdkSetup]);

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
	}, []);

	useEffect(() => {
		const updateTitle = () => {
			setAppTitle(loadConfig()?.agentName?.trim() || "Naia");
		};
		window.addEventListener("naia-config-changed", updateTitle);
		window.addEventListener("storage", updateTitle);
		return () => {
			window.removeEventListener("naia-config-changed", updateTitle);
			window.removeEventListener("storage", updateTitle);
		};
	}, []);

	useEffect(() => {
		if (showOnboarding) return;
		checkForUpdate()
			.then((info) => {
				if (info) setUpdateInfo(info);
			})
			.catch(() => {});
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
		const unlisten = listen<{ naiaKey?: string }>(
			"naia_auth_complete",
			(event) => {
				if (event.payload.naiaKey) {
					sendAuthUpdate(event.payload.naiaKey).catch(() => {});
				}
				void syncLinkedChannels();
			},
		);
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// On init: if naiaKey exists in config, push it to the agent (backend).
	// Handles the case where the app restarts after a previous login.
	useEffect(() => {
		const naiaKey = loadConfig()?.naiaKey;
		if (naiaKey) {
			sendAuthUpdate(naiaKey).catch(() => {});
		}
	}, []);

	const handleWinResize = (dir: WinResizeDir) => (e: React.PointerEvent) => {
		e.preventDefault();
		getCurrentWindow().startResizeDragging(dir);
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
		<div
			className="app-root"
			style={{ "--naia-width": `${naiaWidth}px` } as React.CSSProperties}
		>
			{/* ① Background — always the base layer, z-index:0 */}
			{backgroundVideoUrl &&
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
					<BgmPlayer />
					{updateInfo && !showOnboarding && (
						<UpdateBanner
							info={updateInfo}
							onDismiss={() => setUpdateInfo(null)}
						/>
					)}
					{naiaVisible && (
						<>
							{/* Full-screen avatar canvas — renders behind all UI panels */}
							<div className="avatar-canvas-layer">
								<AvatarCanvas />
							</div>
							<div className="naia-overlay">
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
										<ChatPanel />
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
							{!showOnboarding && (
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
										onComplete={() => setShowOnboarding(false)}
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
													<PanelCenter naia={getBridgeForPanel(panel.id)} />
												</div>
											);
										})}
										{activePanel &&
											!keepAlivePanels.some((p) => p.id === activePanel) && (
												<div className="content-panel__slot content-panel__slot--active">
													{CenterComponent ? (
														<CenterComponent
															naia={getBridgeForPanel(activePanel)}
														/>
													) : (
														<div className="content-panel__home" />
													)}
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
	);
}
