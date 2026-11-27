import type {
	Dispatch,
	MutableRefObject,
	PointerEvent,
	SetStateAction,
} from "react";
import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import slidesIconSvg from "../apps/slides/package-public/icon.svg?raw";
import { getBridgeForApp } from "../lib/active-bridge";
import type { Announcement } from "../lib/announcements";
import { closeRunningApp } from "../lib/app-lifecycle";
import { appRegistry, shouldMountKeepAliveApp } from "../lib/app-registry";
import type { AppInstallRequest } from "../lib/app-store-client";
import { getCameraActions } from "../lib/avatar/camera-actions";
import { CHARCARD_APP_ID, getWebCharcardContext } from "../lib/charcard-chat-start";
import { loadConfig } from "../lib/config";
import { usePaymentLinksHidden } from "../lib/distribution";
import { getLocale, t } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import {
	getStoredChatHeightRatio,
	setStoredChatHeightRatio,
	syncLayoutOrientationAttribute,
	useEffectiveLayoutOrientation,
} from "../lib/ui-preferences";
import type { UpdateInfo } from "../lib/updater";
import { snoozeStartupUpdatePrompt } from "../lib/updater";
import {
	isNarrowPortraitScreen,
	isWebMode,
	syncWebModeRootAttribute,
} from "../lib/web-runtime/web-assets";
import { isWebAuthenticated } from "../lib/web-runtime/web-auth";
import { openWebLoginPrompt } from "../lib/web-runtime/web-login-prompt";
import { getWebAdkStatus, subscribeWebAdkStatus } from "../lib/web-runtime/web-adk-status";
import { useAppStore } from "../stores/app";
import { useChatStore } from "../stores/chat";
import { AppBar } from "./AppBar";
import { DeferredAdkSetupScreen } from "./DeferredAdkSetupScreen";
import { DeferredChatArea } from "./DeferredChatArea";
import { DeferredOnboardingWizard } from "./DeferredOnboardingWizard";
import { ErrorBoundary } from "./ErrorBoundary";
import { KioskVoiceNotice } from "./KioskVoiceNotice";
import { TitleBar } from "./TitleBar";
import { toggleWebCharacterCard } from "./WebRuntimeHarnessBar";

const AiControlBar = lazy(() =>
	import("./AiControlBar").then((module) => ({
		default: module.AiControlBar,
	})),
);

const AnnouncementBanner = lazy(() =>
	import("./AnnouncementBanner").then((module) => ({
		default: module.AnnouncementBanner,
	})),
);

const UpdateBanner = lazy(() =>
	import("./UpdateBanner").then((module) => ({
		default: module.UpdateBanner,
	})),
);

const UpdatePrompt = lazy(() =>
	import("./UpdatePrompt").then((module) => ({
		default: module.UpdatePrompt,
	})),
);

const VideoAvatarCanvas = lazy(() =>
	import("./VideoAvatarCanvas").then((module) => ({
		default: module.VideoAvatarCanvas,
	})),
);

const AvatarCanvas = lazy(() =>
	import("./AvatarCanvas").then((module) => ({
		default: module.AvatarCanvas,
	})),
);

const AppInstallDialog = lazy(() =>
	import("./AppInstallDialog").then((module) => ({
		default: module.AppInstallDialog,
	})),
);

interface ChatDragState {
	startY: number;
	startH: number;
	moved: boolean;
}

function mobileZoom(): number {
	return Number.parseFloat(document.documentElement.style.zoom) || 1;
}

export function mobileSheetDragHeight(
	startHeight: number,
	delta: number,
	viewportHeight: number,
): number {
	return Math.max(136, Math.min(viewportHeight * 0.91, startHeight + delta));
}

export interface AppMainContentProps {
	activeApp: string | null;
	announcements: Announcement[];
	appInstallRequest: AppInstallRequest | null;
	appTitle: string;
	avatarProvider: "vrm" | "naia-video-avatar";
	chatModeOverride: "workspace" | "app";
	chatDragRef: MutableRefObject<ChatDragState | null>;
	chatHeight: number;
	chatVisible: boolean;
	configSaveError: string | null;
	handleNaiaWidthPointerDown: (event: PointerEvent) => void;
	handleNaiaWidthPointerMove: (event: PointerEvent) => void;
	handleNaiaWidthPointerUp: () => void;
	naiaVisible: boolean;
	naiaWidth: number;
	nvaModel: string;
	onAdkSetupComplete: () => void;
	onOnboardingComplete: () => void;
	railCollapsed: boolean;
	setAnnouncements: Dispatch<SetStateAction<Announcement[]>>;
	setAppInstallRequest: Dispatch<SetStateAction<AppInstallRequest | null>>;
	setChatHeight: Dispatch<SetStateAction<number>>;
	setChatMode: (mode: "workspace" | "app") => void;
	setChatVisible: Dispatch<SetStateAction<boolean>>;
	setShowAppInstall: Dispatch<SetStateAction<boolean>>;
	setShowUpdatePrompt: Dispatch<SetStateAction<boolean>>;
	setUpdateInfo: Dispatch<SetStateAction<UpdateInfo | null>>;
	showAdkSetup: boolean;
	showAppInstall: boolean;
	showOnboarding: boolean;
	showSplash: boolean;
	showUpdatePrompt: boolean;
	toggleNaia: () => void;
	toggleRailCollapsed: () => void;
	uiMode: "onboarding" | "setup" | "workspace" | "app";
	updateInfo: UpdateInfo | null;
}

export function AppMainContent(props: AppMainContentProps) {
	const {
		activeApp,
		announcements,
		appInstallRequest,
		appTitle,
		avatarProvider,
		chatModeOverride,
		chatDragRef,
		chatHeight,
		chatVisible,
		configSaveError,
		handleNaiaWidthPointerDown,
		handleNaiaWidthPointerMove,
		handleNaiaWidthPointerUp,
		naiaVisible,
		naiaWidth,
		nvaModel,
		onAdkSetupComplete,
		onOnboardingComplete,
		railCollapsed,
		setAnnouncements,
		setAppInstallRequest,
		setChatHeight,
		setChatMode,
		setChatVisible,
		setShowAppInstall,
		setShowUpdatePrompt,
		setUpdateInfo,
		showAdkSetup,
		showAppInstall,
		showOnboarding,
		showSplash,
		showUpdatePrompt,
		toggleNaia,
		toggleRailCollapsed,
		uiMode,
		updateInfo,
	} = props;
	const activeAppDescriptor = activeApp ? appRegistry.get(activeApp) : null;
	const CenterComponent = activeAppDescriptor?.center ?? null;
	const showAppTitlebar = Boolean(activeAppDescriptor && !activeAppDescriptor.builtIn);
	const chatVariant: "rail" | "floating" =
		chatModeOverride === "workspace" ? "rail" : "floating";
	const appListVersion = useAppStore((state) => state.appListVersion);
	const activatedApps = useAppStore((state) => state.activatedApps ?? []);
	const closedApps = useAppStore((state) => state.closedApps ?? []);
	const appInstanceEpoch = useAppStore((state) => state.appInstanceEpoch ?? {});
	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the registry mutation signal.
	const keepAliveApps = useMemo(
		() => appRegistry.list().filter((app) => app.keepAlive !== false),
		[appListVersion],
	);
	const activatedKeepAliveSet = useMemo(() => {
		const next = new Set(activatedApps);
		if (activeApp) next.add(activeApp);
		return next;
	}, [activatedApps, activeApp]);
	const closedKeepAliveSet = useMemo(() => {
		const next = new Set(closedApps);
		if (activeApp) next.delete(activeApp);
		return next;
	}, [closedApps, activeApp]);
	const webMode = isWebMode();
	const webHostedAppOpen =
		webMode && showAppTitlebar && Boolean(activeAppDescriptor?.htmlEntry);
	const hasMessages = useChatStore((state) => state.messages.length > 0);
	const [mobileSheet, setMobileSheet] = useState<
		"collapsed" | "half" | "expanded"
	>(hasMessages ? "half" : "collapsed");
	const previousHasMessages = useRef(hasMessages);
	const setupSheetTouched = useRef(false);
	const ttsEnabled = useAppStore((state) => state.ttsEnabled);
	const aiInterferenceEnabled = useAppStore(
		(state) => state.aiInterferenceEnabled,
	);
	const paymentLinksHidden = usePaymentLinksHidden();
	const layoutOrientation = useEffectiveLayoutOrientation();
	const charcardContext = useAppStore(getWebCharcardContext);
	const [cardViewContext, setCardViewContext] = useState<typeof charcardContext>(null);
	const mobileCharcardChat = layoutOrientation === "portrait" &&
		webHostedAppOpen && activeApp === CHARCARD_APP_ID &&
		charcardContext !== null && charcardContext !== cardViewContext;
	const webWorkspacePhase = useSyncExternalStore(subscribeWebAdkStatus, () => getWebAdkStatus().phase);
	useEffect(() => {
		if (hasMessages !== previousHasMessages.current) {
			setMobileSheet((current) => {
				if (webMode && webWorkspacePhase !== "ready" && setupSheetTouched.current) return current;
				const setupNeedsRoom = webMode && webWorkspacePhase !== "ready" && layoutOrientation === "portrait" && isNarrowPortraitScreen();
				return hasMessages || setupNeedsRoom ? "half" : "collapsed";
			});
			previousHasMessages.current = hasMessages;
		}
	}, [hasMessages, webMode, webWorkspacePhase, layoutOrientation]);
	useEffect(() => {
		if (!webMode || webWorkspacePhase === "ready") {
			setupSheetTouched.current = false;
			return;
		}
		if ((webWorkspacePhase === "needs-setup" || webWorkspacePhase === "error") && !setupSheetTouched.current && layoutOrientation === "portrait" && isNarrowPortraitScreen()) {
			setMobileSheet((current) => current === "collapsed" ? "half" : current);
		}
	}, [webMode, webWorkspacePhase, layoutOrientation]);
	useEffect(() => {
		if (mobileCharcardChat) {
			setMobileSheet((current) => current === "collapsed" ? "half" : current);
		}
	}, [mobileCharcardChat]);
	const showNarrowMobileChrome = webMode || layoutOrientation === "portrait";
	const [mobileMenu, setMobileMenu] = useState(false);
	const [avatarCornerOpen, setAvatarCornerOpen] = useState(false);
	const kioskDemo = isKioskDemo();
	const avatarCornerTrigger = (
		<button
			type="button"
			data-testid="avatar-controls-toggle"
			className={`naia-chat-mode naia-avatar-corner-trigger${avatarCornerOpen ? " naia-chat-mode--active" : ""}`}
			aria-expanded={avatarCornerOpen}
			aria-label={t("hardkoG1a.layout.resizeAvatar")}
			title={t("hardkoG1a.layout.resizeAvatar")}
			onClick={() => setAvatarCornerOpen((open) => !open)}
		>
			<svg
				className="naia-avatar-corner-trigger__icon"
				viewBox="0 0 24 24"
				aria-hidden="true"
			>
				<circle cx="12" cy="8" r="4" />
				<path d="M5 20c0-3.87 3.13-7 7-7s7 3.13 7 7" />
			</svg>
		</button>
	);
	const [avatarRotateActive, setAvatarRotateActive] = useState(false);
	const avatarRotateRef = useRef(false);
	const [avatarPanActive, setAvatarPanActive] = useState(false);
	const avatarPanRef = useRef({ active: false, moved: false });
	const mobileStart = useRef<{ y: number; height: number } | null>(null);
	// 사람이 대화창 높이를 끌어 정했으면 시연판 기본 높이 상한(40vh)을 풀어 준다.
	const [chatUserSized, setChatUserSized] = useState(
		() => getStoredChatHeightRatio() !== null,
	);
	const setActiveApp = useAppStore((state) => state.setActiveApp);
	useEffect(() => {
		if (!window.visualViewport) return;
		const viewport = window.visualViewport;
		const update = () =>
			document.documentElement.style.setProperty(
				"--mobile-viewport-bottom",
				`${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) / mobileZoom()}px`,
			);
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		update();
		return () => {
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
			document.documentElement.style.removeProperty("--mobile-viewport-bottom");
		};
	}, []);
	syncWebModeRootAttribute();
	syncLayoutOrientationAttribute(layoutOrientation);

	if (showAdkSetup)
		return (
			<>
				{!webMode && (
					<TitleBar
						appVisible={naiaVisible}
						onToggleApp={toggleNaia}
						title={appTitle}
					/>
				)}
				<DeferredAdkSetupScreen onComplete={onAdkSetupComplete} />
			</>
		);

	return (
		<>
			{!webMode && (
				<TitleBar
					appVisible={naiaVisible}
					onToggleApp={toggleNaia}
					title={appTitle}
				/>
			)}
			{configSaveError && (
				<div role="alert" className="app-bar__remove-error">
					{configSaveError}
				</div>
			)}
			{updateInfo && showUpdatePrompt && !showOnboarding && (
				<Suspense fallback={null}>
					<UpdatePrompt
						info={updateInfo}
						onLater={(snoozeForMonth) => {
							setShowUpdatePrompt(false);
							if (snoozeForMonth) {
								snoozeStartupUpdatePrompt(updateInfo.version);
								setUpdateInfo(null);
							}
						}}
					/>
				</Suspense>
			)}
			{updateInfo && !showUpdatePrompt && !showOnboarding && (
				<Suspense fallback={null}>
					<UpdateBanner
						info={updateInfo}
						onDismiss={() => setUpdateInfo(null)}
					/>
				</Suspense>
			)}
			{announcements.length > 0 && !showOnboarding && (
				<Suspense fallback={null}>
					<AnnouncementBanner
						announcements={announcements}
						onDismissOne={(id) =>
							setAnnouncements((items) =>
								items.filter((item) => item.id !== id),
							)
						}
						onDismissAll={() => setAnnouncements([])}
					/>
				</Suspense>
			)}
			{naiaVisible && !showOnboarding && (
				<div
					className="naia-work-rail"
					onPointerDown={handleNaiaWidthPointerDown}
					onPointerMove={handleNaiaWidthPointerMove}
					onPointerUp={handleNaiaWidthPointerUp}
					onPointerCancel={handleNaiaWidthPointerUp}
					title={t("hardkoG1a.layout.resizeWorkspace")}
				/>
			)}
			{naiaVisible && (
				<>
					{showNarrowMobileChrome &&
						(activeApp === "workspace" ||
							activeApp === "settings" ||
							(activeApp === "land.naia.slides" && !webHostedAppOpen)) && (
							<button
								type="button"
								className="web-mobile-workspace-close"
								aria-label="Close"
								onClick={() => setActiveApp(null)}
							>
								✕
							</button>
						)}
					{showNarrowMobileChrome && !showOnboarding && (
						<div className="web-mobile-menu">
							<button
								type="button"
								className="web-mobile-menu-trigger"
								aria-label="Menu"
								aria-expanded={mobileMenu}
								onClick={() => setMobileMenu(!mobileMenu)}
							>
								☰
							</button>
							{mobileMenu && (
								<div className="web-mobile-menu-list">
									{webMode && !kioskDemo && !isWebAuthenticated() && (
										<div className="web-mobile-menu-login">
											<button
												type="button"
												data-testid="web-mobile-login-btn"
												onClick={() => {
													setMobileMenu(false);
													openWebLoginPrompt("account");
												}}
											>
												⚡{" "}
												{t("webLogin.signInFreeCredit")}
											</button>
											<div
												className="web-mobile-menu-login__hint"
												data-testid="web-mobile-login-credit-hint"
											>
												{t("webCredit.signupHint")}
											</div>
										</div>
									)}
									<button
										type="button"
										onClick={() => {
											const btn = document.querySelector<HTMLButtonElement>(
												'[data-testid="ai-bar-interference-btn"], .ai-control-bar button',
											);
											if (btn) btn.click();
											else useAppStore.getState().toggleAiInterferenceEnabled();
											setMobileMenu(false);
										}}
									>
										{t(
											aiInterferenceEnabled
												? "ai.interferenceOn"
												: "ai.interferenceOff",
										).replace(/\s*\([^)]*\)$/, "")}
									</button>
									<button
										type="button"
										onClick={() => {
											document
												.querySelector<HTMLButtonElement>(
													".ai-control-bar button:nth-child(2)",
												)
												?.click();
											setMobileMenu(false);
										}}
									>
										{t(ttsEnabled ? "ai.ttsOn" : "ai.ttsOff")}
									</button>
									<button
										type="button"
										onClick={() => {
											document
												.querySelector<HTMLButtonElement>(
													'[data-testid="ai-bar-proactive-btn"]',
												)
												?.click();
											setMobileMenu(false);
										}}
									>
										{t(
											document
												.querySelector<HTMLButtonElement>(
													'[data-testid="ai-bar-proactive-btn"]',
												)
												?.getAttribute("aria-pressed") === "true" ||
												loadConfig()?.proactiveSpeechPermitted === true
												? "ai.proactiveStop"
												: "ai.proactiveStart",
										).split(":")[0]}
									</button>

									{(["ai.avatarZoomIn", "ai.avatarZoomOut"] as const).map(
										(key) => (
											<button
												type="button"
												key={key}
												onClick={() => {
													const camera = getCameraActions();
													camera.zoom(key === "ai.avatarZoomIn" ? 0.1 : -0.1);
													camera.save();
													setMobileMenu(false);
												}}
											>
												{t(key)}
											</button>
										),
									)}
									<button
										type="button"
										onClick={() => {
											document
												.querySelector<HTMLButtonElement>(".new-chat-btn")
												?.click();
											setMobileMenu(false);
											setActiveApp(null);
										}}
									>
										{t("chat.newConversation")}
									</button>
									<button
										type="button"
										onClick={() => {
											setActiveApp("workspace");
											setMobileMenu(false);
										}}
									>
										📁 {t("appbar.workspace")}
									</button>
									{webMode && !kioskDemo && (
										<button
											type="button"
											data-testid="web-character-card-mobile-btn"
											onClick={() => {
												setMobileMenu(false);
												if (mobileCharcardChat) {
													setCardViewContext(charcardContext);
													return;
												}
												void toggleWebCharacterCard();
											}}
										>
											🃏 {t("characterTheme.cardsTitle")}
										</button>
									)}
									{(!paymentLinksHidden || kioskDemo) && (
										<button
											type="button"
											onClick={() => {
												document
													.querySelector<HTMLButtonElement>(
														".app-bar-tab--utility",
													)
													?.click();
												setMobileMenu(false);
											}}
										>
											🛍 {t("appbar.appStore")}
										</button>
									)}
									{isKioskDemo() && (
										<button
											type="button"
											data-app-id="land.naia.slides"
											onClick={() => {
												setActiveApp("land.naia.slides");
												setMobileMenu(false);
											}}
										>
											<img
												className="naia-mobile-menu__icon"
												alt=""
												src={`data:image/svg+xml,${encodeURIComponent(slidesIconSvg)}`}
											/>{" "}
											{t("slides.title")}
										</button>
									)}
									<button
										type="button"
										data-testid="web-mobile-bgm-btn"
										onClick={() => {
											setMobileMenu(false);
											window.dispatchEvent(new CustomEvent("naia:bgm-toggle"));
										}}
									>
										♫ {t("bgm.appToggleTitle")}
									</button>
									<button
										type="button"
										onClick={() => {
											setActiveApp("settings");
											setMobileMenu(false);
										}}
									>
										⚙ {t("settings.title")}
									</button>
								</div>
							)}
						</div>
					)}
					{!import.meta.env.VITE_NAIA_E2E_NO_AVATAR && (
						<div className="avatar-canvas-layer">
							<Suspense fallback={null}>
								{avatarProvider === "naia-video-avatar" ? (
									<Suspense fallback={<AvatarCanvas />}>
										<VideoAvatarCanvas nvaModel={nvaModel} />
									</Suspense>
								) : (
									<AvatarCanvas />
								)}
							</Suspense>
						</div>
					)}
					<div className="naia-overlay">
						<div className="naia-chat-area" data-mobile-sheet={mobileSheet}>
							<button
								type="button"
								className="web-mobile-sheet-handle"
								aria-label="Resize conversation"
								onClick={(event) => {
									// Pointer gestures are handled on pointerup; detail=0 is a keyboard or assistive activation.
									if (event.detail !== 0) return;
									if (webMode && webWorkspacePhase !== "ready") setupSheetTouched.current = true;
									setMobileSheet((state) => state === "half" ? "expanded" : state === "expanded" ? "collapsed" : "half");
								}}
								onPointerDown={(event) => {
									mobileStart.current = {
										y: event.clientY,
										height:
											(event.currentTarget.parentElement?.getBoundingClientRect()
												.height ?? 136) / mobileZoom(),
									};
									event.currentTarget.setPointerCapture(event.pointerId);
								}}
								onPointerMove={(event) => {
									const start = mobileStart.current;
									if (
										!start ||
										Math.abs(start.y - event.clientY) / mobileZoom() < 4
									)
										return;
									document.documentElement.style.setProperty(
										"--mobile-sheet-drag-height",
										`${mobileSheetDragHeight(start.height, (start.y - event.clientY) / mobileZoom(), window.innerHeight / mobileZoom())}px`,
									);
								}}
								onPointerCancel={() => {
									mobileStart.current = null;
									document.documentElement.style.removeProperty(
										"--mobile-sheet-drag-height",
									);
								}}
								onPointerUp={(event) => {
									if (webMode && webWorkspacePhase !== "ready") setupSheetTouched.current = true;
									const delta =
										((mobileStart.current?.y ?? event.clientY) -
											event.clientY) /
										mobileZoom();
									setMobileSheet((state) =>
										delta > 30
											? state === "collapsed"
												? "half"
												: "expanded"
											: delta < -30
												? state === "expanded"
													? "half"
													: "collapsed"
												: state === "half"
													? "expanded"
													: state === "expanded"
														? "collapsed"
														: "half",
									);
									mobileStart.current = null;
									document.documentElement.style.removeProperty(
										"--mobile-sheet-drag-height",
									);
								}}
							>
								<span />
							</button>
							<button
								type="button"
								className="naia-chat-toggle"
								aria-label={
									chatVisible
										? t("hardkoG1a.layout.closeChat")
										: t("hardkoG1a.layout.openChat")
								}
								onPointerDown={(event) => {
									// 화면에 보이는 높이에서 시작한다(상한 때문에 chatHeight 보다 작을 수 있음).
									const shown = event.currentTarget.parentElement
										?.querySelector<HTMLElement>(".naia-chat-wrapper")
										?.getBoundingClientRect().height;
									chatDragRef.current = {
										startY: event.clientY,
										startH: shown && shown > 0 ? shown : chatHeight,
										moved: false,
									};
									(event.currentTarget as HTMLElement).setPointerCapture(
										event.pointerId,
									);
								}}
								onPointerMove={(event) => {
									const drag = chatDragRef.current;
									if (!drag) return;
									const delta = drag.startY - event.clientY;
									if (!drag.moved && Math.abs(delta) > 4) drag.moved = true;
									if (drag.moved) {
										const maxH = Math.max(
											240,
											(typeof window !== "undefined"
												? window.innerHeight
												: 800) - 88,
										);
										const nextH = Math.max(
											120,
											Math.min(maxH, drag.startH + delta),
										);
										setChatUserSized(true);
										setChatHeight(nextH);
									}
								}}
								onPointerUp={() => {
									const drag = chatDragRef.current;
									chatDragRef.current = null;
									if (!drag?.moved) {
										setChatVisible((visible) => !visible);
										return;
									}
									const vh =
										typeof window !== "undefined" && window.innerHeight > 0
											? window.innerHeight
											: 800;
									setStoredChatHeightRatio(chatHeight / vh);
								}}
							>
								{chatVisible ? "▼" : "▲"}
							</button>
							<div
								className={`naia-chat-modes${avatarCornerOpen ? " naia-chat-modes--open" : ""}`}
								// biome-ignore lint/a11y/useSemanticElements: preserve the existing DOM/CSS contract during extraction.
								role="group"
								aria-label={t("hardkoG1a.layout.resizeAvatarChat")}
							>
								{avatarCornerOpen && (
									<div
										className="naia-avatar-corner-panel"
										data-testid="avatar-controls-panel"
									>
										<button
											type="button"
											data-testid="avatar-corner-zoom-in"
											className="naia-chat-mode"
											aria-label={t("ai.avatarZoomIn")}
											title={t("ai.avatarZoomIn")}
											onClick={() => {
												const camera = getCameraActions();
												camera.zoom(0.1);
												camera.save();
											}}
										>
											+
										</button>
										<button
											type="button"
											data-testid="avatar-corner-zoom-out"
											className="naia-chat-mode"
											aria-label={t("ai.avatarZoomOut")}
											title={t("ai.avatarZoomOut")}
											onClick={() => {
												const camera = getCameraActions();
												camera.zoom(-0.1);
												camera.save();
											}}
										>
											−
										</button>
										<button
											type="button"
											data-testid="avatar-corner-pan"
											className={`naia-chat-mode${avatarPanActive ? " naia-chat-mode--active" : ""}`}
											aria-label={t("ai.avatarPan")}
											title={t("ai.avatarPan")}
											style={{
												cursor: avatarPanActive ? "grabbing" : "grab",
												touchAction: "none",
											}}
											onPointerDown={(e) => {
												e.currentTarget.setPointerCapture(e.pointerId);
												avatarPanRef.current = { active: true, moved: false };
												setAvatarPanActive(true);
											}}
											onPointerMove={(e) => {
												if (!avatarPanRef.current.active) return;
												if (
													Math.abs(e.movementX) > 0 ||
													Math.abs(e.movementY) > 0
												) {
													avatarPanRef.current.moved = true;
												}
												getCameraActions().pan(e.movementX, e.movementY);
											}}
											onPointerUp={(e) => {
												e.currentTarget.releasePointerCapture(e.pointerId);
												avatarPanRef.current.active = false;
												setAvatarPanActive(false);
												getCameraActions().save();
											}}
											onPointerCancel={(e) => {
												e.currentTarget.releasePointerCapture(e.pointerId);
												avatarPanRef.current.active = false;
												setAvatarPanActive(false);
											}}
											onClick={() => {
												if (avatarPanRef.current.moved) {
													avatarPanRef.current.moved = false;
													return;
												}
												const camera = getCameraActions();
												camera.pan(0, -12);
												camera.save();
											}}
										>
											✥
										</button>
										<button
											type="button"
											data-testid="avatar-corner-rotate"
											className={`naia-chat-mode${avatarRotateActive ? " naia-chat-mode--active" : ""}`}
											aria-label={t("ai.avatarRotate")}
											title={t("ai.avatarRotate")}
											style={{
												cursor: avatarRotateActive ? "grabbing" : "grab",
												touchAction: "none",
											}}
											onPointerDown={(e) => {
												e.currentTarget.setPointerCapture(e.pointerId);
												avatarRotateRef.current = true;
												setAvatarRotateActive(true);
											}}
											onPointerMove={(e) => {
												if (!avatarRotateRef.current) return;
												getCameraActions().rotate(e.movementX, e.movementY);
											}}
											onPointerUp={(e) => {
												e.currentTarget.releasePointerCapture(e.pointerId);
												avatarRotateRef.current = false;
												setAvatarRotateActive(false);
												getCameraActions().save();
											}}
											onPointerCancel={(e) => {
												e.currentTarget.releasePointerCapture(e.pointerId);
												avatarRotateRef.current = false;
												setAvatarRotateActive(false);
											}}
										>
											⊕
										</button>
										<button
											type="button"
											data-testid="avatar-corner-reset"
											className="naia-chat-mode"
											aria-label={t("ai.avatarReset")}
											title={t("ai.avatarReset")}
											onClick={() => getCameraActions().reset()}
										>
											⌂
										</button>
									<button
										type="button"
										className={`naia-chat-mode${uiMode === "app" ? " naia-chat-mode--active" : ""}`}
										title={t("hardkoG1a.layout.leftCompact")}
										aria-pressed={uiMode === "app"}
										data-usage-event="app-main-content.set-chat-mode-1.click"
										onClick={() => setChatMode("app")}
									>
										▖
									</button>
									<button
										type="button"
										className={`naia-chat-mode${uiMode === "workspace" ? " naia-chat-mode--active" : ""}`}
										title={t("hardkoG1a.layout.leftFill")}
										aria-pressed={uiMode === "workspace"}
										data-usage-event="app-main-content.set-chat-mode-2.click"
										onClick={() => setChatMode("workspace")}
									>
										▌
									</button>
									</div>
								)}
								{!kioskDemo && avatarCornerTrigger}
							</div>
							{kioskDemo && <KioskVoiceNotice />}
							<div
								className={`naia-chat-wrapper${chatVisible ? "" : " naia-chat-wrapper--hidden"}`}
								data-chat-user-sized={chatUserSized ? "true" : undefined}
								style={
									chatVisible && chatVariant !== "rail"
										? { height: chatHeight }
										: undefined
								}
							>
								<DeferredChatArea
									variant={chatVariant}
									headerControls={
										<>
											<Suspense fallback={null}>
											<AiControlBar showCameraControls={false} isNva={avatarProvider === "naia-video-avatar"} />
										</Suspense>
										{kioskDemo && avatarCornerTrigger}
										</>
									}
								/>
							</div>
						</div>
					</div>
				</>
			)}
			{uiMode === "workspace" && naiaVisible && !showOnboarding && (
				<button
					type="button"
					className={`ws-rail-toggle${railCollapsed ? " ws-rail-toggle--collapsed" : ""}`}
					data-usage-event="app-main-content.toggle-rail-collapsed-3.click"
					onClick={toggleRailCollapsed}
					title={railCollapsed ? t("hardkoG1a.layout.expandRail") : t("hardkoG1a.layout.collapseRail")}
					aria-label={
						railCollapsed
							? t("hardkoG1a.layout.expandRail")
							: t("hardkoG1a.layout.collapseRail")
					}
				>
					{railCollapsed ? "💬" : "‹"}
				</button>
			)}
			<div
				className="app-layout"
				data-web-hosted-app={webHostedAppOpen || undefined}
				style={{
					display: mobileCharcardChat ? "none" : undefined,
					left: showOnboarding
						? 0
						: !naiaVisible
							? 0
							: uiMode === "workspace" && railCollapsed
								? 0
								: naiaWidth,
				}}
			>
				<div className="right-area">
					{!showSplash && !showOnboarding && (
						<>
							<AppBar onAddApp={() => setShowAppInstall(true)} />
							{(appInstallRequest || showAppInstall) && (
								<ErrorBoundary scope="AppInstallDialog">
									<Suspense
										fallback={
											<output aria-live="polite">
												{t("progress.loading")}
											</output>
										}
									>
										<AppInstallDialog
											request={appInstallRequest ?? undefined}
											onClose={() => {
												if (appInstallRequest) setAppInstallRequest(null);
												else setShowAppInstall(false);
											}}
										/>
									</Suspense>
								</ErrorBoundary>
							)}
						</>
					)}
					<div
						className={`right-content${showOnboarding ? " right-content--onboarding" : ""}`}
					>
						{showOnboarding ? (
							<DeferredOnboardingWizard onComplete={onOnboardingComplete} />
						) : (
							<div
								className={`content-app${!activeApp ? " content-app--hidden" : ""}${showAppTitlebar ? " content-app--with-titlebar" : ""}`}
							>
								{keepAliveApps.map((app) => {
									// WO-03 / 지시서 #3: 웹판은 브라우저 탭이 꺼져 있어 마운트 자체를 막는다 (browser_wv_create 오류 방지).
									if (
										(isWebMode() && app.id === "browser") ||
										(isKioskDemo() && app.id === "projects")
									) {
										return null;
									}
									if (
										!shouldMountKeepAliveApp(
											app,
											activatedKeepAliveSet,
											closedKeepAliveSet,
										)
									) {
										return null;
									}
									const AppCenter = app.center;
									const epoch = appInstanceEpoch[app.id] ?? 0;
									return (
										<div
											key={`${app.id}:${epoch}`}
											{...(activeApp !== app.id ? { inert: "" } : {})}
											aria-hidden={activeApp !== app.id}
											className={`content-app__slot${activeApp === app.id ? " content-app__slot--active" : ""}`}
										>
											<ErrorBoundary scope={`App(${app.id})`}>
												<AppCenter naia={getBridgeForApp(app.id)} />
											</ErrorBoundary>
										</div>
									);
								})}
								{activeApp &&
									!(isWebMode() && activeApp === "browser") &&
									!(isKioskDemo() && activeApp === "projects") &&
									!keepAliveApps.some((app) => app.id === activeApp) && (
										<div
											key={`${activeApp}:${appInstanceEpoch[activeApp] ?? 0}`}
											className="content-app__slot content-app__slot--active"
										>
											<ErrorBoundary scope={`App(${activeApp})`}>
												{CenterComponent ? (
													<CenterComponent naia={getBridgeForApp(activeApp)} />
												) : (
													<div className="content-app__home" />
												)}
											</ErrorBoundary>
										</div>
									)}
								{activeApp && showAppTitlebar && activeAppDescriptor && (
									// R5: installed apps get a shell title bar so the close
									// button never covers the app's own top-right controls.
									<div
										className="content-app__titlebar"
										data-testid="active-app-titlebar"
									>
										<span className="content-app__title">
											{activeAppDescriptor.names?.[getLocale()] ??
												activeAppDescriptor.name}
										</span>
										<button
											type="button"
											className="content-app__close-btn"
											aria-label={t("appbar.closeApp")}
											title={t("appbar.closeApp")}
											data-testid="active-app-close-btn"
											onClick={() => closeRunningApp(activeApp)}
										>
											✕
										</button>
									</div>
								)}
							</div>
						)}
					</div>
				</div>
			</div>
		</>
	);
}
