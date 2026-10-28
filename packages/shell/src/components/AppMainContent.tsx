import type {
	Dispatch,
	MutableRefObject,
	PointerEvent,
	SetStateAction,
} from "react";
import { Suspense, lazy, useMemo, useRef } from "react";
import { getBridgeForApp } from "../lib/active-bridge";
import type { Announcement } from "../lib/announcements";
import { appRegistry, shouldMountKeepAliveApp } from "../lib/app-registry";
import type { AppInstallRequest } from "../lib/app-store-client";
import { t } from "../lib/i18n";
import type { UpdateInfo } from "../lib/updater";
import { snoozeStartupUpdatePrompt } from "../lib/updater";
import { useAppStore } from "../stores/app";
import { AiControlBar } from "./AiControlBar";
import { AppBar } from "./AppBar";
import { DeferredAdkSetupScreen } from "./DeferredAdkSetupScreen";
import { DeferredChatArea } from "./DeferredChatArea";
import { DeferredOnboardingWizard } from "./DeferredOnboardingWizard";
import { ErrorBoundary } from "./ErrorBoundary";
import { TitleBar } from "./TitleBar";

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
	const chatVariant: "rail" | "floating" =
		chatModeOverride === "workspace" ? "rail" : "floating";
	const appListVersion = useAppStore((state) => state.appListVersion);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the registry mutation signal.
	const keepAliveApps = useMemo(
		() => appRegistry.list().filter((app) => app.keepAlive !== false),
		[appListVersion],
	);
	const activatedKeepAliveAppsRef = useRef(new Set<string>());
	if (activeApp) activatedKeepAliveAppsRef.current.add(activeApp);

	if (showAdkSetup)
		return (
			<>
				<TitleBar
					appVisible={naiaVisible}
					onToggleApp={toggleNaia}
					title={appTitle}
				/>
				<DeferredAdkSetupScreen onComplete={onAdkSetupComplete} />
			</>
		);

	return (
		<>
			<TitleBar
				appVisible={naiaVisible}
				onToggleApp={toggleNaia}
				title={appTitle}
			/>
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
					title="작업영역 경계 드래그"
				/>
			)}
			{naiaVisible && (
				<>
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
						<AiControlBar />
						<div className="naia-chat-area">
							<button
								type="button"
								className="naia-chat-toggle"
								aria-label={chatVisible ? "대화창 닫기" : "대화창 열기"}
								onPointerDown={(event) => {
									chatDragRef.current = {
										startY: event.clientY,
										startH: chatHeight,
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
									if (drag.moved)
										setChatHeight(
											Math.max(120, Math.min(600, drag.startH + delta)),
										);
								}}
								onPointerUp={() => {
									const drag = chatDragRef.current;
									chatDragRef.current = null;
									if (!drag?.moved) setChatVisible((visible) => !visible);
								}}
							>
								{chatVisible ? "▼" : "▲"}
							</button>
							<div
								className="naia-chat-modes"
								// biome-ignore lint/a11y/useSemanticElements: preserve the existing DOM/CSS contract during extraction.
								role="group"
								aria-label="대화창 레이아웃"
							>
								<button
									type="button"
									className={`naia-chat-mode${uiMode === "app" ? " naia-chat-mode--active" : ""}`}
									title="왼쪽 소형"
									aria-pressed={uiMode === "app"}
									onClick={() => setChatMode("app")}
								>
									▖
								</button>
								<button
									type="button"
									className={`naia-chat-mode${uiMode === "workspace" ? " naia-chat-mode--active" : ""}`}
									title="왼쪽 채움"
									aria-pressed={uiMode === "workspace"}
									onClick={() => setChatMode("workspace")}
								>
									▌
								</button>
							</div>
							<div
								className={`naia-chat-wrapper${chatVisible ? "" : " naia-chat-wrapper--hidden"}`}
								style={
									chatVisible && chatVariant !== "rail"
										? { height: chatHeight }
										: undefined
								}
							>
								<DeferredChatArea variant={chatVariant} />
							</div>
						</div>
					</div>
				</>
			)}
			{uiMode === "workspace" && naiaVisible && !showOnboarding && (
				<button
					type="button"
					className={`ws-rail-toggle${railCollapsed ? " ws-rail-toggle--collapsed" : ""}`}
					onClick={toggleRailCollapsed}
					title={railCollapsed ? "대화 레일 펼치기" : "대화 레일 접기"}
					aria-label={railCollapsed ? "대화 레일 펼치기" : "대화 레일 접기"}
				>
					{railCollapsed ? "💬" : "‹"}
				</button>
			)}
			<div
				className="app-layout"
				style={{
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
								className={`content-app${!activeApp ? " content-app--hidden" : ""}`}
							>
								{keepAliveApps.map((app) => {
									if (
										!shouldMountKeepAliveApp(
											app,
											activatedKeepAliveAppsRef.current,
										)
									) {
										return null;
									}
									const AppCenter = app.center;
									return (
										<div
											key={app.id}
											className={`content-app__slot${activeApp === app.id ? " content-app__slot--active" : ""}`}
										>
											<ErrorBoundary scope={`App(${app.id})`}>
												<AppCenter naia={getBridgeForApp(app.id)} />
											</ErrorBoundary>
										</div>
									);
								})}
								{activeApp &&
									!keepAliveApps.some((app) => app.id === activeApp) && (
										<div className="content-app__slot content-app__slot--active">
											<ErrorBoundary scope={`App(${activeApp})`}>
												{CenterComponent ? (
													<CenterComponent naia={getBridgeForApp(activeApp)} />
												) : (
													<div className="content-app__home" />
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
	);
}
