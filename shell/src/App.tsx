import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { AvatarCanvas } from "./components/AvatarCanvas";
import { ChatPanel } from "./components/ChatPanel";
import { ModeBar } from "./components/ModeBar";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { PanelInstallDialog } from "./components/PanelInstallDialog";
import { TitleBar } from "./components/TitleBar";
import { UpdateBanner } from "./components/UpdateBanner";
import { WslSetupScreen } from "./components/WslSetupScreen";
import { getBridgeForPanel } from "./lib/active-bridge";
import { syncLinkedChannels } from "./lib/channel-sync";
import { sendAuthUpdate, sendPanelSkills, sendPanelSkillsClear } from "./lib/chat-service";
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
import { restartGateway } from "./lib/gateway-sync";
import { loadInstalledPanels } from "./lib/panel-loader";
import { panelRegistry } from "./lib/panel-registry";
import { type UpdateInfo, checkForUpdate } from "./lib/updater";
import "./panels/browser/index"; // register browser panel
import "./panels/workspace/index"; // register workspace panel
// sample-note panel removed — will be replaced by a proper memo app later
import { usePanelStore } from "./stores/panel";

const NAIA_WIDTH_DEFAULT = 320;
const NAIA_WIDTH_MIN = 240;
const NAIA_WIDTH_MAX = 560;

function resolveSystemTheme(): string {
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "midnight"
		: "espresso";
}

function applyTheme(theme: ThemeId) {
	const resolved = theme === "system" ? resolveSystemTheme() : theme;
	document.documentElement.setAttribute("data-theme", resolved);
}

export function App() {
	const [showWslSetup, setShowWslSetup] = useState(false);
	const [showOnboarding, setShowOnboarding] = useState(false);
	const [showPanelInstall, setShowPanelInstall] = useState(false);
	const [naiaVisible, setNaiaVisible] = useState(true);
	const [naiaWidth, setNaiaWidth] = useState(NAIA_WIDTH_DEFAULT);
	const [avatarHeight, setAvatarHeight] = useState(240);
	const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
	const naiaWidthRef = useRef(naiaWidth);
	naiaWidthRef.current = naiaWidth;
	const avatarHeightRef = useRef(avatarHeight);
	avatarHeightRef.current = avatarHeight;

	const { activePanel } = usePanelStore();

	// Sync panel tools with agent on panel switch, and call lifecycle hooks
	const prevPanelRef = useRef<string | null>(null);
	useEffect(() => {
		const prev = prevPanelRef.current;
		prevPanelRef.current = activePanel;

		if (prev && prev !== activePanel) {
			sendPanelSkillsClear(prev).catch(() => {});
			panelRegistry.get(prev)?.onDeactivate?.();
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
		const stopIframeBridge = startIframeBridge();
		return stopIframeBridge;
	}, []);

	useEffect(() => {
		void migrateLabKeyToNaiaKey();
		migrateSpeechStyleValues();
		migrateLiveProviderToUnifiedModel();
		loadInstalledPanels().catch(() => {});

		const config = loadConfig();
		applyTheme(config?.theme ?? "espresso");
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

		// Check platform tier on startup — Windows Tier 1 shows WSL setup
		invoke("get_platform_tier")
			.then((tier) => {
				const info = tier as { platform: string; tier: number };
				if (info.platform === "windows" && info.tier === 1) {
					setShowWslSetup(true);
				} else if (needsOnboarding) {
					setShowOnboarding(true);
				}
			})
			.catch(() => {
				if (needsOnboarding) setShowOnboarding(true);
			})
			.finally(() => {
				requestAnimationFrame(() => {
					invoke("show_window").catch(() => {});
				});
			});

		navigator.mediaDevices
			?.getUserMedia({ audio: true })
			.then((stream) => {
				for (const track of stream.getTracks()) track.stop();
			})
			.catch(() => {});
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
			if ((config?.theme ?? "espresso") === "system") {
				applyTheme("system");
			}
		};
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);

	// Ctrl+B — toggle Naia panel
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "b") {
				e.preventDefault();
				toggleNaia();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, []);

	const toggleNaia = useCallback(() => {
		setNaiaVisible((prev) => {
			const next = !prev;
			const config = loadConfig();
			if (config) saveConfig({ ...config, panelVisible: next });
			return next;
		});
	}, []);

	// Drag-resize avatar area height (inside naia-panel)
	const onAvatarResizeStart = useCallback((e: React.PointerEvent) => {
		e.preventDefault();
		const startY = e.clientY;
		const startH = avatarHeightRef.current;
		document.body.classList.add("resizing-row");

		const onMove = (ev: PointerEvent) => {
			setAvatarHeight(
				Math.max(80, Math.min(600, startH + ev.clientY - startY)),
			);
		};
		const onUp = () => {
			document.body.classList.remove("resizing-row");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, []);

	// Drag-resize between naia-panel and content-panel
	const onResizeStart = useCallback((e: React.PointerEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = naiaWidthRef.current;
		document.body.classList.add("resizing-col");

		const onMove = (ev: PointerEvent) => {
			const next = Math.max(
				NAIA_WIDTH_MIN,
				Math.min(NAIA_WIDTH_MAX, startWidth + ev.clientX - startX),
			);
			setNaiaWidth(next);
		};
		const onUp = () => {
			document.body.classList.remove("resizing-col");
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			setNaiaWidth((w) => {
				const cfg = loadConfig();
				if (cfg)
					saveConfig({ ...cfg, panelSize: Math.round((w / 1200) * 100) });
				return w;
			});
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}, []);

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
		const unlisten = listen("naia_auth_complete", () => {
			void syncLinkedChannels();
		});
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

	// WSL setup screen (Windows Tier 1 — before main UI)
	if (showWslSetup) {
		return (
			<div className="app-root">
				<TitleBar panelVisible={naiaVisible} onTogglePanel={toggleNaia} />
				<WslSetupScreen
					onComplete={() => {
						setShowWslSetup(false);
						restartGateway().catch(() => {});
						if (!isOnboardingComplete()) {
							setShowOnboarding(true);
						}
					}}
				/>
			</div>
		);
	}

	const activePanelDescriptor = activePanel
		? panelRegistry.get(activePanel)
		: null;
	const CenterComponent = activePanelDescriptor?.center ?? null;

	const [keepAlivePanels] = useState(() =>
		panelRegistry.list().filter((p) => p.builtIn && p.keepAlive !== false),
	);

	type WinResizeDir =
		| "North"
		| "South"
		| "East"
		| "West"
		| "NorthEast"
		| "NorthWest"
		| "SouthEast"
		| "SouthWest";
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

	if (showOnboarding) {
		return (
			<div className="app-root">
				{winResizeHandles}
				<TitleBar panelVisible={naiaVisible} onTogglePanel={toggleNaia} />
				<div
					className="app-layout"
					style={{ "--naia-width": "400px" } as React.CSSProperties}
				>
					<div className="naia-panel">
						<OnboardingWizard onComplete={() => setShowOnboarding(false)} />
					</div>
					<div className="right-area">
						<div className="right-content">
							<div className="content-panel">
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
							</div>
						</div>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="app-root">
			{winResizeHandles}
			<TitleBar panelVisible={naiaVisible} onTogglePanel={toggleNaia} />
			{updateInfo && (
				<UpdateBanner info={updateInfo} onDismiss={() => setUpdateInfo(null)} />
			)}
			<div
				className="app-layout"
				style={{ "--naia-width": `${naiaWidth}px` } as React.CSSProperties}
			>
				{naiaVisible && (
					<>
						<div className="naia-panel">
							<div
								className="naia-avatar-area"
								style={{ height: `${avatarHeight}px` }}
							>
								<AvatarCanvas />
							</div>
							<div
								className="avatar-resize-handle"
								onPointerDown={onAvatarResizeStart}
							/>
							<ChatPanel />
						</div>
						<div className="naia-resize-handle" onPointerDown={onResizeStart} />
					</>
				)}
				<div className="right-area">
					<ModeBar onAddMode={() => setShowPanelInstall(true)} />
					{showPanelInstall && (
						<PanelInstallDialog onClose={() => setShowPanelInstall(false)} />
					)}
					<div className="right-content">
						<div className="content-panel">
							{/* Keep-alive panels: always mounted, CSS opacity fade on switch */}
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
							{/* Non-keepAlive builtIn + installed panels: mount/unmount when active */}
							{activePanel &&
								!keepAlivePanels.some((p) => p.id === activePanel) && (
									<div className="content-panel__slot content-panel__slot--active">
										{CenterComponent ? (
											<CenterComponent naia={getBridgeForPanel(activePanel)} />
										) : (
											<div className="content-panel__home" />
										)}
									</div>
								)}
							{/* No panel selected */}
							{!activePanel && (
								<div className="content-panel__slot content-panel__slot--active">
									<div className="content-panel__home" />
								</div>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
