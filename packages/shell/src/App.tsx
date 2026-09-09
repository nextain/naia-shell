import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceAppApi } from "./apps/workspace/types";
import { AppShellFrame } from "./components/AppShellFrame";
import { useAgentAuthSync } from "./hooks/useAgentAuthSync";
import {
	applyTheme,
	getBackgroundMediaType,
	useAppReady,
	useBackgroundFallback,
	useShowAppWindow,
} from "./hooks/useAppPresentation";
import {
	beginNaiaConfigHydration,
	buildNaiaConfigEnv,
	completeNaiaConfigHydration,
	getAdkPath,
	isAdkInitialized,
	listNaiaAssets,
	readNaiaConfig,
	readNaiaUiConfig,
	setAdkPath,
	toLocalBlobUrl,
	writeNaiaConfig,
} from "./lib/adk-store";
import { emitAiInterferenceEvent } from "./lib/ai-interference";
import {
	type Announcement,
	fetchUnreadAnnouncements,
} from "./lib/announcements";
import {
	areInstalledAppsSettled,
	invalidateInstalledApps,
	loadInstalledApps,
} from "./lib/app-loader";
import { appRegistry } from "./lib/app-registry";
import type { AppInstallRequest } from "./lib/app-store-client";
import { effectiveAvatarProviderFromConfig } from "./lib/avatar/nva-gate";
import { BGM_APP_ID, SKILL_YOUTUBE_BGM } from "./lib/bgm-skill";
import { detectGpuVramGb } from "./lib/capabilities/gpu";
import { sendAppSkills, sendAppSkillsClear } from "./lib/chat-service";
import {
	addAllowedTool,
	isOnboardingComplete,
	loadConfig,
	loadConfigWithSecrets,
	mergeBootConfig,
	migrateLabKeyToNaiaKey,
	migrateLegacyDna3OllamaModel,
	migrateLiveProviderToUnifiedModel,
	migrateSpeechStyleValues,
	reconcileExplicitLocalProfile,
	saveConfig,
} from "./lib/config";
import { persistDiscordDefaults } from "./lib/discord-auth";
import {
	ENVIRONMENT_APP_ID,
	SKILL_ENVIRONMENT,
	noteEnvironmentToolAck,
	refreshEnvironment,
} from "./lib/environment-skill";
import { setLocale, t } from "./lib/i18n";
import { startIframeBridge } from "./lib/iframe-bridge";
import { Logger } from "./lib/logger";
import { startSlidePresenterIframeBridge } from "./lib/slide-presenter-iframe-bridge";
import {
	type UpdateInfo,
	checkForUpdate,
	shouldShowStartupUpdatePrompt,
} from "./lib/updater";
import { hydrateLocalRefAudioB64 } from "./lib/voice/ref-audio-api";
import { useAvatarStore } from "./stores/avatar";
import {
	UI_PREFERENCE_KEYS,
	hydrateUiPreferences,
	patchUiPreferences,
	useUiPreference,
} from "./lib/ui-preferences";
import "./apps/browser/index"; // register browser app
import "./apps/workspace/index"; // register workspace app
import "./apps/settings/index"; // register settings app
// sample-note app removed — will be replaced by a proper memo app later
import { useAppStore } from "./stores/app";

const NAIA_WIDTH_DEFAULT = 320;
const NAIA_WIDTH_MIN = 120;
const NAIA_WIDTH_MAX = 1200;

function applyPersistedPresentationConfig(
	config: ReturnType<typeof loadConfig>,
	setVisible: (visible: boolean) => void,
	setWidth: (width: number) => void,
): void {
	applyTheme(config?.theme ?? "midnight");
	if (config?.deletedApps?.length) {
		for (const id of config.deletedApps) appRegistry.unregister(id);
	}
	if (typeof config?.appVisible === "boolean")
		setVisible(config.appVisible);
	if (typeof config?.appSize === "number" && Number.isFinite(config.appSize)) {
		// appSize is stored as a percentage (15–80) and rendered as fixed pixels.
		const px = Math.round((config.appSize / 100) * 1200);
		setWidth(Math.max(NAIA_WIDTH_MIN, Math.min(NAIA_WIDTH_MAX, px)));
	}
}

/**
 * 자동 실행에서 **이번 부팅은 온보딩을 보여야 한다** 는 표식.
 *
 * 값이 `"1"` 이면 아래 e2e 씨앗을 건너뛴다. `e2e-tauri/helpers/settings.ts` 의
 * `resetOnboarding()` 이 세우고, 오버레이를 확인한 뒤 지운다.
 */
export const E2E_FORCE_ONBOARDING_KEY = "naia-e2e-force-onboarding";

export function App() {
	const configHydrationStartedRef = useRef(false);
	if (!configHydrationStartedRef.current) {
		beginNaiaConfigHydration();
		configHydrationStartedRef.current = true;
	}
	// The native WebDriver binary starts with a fresh WebView2 profile. Seed
	// only the explicitly supplied E2E workspace before first render so the
	// real application follows its normal hydrated-config path.
	const e2eMode = import.meta.env.VITE_NAIA_E2E_MODE === "1";
	const e2eAdkPath = e2eMode
		? import.meta.env.VITE_NAIA_E2E_ADK_PATH?.trim()
		: undefined;
	const e2eProvider =
		import.meta.env.VITE_NAIA_E2E_PROVIDER?.trim() || "ollama";
	const e2eModel = import.meta.env.VITE_NAIA_E2E_MODEL?.trim() || "e2e";
	// A native E2E run owns its ADK root.  WebView2 can retain a prior profile
	// while Windows tears it down, so merely filling an absent cache lets an
	// earlier run's workspace silently override this run's seeded config.
	if (e2eAdkPath && getAdkPath() !== e2eAdkPath)
		void setAdkPath(e2eAdkPath).catch((error) => {
			Logger.error("App", "E2E workspace binding failed", {
				error: String(error),
			});
		});
	// 온보딩을 재는 스펙은 이 자리를 한 번 꺼야 한다.
	//
	// 위 대목은 자동 실행이 매 부팅마다 마법사를 건너뛰게 하려고 `naia-config` 를
	// 통째로 다시 쓴다. 그래서 스펙이 `localStorage.removeItem("naia-config")` 로
	// 온보딩을 되살리려 해도, 새로 고침 직후 이 코드가 `onboardingComplete: true`
	// 를 되돌려 놓아 오버레이가 영영 뜨지 않았다(#564 — 09·13·67·54b 가 같은
	// 자리에서 죽었다). 하이드레이션은 선택한 ADK의 파일 값을 복원하므로, 실제로
	// 이 부트스트랩 씨앗이 필요한 경우는 명시적인 E2E 실행뿐이다.
	//
	// 표식은 자동 실행 안에서만 뜻이 있다(`e2eAdkPath` 가 있을 때만 본다).
	// 지우는 것은 헬퍼의 몫이다 — 여기서 지우면 이 블록이 렌더마다 돌므로
	// 마법사 중간에 표식이 사라져 다시 건너뛰게 된다.
	const e2eForceOnboarding =
		typeof localStorage !== "undefined" &&
		localStorage.getItem(E2E_FORCE_ONBOARDING_KEY) === "1";
	if (e2eAdkPath && !e2eForceOnboarding && !isOnboardingComplete()) {
		localStorage.setItem(
			"naia-config",
			JSON.stringify({
				provider: e2eProvider,
				model: e2eModel,
				apiKey: "",
				locale: "ko",
				ttsEnabled: false,
				onboardingComplete: true,
				workspaceRoot: e2eAdkPath,
			}),
		);
	}
	const [showSplash, setShowSplash] = useState(true);
	// 부팅이 실제로 끝났는가. `appReady` 는 설정·로케일·아바타까지만 본다.
	// 앱 목록 읽기가 끝나야 앱바에 앱이 나타나므로 그 구간도 부팅이다.
	const [installedAppsReady, setInstalledAppsReady] = useState(
		areInstalledAppsSettled,
	);
	// #484 CLI + #543 드래그앤드롭 — 열 파일 경로 큐 (앞에서부터 하나씩 연다).
	const [pendingOpenFiles, setPendingOpenFiles] = useState<string[]>([]);
	const [showAdkSetup, setShowAdkSetup] = useState(!isAdkInitialized());
	const [showAppInstall, setShowAppInstall] = useState(false);
	const [appInstallRequest, setAppInstallRequest] =
		useState<AppInstallRequest | null>(null);
	const [localeHydrated, setLocaleHydrated] = useState(showAdkSetup);
	const [showOnboarding, setShowOnboarding] = useState(false);
	const [configHydrated, setConfigHydrated] = useState(false);
	const [configSaveError, setConfigSaveError] = useState<string | null>(null);
	useAgentAuthSync(showAdkSetup, showOnboarding, configHydrated);
	const [naiaVisible, setNaiaVisible] = useState(true);
	const [naiaWidth, setNaiaWidth] = useState(NAIA_WIDTH_DEFAULT);
	const [appTitle, setAppTitle] = useState(
		() => loadConfig()?.agentName?.trim() || "Naia",
	);
	const [chatVisible, setChatVisible] = useState(true);
	const [chatHeight, setChatHeight] = useState(() =>
		Math.round(window.innerHeight * 0.4),
	);
	// 챗 레이아웃 2-way 수동 override. 이전 "home" 중앙 모드는 읽을 때
	// 좌측 소형(app)으로 마이그레이션한다.
	const persistedChatMode = useUiPreference<"workspace" | "app">(
		UI_PREFERENCE_KEYS.chatMode,
		"app",
	);
	const [chatModeOverride, setChatModeOverride] = useState<"workspace" | "app">(
		persistedChatMode,
	);
	useEffect(() => {
		setChatModeOverride(persistedChatMode);
	}, [persistedChatMode]);
	const setChatMode = (m: "workspace" | "app") => {
		setChatModeOverride((cur) => (cur === m ? cur : m));
		void patchUiPreferences({ [UI_PREFERENCE_KEYS.chatMode]: m });
	};
	// Workspace conversation-rail collapse (reclaims horizontal space for the
	// work area). Collapse hides the rail via CSS width:0 — ChatArea stays
	// MOUNTED so an in-flight voice/STT session survives. Persisted (FR-UI.6).
	const persistedRailCollapsed = useUiPreference<boolean>(
		UI_PREFERENCE_KEYS.workspaceRailCollapsed,
		false,
	);
	const [railCollapsed, setRailCollapsed] = useState(persistedRailCollapsed);
	useEffect(() => {
		setRailCollapsed(persistedRailCollapsed);
	}, [persistedRailCollapsed]);
	const toggleRailCollapsed = useCallback(() => {
		setRailCollapsed((v) => {
			const next = !v;
			void patchUiPreferences({
				[UI_PREFERENCE_KEYS.workspaceRailCollapsed]: next,
			});
			return next;
		});
	}, []);
	const chatDragRef = useRef<{
		startY: number;
		startH: number;
		moved: boolean;
	} | null>(null);
	// UC-CONFIG-SOT / FR-CONFIG-SOT.2 — gates the debounced config→file writeback
	// until localStorage has been hydrated FROM naia-settings files, so the stale
	// pre-hydration cache can never be written back into config.json.
	const configHydratedRef = useRef(false);
	const startupUpdateCheckRef = useRef<ReturnType<
		typeof checkForUpdate
	> | null>(null);
	const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
	const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);
	const [announcements, setAnnouncements] = useState<Announcement[]>([]);
	const backgroundVideoUrl = useAvatarStore((s) => s.backgroundVideoUrl);
	const backgroundMediaType = useAvatarStore((s) => s.backgroundMediaType);
	const backgroundFallback = useBackgroundFallback(
		backgroundVideoUrl,
		backgroundMediaType,
	);
	const setBackgroundVideoUrl = useAvatarStore((s) => s.setBackgroundVideoUrl);
	const setBackgroundMediaType = useAvatarStore(
		(s) => s.setBackgroundMediaType,
	);
	const setAvatarModelPath = useAvatarStore((s) => s.setModelPath);
	const [avatarProvider, setAvatarProvider] = useState<
		"vrm" | "naia-video-avatar"
	>("vrm");
	const [nvaModel, setNvaModel] = useState(() => loadConfig()?.nvaModel ?? "");
	const [detectedVramGb, setDetectedVramGb] = useState<number | null>(null);

	useEffect(() => {
		void detectGpuVramGb().then(setDetectedVramGb);
	}, []);

	useEffect(() => {
		let active = true;
		let revision = 0;
		async function syncAvatarConfig() {
			const currentRevision = ++revision;
			const cfg = await loadConfigWithSecrets();
			if (!active || currentRevision !== revision) return;
			setAvatarProvider(effectiveAvatarProviderFromConfig(cfg, detectedVramGb));
			setNvaModel(cfg?.nvaModel ?? "");
			const nextAvatarModelPath = cfg?.vrmModel ?? "";
			if (useAvatarStore.getState().modelPath !== nextAvatarModelPath) {
				setAvatarModelPath(nextAvatarModelPath);
			}
		}
		void syncAvatarConfig();
		window.addEventListener("naia-config-changed", syncAvatarConfig);
		return () => {
			active = false;
			window.removeEventListener("naia-config-changed", syncAvatarConfig);
		};
	}, [detectedVramGb, setAvatarModelPath]);

	// #447-2: onboarding drives the live avatar canvas via a preview event. A
	// fresh install has no saved config during onboarding, so we apply the choice
	// straight to the avatar state instead of round-tripping through config.
	useEffect(() => {
		function onAvatarPreview(e: Event) {
			const detail = (e as CustomEvent).detail as {
				provider?: "vrm" | "naia-video-avatar";
				model?: string;
			} | null;
			if (!detail?.provider) return;
			setAvatarProvider(detail.provider);
			if (detail.provider === "naia-video-avatar" && detail.model)
				setNvaModel(detail.model);
		}
		window.addEventListener("naia-avatar-preview", onAvatarPreview);
		return () =>
			window.removeEventListener("naia-avatar-preview", onAvatarPreview);
	}, []);

	useShowAppWindow();

	// Readiness gate: splash stays until the active branch has something to show
	const appReady = useAppReady(showAdkSetup, showOnboarding, localeHydrated);
	const onSplashDone = useCallback(() => setShowSplash(false), []);

	const { activeApp, toggleAiInterferenceEnabled, setTtsEnabled } =
		useAppStore();

	// Initialise ttsEnabled from persisted config on mount
	useEffect(() => {
		const cfg = loadConfig();
		if (cfg?.ttsEnabled !== undefined) setTtsEnabled(cfg.ttsEnabled);
	}, [setTtsEnabled]);

	// Sync app tools with agent on app switch, and call lifecycle hooks
	const prevAppRef = useRef<string | null>(null);
	useEffect(() => {
		const prev = prevAppRef.current;
		prevAppRef.current = activeApp;

		if (prev && prev !== activeApp) {
			// keepAlive apps stay mounted — don't clear their skills so the
			// LLM can still call them (e.g. skill_browser_navigate from Chat).
			const prevDescriptor = appRegistry.get(prev);
			if (!prevDescriptor?.keepAlive) {
				sendAppSkillsClear(prev).catch(() => {});
			}
			prevDescriptor?.onDeactivate?.();
		}
		if (activeApp) {
			const descriptor = appRegistry.get(activeApp);
			descriptor?.onActivate?.();
			if (descriptor?.tools && descriptor.tools.length > 0) {
				sendAppSkills(activeApp, descriptor.tools).catch(() => {});
			}
		}
	}, [activeApp]);

	useEffect(() => {
		if (!activeApp) return;
		emitAiInterferenceEvent({
			source: "app",
			action: "activated",
			appId: activeApp,
			summary: `${activeApp} app activated`,
		});
	}, [activeApp]);

	useEffect(() => {
		const stopIframeBridge = startIframeBridge();
		const stopSlidePresenterBridge = startSlidePresenterIframeBridge();
		return () => {
			stopIframeBridge();
			stopSlidePresenterBridge();
		};
	}, []);

	// Register keepAlive app tools with the agent at startup so the LLM can
	// call them regardless of which app is currently active (e.g. asking Naia
	// to open a website while on the Chat app).
	useEffect(() => {
		// ADK files are the source of truth. Wait until the selected workspace has
		// been hydrated so an empty/stale render cache cannot enable a skill that
		// the restored config explicitly disabled.
		if (!configHydrated) return;
		// UC8 BGM (FR-BGM.1): BgmPlayer 는 위젯(앱 아님)이라 descriptor.tools 경로가
		// 없다 — 전용 등록. 실행은 ChatArea dispatchAppToolCall 의 BGM 분기.
		sendAppSkills(BGM_APP_ID, [SKILL_YOUTUBE_BGM])
			.then(() =>
				Logger.info("App", "startup bgm skill registered", {
					tool: SKILL_YOUTUBE_BGM.name,
				}),
			)
			.catch((err) =>
				Logger.warn("App", "startup bgm skill failed", { error: String(err) }),
			);
		// #502 실배선 (FR-ENV-LIVE.3): 작업 표면은 화면 앱이 아니라 상시 환경이라
		// descriptor.tools 경로가 없다 — BGM 과 같은 전용 등록.
		// 실행은 ChatArea dispatchAppToolCall 의 환경 분기.
		//
		// 사용자가 인지를 꺼 두었으면 도구를 등록하지 않는다 (FR-ENV-ATTENTION.4). 등록만 하고
		// 안에서 거절하면 도구 목록이 매 요청 토큰을 먹으면서 아무 일도 못 한다 — 껐다는 말은
		// 값도 안 든다는 뜻이어야 한다.
		if ((loadConfig()?.environmentAwareness ?? "auto") !== "off") {
			sendAppSkills(ENVIRONMENT_APP_ID, [SKILL_ENVIRONMENT], { awaitAck: true })
				.then((ok) => {
					noteEnvironmentToolAck(ok);
					return ok;
				})
				.then((ok) =>
					// 반환값을 확인한다. 보내지 못했는데 "등록됨"이라고 적으면 로그가 거짓이 된다.
					// 실제 복구는 대화 턴마다 다시 등록하는 쪽이 한다 (FR-ENV-ATTENTION.16).
					ok
						? Logger.info("App", "startup environment skill registered", {
								tool: SKILL_ENVIRONMENT.name,
							})
						: Logger.warn("App", "startup environment skill not delivered", {
								tool: SKILL_ENVIRONMENT.name,
							}),
				)
				.catch((err) =>
					Logger.warn("App", "startup environment skill failed", {
						error: String(err),
					}),
				);
			// 첫 관측을 미리 받아 둔다 — 사용자의 첫 물음에 되묻지 않기 위해서다 (FR-ENV-LIVE.1).
			// Herdr 이 안 돌고 있으면 조용히 아무것도 모르는 상태로 남는다.
			refreshEnvironment().catch(() => {});
		}
		const all = appRegistry.list();
		for (const descriptor of all) {
			if (
				descriptor.keepAlive &&
				descriptor.tools &&
				descriptor.tools.length > 0
			) {
				sendAppSkills(descriptor.id, descriptor.tools)
					.then(() => {
						Logger.info("App", "startup app skills registered", {
							app: descriptor.id,
							tools: descriptor.tools?.map((t) => t.name),
						});
					})
					.catch((err) => {
						Logger.warn("App", "startup app skills failed", {
							app: descriptor.id,
							error: String(err),
						});
					});
			}
		}
	}, [configHydrated]);

	// Load background from naia-settings/background/. May be a video (.mp4) or a
	// still image (.webp) — getBackgroundMediaType() below resolves which.
	// #342 / #447-3: default to the naia-dawn-city still when no saved preference
	// (this default had regressed back to morning-coffee).
	const DEFAULT_BG_VIDEO = "naia-dawn-city-uhd.webp";
	useEffect(() => {
		if (showAdkSetup || !configHydrated) return;
		let cancelled = false;
		void listNaiaAssets("background").then(async (paths) => {
			if (cancelled || paths.length === 0) return;
			const config = loadConfig();
			const saved =
				(config?.backgroundVideo as string | undefined) ?? DEFAULT_BG_VIDEO;
			const match = paths.find((p) => p.endsWith(saved));
			if (!match || cancelled) return;
			const blobUrl = await toLocalBlobUrl(match);
			if (cancelled) return;
			setBackgroundMediaType(getBackgroundMediaType(match));
			setBackgroundVideoUrl(blobUrl);
		});
		return () => {
			cancelled = true;
		};
	}, [
		configHydrated,
		showAdkSetup,
		setBackgroundMediaType,
		setBackgroundVideoUrl,
	]);

	// Hydrate localStorage FROM naia-settings files on startup — files are SoT,
	// localStorage is a render cache (UC-CONFIG-SOT / FR-CONFIG-SOT.1).
	// The only authoritative localStorage key is "naia-adk-path"; "naia-config"
	// is derived from the files here. `mergeBootConfig` drops the `...local` base
	// that previously let a stale persona (알파) overwrite config.json while
	// retaining file-owned onboarding and UI values.
	// `configHydratedRef` gates the debounced file writeback below so it cannot
	// push the stale pre-hydration cache back into config.json (FR-CONFIG-SOT.2).
	useEffect(() => {
		if (showAdkSetup) {
			// (하이드레이션은 부팅/이 effect 재실행 시에만 돈다 — 파일을 외부에서 고쳤으면 리로드 필요.)
			// AdkSetup 화면 동안은 게이트를 **닫아둔다**. 이전에 여기서 hydrated=true 로
			// 마킹해 mount-time syncConfigToFile(아래 boot-sync)이 800ms 뒤 스테일
			// localStorage persona 를 config.json 에 되썼다(2026-07-16 시연장 실측 —
			// persona 21,187자 → 5,953자 클로버). 설정 완료로 showAdkSetup 이 false 가
			// 되면 이 effect 가 재실행돼 파일→캐시 하이드레이션 후 게이트를 연다.
			return;
		}
		// The selected ADK owns the reference voice clip (naia-settings/voice/
		// ref-audio.wav). Hydrate the synchronous synthesis cache here at boot so
		// the restored voice applies even if the settings screen is never opened.
		// Fire-and-forget — restoring the voice must never block boot.
		hydrateLocalRefAudioB64().catch((error: unknown) => {
			Logger.warn("App", "reference audio hydration failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		let cancelled = false;
		const adkPathAtRead = getAdkPath();
		Promise.all([
			readNaiaConfig(adkPathAtRead),
			readNaiaUiConfig(adkPathAtRead),
		])
			.then(async ([fileConfig, uiConfig]) => {
				if (cancelled || getAdkPath() !== adkPathAtRead) return;
				const adkPath = adkPathAtRead;
				// A selected ADK with no config files is a clean first run. Discard
				// the old render cache so it cannot silently become this ADK's
				// identity, then open the normal onboarding path after the gate is
				// complete. A real read error takes the catch path and leaves the
				// gate closed.
				if (!fileConfig && !uiConfig) {
					setTtsEnabled(false);
					if (adkPath) {
						localStorage.removeItem("naia-config");
						await hydrateUiPreferences(null, {
							adkPath,
							canPersist: false,
						});
						if (cancelled || getAdkPath() !== adkPath) return;
						configHydratedRef.current = true;
						completeNaiaConfigHydration();
						setConfigHydrated(true);
						await hydrateUiPreferences(null, {
							adkPath,
							canPersist: true,
						});
						if (cancelled || getAdkPath() !== adkPath) return;
						setShowOnboarding(true);
					}
					if (cancelled || getAdkPath() !== adkPath) return;
					setLocaleHydrated(true);
					return;
				}
				// Publish file UI values before the full config merge, but keep
				// persistence closed until that merge has replaced the render cache.
				await hydrateUiPreferences(uiConfig, {
					adkPath,
					canPersist: false,
				});
				if (cancelled || getAdkPath() !== adkPath) return;
				const merged = mergeBootConfig(
					loadConfig() as unknown as Record<string, unknown> | null,
					fileConfig ?? null,
					uiConfig ?? null,
				);
				if (merged) {
					// `naia-adk-path` is the only authoritative bootstrap pointer.
					// Never let a stale render-cache workspaceRoot redirect the next
					// file read/write cycle to another workspace.
					const reconciled = reconcileExplicitLocalProfile({
						...merged,
						...(adkPath ? { workspaceRoot: adkPath } : {}),
					} as unknown as Parameters<typeof reconcileExplicitLocalProfile>[0]);
					if (reconciled.locale) await setLocale(reconciled.locale);
					if (cancelled || getAdkPath() !== adkPath) return;
					saveConfig(reconciled);
					// Run legacy value migrations after the ADK file has been merged.
					// The mount-time migration can only see the pre-hydration render cache.
					migrateSpeechStyleValues();
					// The file snapshot is authoritative after async hydration. Keep the
					// quick TTS control aligned with it, including an explicit false or
					// an omitted value (which means the default is off).
					setTtsEnabled(reconciled.ttsEnabled === true);
					// The ADK file is authoritative after hydration. In particular, this
					// clears a stale onboarding overlay that was selected from an empty or
					// older render cache during the initial mount.
					setShowOnboarding(reconciled.onboardingComplete !== true);
				}
				configHydratedRef.current = true;
				completeNaiaConfigHydration();
				setConfigHydrated(true);
				// Run legacy migration only after the complete config snapshot is
				// safely cached and the ADK write gate is open.
				await hydrateUiPreferences(uiConfig, {
					adkPath,
					canPersist: true,
				});
				if (cancelled || getAdkPath() !== adkPath) return;
				setLocaleHydrated(true);
				// Re-run the gateway-mode sync now that the file value is in cache
				// (the immediate sync on mount was gated off until this point).
				window.dispatchEvent(new CustomEvent("naia-config-changed"));
				})
				.catch((error: unknown) => {
					if (cancelled || getAdkPath() !== adkPathAtRead) return;
					// Keep the writeback gate closed when workspace hydration fails. The
				// provider/model are intentionally omitted from the log; this is a
				// seam diagnostic, not configuration telemetry.
				Logger.error("App", "workspace config hydration failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				setLocaleHydrated(true);
			});
		return () => {
			cancelled = true;
		};
	}, [showAdkSetup]);

	// Auto-allow built-in skills that are always available (no per-session approval needed).
	// Same pattern as BrowserCenterArea auto-allowing browser tools on mount.
	useEffect(() => {
		addAllowedTool("skill_app");
		addAllowedTool("skill_youtube_bgm");
	}, []);

	useEffect(() => {
		migrateLegacyDna3OllamaModel();
		migrateSpeechStyleValues();
		migrateLiveProviderToUnifiedModel();
		loadInstalledApps()
			.catch(() => {})
			.finally(() => setInstalledAppsReady(true));
		const handleAdkPathChanged = () => {
			invalidateInstalledApps();
			void loadInstalledApps().catch((error: unknown) => {
				Logger.warn("App", "Failed to reload installed apps after ADK switch", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		};
		window.addEventListener("naia-adk-path-changed", handleAdkPathChanged);

		const config = loadConfig();
		const adkPath = getAdkPath();
		// UC-ADK-PATH contract: the agent reads the ADK root from ~/.naia/adk-path
		// (Rust, set only by setAdkPath→write_naia_path_cache), while the shell saves
		// config to getAdkPath() (localStorage). These are SEPARATE sources and can
		// diverge (the agent's path file pointing at a different root than the shell's
		// saved config → the agent loads a stale config and UI model selections never
		// reach it). The branch above only re-syncs when workspaceRoot (localStorage)
		// differs from adkPath (localStorage) — it never touches the agent's file.
		// Force-resync the agent's path file to the shell's ADK on every boot so the
		// save-path and the load-path can never silently diverge.
		const bindAdk = adkPath
			? setAdkPath(adkPath).catch((error) => {
				Logger.error("App", "workspace binding failed", {
					error: String(error),
				});
				throw error;
			})
			: Promise.resolve();
		// Secure-store migration must observe the same native ADK binding as the
		// subsequent config reads. If binding fails, keep the legacy/local values
		// intact so a later startup can retry instead of clearing them.
		void bindAdk
			.then(() => migrateLabKeyToNaiaKey())
			.catch((error) => {
				Logger.error("App", "credential migration failed", {
					error: String(error),
				});
			});
		applyPersistedPresentationConfig(config, setNaiaVisible, setNaiaWidth);

		if (showAdkSetup || !configHydratedRef.current) {
			return () => {
				window.removeEventListener("naia-adk-path-changed", handleAdkPathChanged);
			};
		}

		const needsOnboarding = !isOnboardingComplete();

		if (needsOnboarding) setShowOnboarding(true);

		// ⚠️ 기동 시 마이크 권한 pre-warm 제거(2026-06-13): WebKitGTK 에서 getUserMedia({audio:true}) 가 특정
		// 오디오 장치(USB Audio IEC958)를 GStreamer 로 열 때 GstIntRange 버그로 web process 스레드를 ~90초
		// 동기 stall 시켜 *전체 기동을 90초 지연*시킨다(실측: unblock 시점에 "Audio devices enumerated" 동시 발생,
		// 모든 invoke 응답이 묶여 한꺼번에 풀림). `.then().catch()` 라도 getUserMedia 의 동기 device-open 이
		// web process 를 막는다. voice/STT(UC2)는 아직 이식 전이라 pre-warm 은 현재 가치 0. 마이크 권한은
		// 실제 voice 사용 시점(getUserMedia in mic-stream/api-stt)에 요청한다. UC2 이식 시 GstIntRange 장치
		// 회피(장치 선택/GStreamer 설정)와 함께 pre-warm 재도입 여부 재검토.
		return () => {
			window.removeEventListener("naia-adk-path-changed", handleAdkPathChanged);
		};
	}, [showAdkSetup]);

	useEffect(() => {
		// Debounced file sync: write naia-settings/config.json on every saveConfig call.
		// Covers all saveConfig callers without patching each one individually.
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		let closeUnlisten: (() => void) | null = null;
		let disposed = false;
		const closeUnlistenPromise = getCurrentWindow()
			.onCloseRequested(async (event) => {
				if (debounceTimer) {
					clearTimeout(debounceTimer);
					debounceTimer = null;
				}
				if (!configHydratedRef.current) return;
				const cfg = loadConfig();
				if (!cfg) return;
				try {
					await writeNaiaConfig({
						...(cfg as unknown as Record<string, unknown>),
						...buildNaiaConfigEnv(cfg),
					});
					setConfigSaveError(null);
				} catch (error) {
					event.preventDefault();
					setConfigSaveError(t("settings.saveFailed"));
					Logger.error("App", "workspace config save failed during close", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			})
			.then((unlisten) => {
				if (disposed) unlisten();
				else closeUnlisten = unlisten;
			})
			.catch((error: unknown) => {
				Logger.warn("App", "close-save listener unavailable", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		const syncConfigToFile = () => {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				// FR-CONFIG-SOT.2 — never write the cache back to config.json before
				// it has been hydrated from the files. Otherwise the stale pre-boot
				// localStorage (e.g. a leftover 알파 persona) overwrites the SoT.
				if (!configHydratedRef.current) return;
				const cfg = loadConfig();
				if (cfg)
					void writeNaiaConfig({
						...(cfg as unknown as Record<string, unknown>),
						...buildNaiaConfigEnv(cfg),
					}).catch((error: unknown) => {
						setConfigSaveError(t("settings.saveFailed"));
						Logger.error("App", "workspace config save failed", {
							error: error instanceof Error ? error.message : String(error),
						});
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
			// Hydration dispatches this event after config.json has replaced the
			// pre-hydration render cache. Apply presentation values again so a cold
			// start reflects the selected ADK's theme, visibility, and width.
			applyPersistedPresentationConfig(
				loadConfig(),
				setNaiaVisible,
				setNaiaWidth,
			);
			updateTitle();
			syncConfigToFile();
		};
		window.addEventListener("naia-config-changed", handleConfigChanged);
		window.addEventListener("storage", updateTitle);
		return () => {
			disposed = true;
			window.removeEventListener("naia-config-changed", handleConfigChanged);
			window.removeEventListener("storage", updateTitle);
			closeUnlisten?.();
			void closeUnlistenPromise;
			// G-10: flush pending debounced write immediately on unmount / app close.
			// Still gated on hydration (FR-CONFIG-SOT.2) — a flush before hydration
			// would persist the stale cache to config.json.
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				const cfg = loadConfig();
				if (cfg && configHydratedRef.current)
					void writeNaiaConfig({
						...(cfg as unknown as Record<string, unknown>),
						...buildNaiaConfigEnv(cfg),
					});
			}
		};
	}, []);

	useEffect(() => {
		if (showOnboarding || !configHydrated) return;
		let active = true;
		if (isOnboardingComplete()) {
			startupUpdateCheckRef.current ??= checkForUpdate();
			startupUpdateCheckRef.current
				.then((info) => {
					if (!active || !info) return;
					if (!shouldShowStartupUpdatePrompt(info.version)) return;
					setUpdateInfo(info);
					setShowUpdatePrompt(true);
				})
				.catch(() => {});
		}
		fetchUnreadAnnouncements()
			.then((list) => {
				if (active && list.length > 0) setAnnouncements(list);
			})
			.catch(() => {});
		return () => {
			active = false;
		};
	}, [configHydrated, showOnboarding]);

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

	// Ctrl+B — toggle Naia app
	const toggleNaia = useCallback(() => {
		setNaiaVisible((prev) => {
			const next = !prev;
			const config = loadConfig();
			if (config) saveConfig({ ...config, appVisible: next });
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
			// Explicit full webview reload. Ctrl+R is captured by the workspace
			// (document reload) so it never refreshes the app; Ctrl+Shift+R always
			// reloads — useful to re-launch Herdr / recover a desynced webview.
			if (
				(e.ctrlKey || e.metaKey) &&
				e.shiftKey &&
				e.key.toLowerCase() === "r"
			) {
				e.preventDefault();
				window.location.reload();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [toggleAiInterferenceEnabled, toggleNaia]);

	useEffect(() => {
		void naiaWidth;
		window.dispatchEvent(new CustomEvent("naia-width-changed"));
	}, [naiaWidth]);

	// #344: onboarding takes full screen — notify AvatarCanvas to recompute filmOffset
	// biome-ignore lint/correctness/useExhaustiveDependencies: the onboarding transition itself triggers the layout notification
	useEffect(() => {
		window.dispatchEvent(new CustomEvent("naia-width-changed"));
	}, [showOnboarding]);

	useEffect(() => {
		const unlisten = listen<AppInstallRequest>(
			"app_install_requested",
			(event) => {
				setShowAppInstall(false);
				setAppInstallRequest(event.payload);
			},
		);
		return () => {
			unlisten.then((fn) => fn());
		};
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

	// #484: accept both cold-start argv and subsequent single-instance argv.
	// Keep the path in memory until the keep-alive Workspace API has mounted;
	// never copy it into a URL, storage, or diagnostic log.
	useEffect(() => {
		const queueFile = (path: string | null | undefined) => {
			if (path) setPendingOpenFiles((queue) => [...queue, path]);
		};
		const unlisten = listen<string>("workspace-open-file-request", (event) => {
			queueFile(event.payload);
		});
		void invoke<string | null>("get_startup_open_file")
			.then(queueFile)
			.catch(() => {});
		// #543: 드래그앤드롭도 CLI 와 같은 파이프라인 — OS 실경로를 open-grant 로
		// 등록(경계 밖 read/write 동의)한 canonical 경로만 연다. 크로스플랫폼 공통.
		let dragUnlisten: Promise<() => void> = Promise.resolve(() => {});
		try {
			dragUnlisten = getCurrentWebview().onDragDropEvent((event) => {
			if (event.payload.type !== "drop") return;
			Logger.info("App", "file drag-drop received (#543)", {
				count: event.payload.paths.length,
			});
			for (const dropped of event.payload.paths) {
				void invoke<string>("workspace_register_open_file", { path: dropped })
					.then((granted) => {
						Logger.info("App", "open-grant registered (#543)", { granted });
						queueFile(granted);
					})
					.catch((error) => {
						Logger.warn("App", "open-grant register failed (#543)", {
							error: String(error),
						});
					});
			}
		});
		} catch (error) {
			Logger.warn("App", "drag-drop subscribe failed (#543)", { error: String(error) });
		}
		return () => {
			unlisten.then((fn) => fn());
			dragUnlisten.then((fn) => fn());
		};
	}, []);

	useEffect(() => {
		const next = pendingOpenFiles[0];
		if (!next || showSplash || showAdkSetup || showOnboarding) return;
		let attempts = 0;
		let retryTimer: number | undefined;
		const openWhenReady = () => {
			const workspace = appRegistry.getApi<WorkspaceAppApi>("workspace");
			if (!workspace) {
				if (++attempts < 40) retryTimer = window.setTimeout(openWhenReady, 50);
				return;
			}
			useAppStore.getState().setActiveApp("workspace");
			Logger.info("App", "opening queued file in workspace (#543)", { next });
			workspace.openFile(next);
			setPendingOpenFiles((queue) => (queue[0] === next ? queue.slice(1) : queue));
		};
		openWhenReady();
		return () => window.clearTimeout(retryTimer);
	}, [pendingOpenFiles, showAdkSetup, showOnboarding, showSplash]);

	// The persisted two-way preference controls chat placement across apps.
	const uiMode = showOnboarding
		? "onboarding"
		: showAdkSetup
			? "setup"
			: chatModeOverride;
	return (
		<AppShellFrame
			appReady={appReady}
			bootComplete={appReady && installedAppsReady}
			backgroundFallback={backgroundFallback}
			backgroundMediaType={backgroundMediaType}
			backgroundVideoUrl={backgroundVideoUrl}
			onSplashDone={onSplashDone}
			setNaiaWidth={setNaiaWidth}
			mainContent={{
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
				naiaVisible,
				naiaWidth,
				nvaModel,
				onAdkSetupComplete: () => {
					setShowSplash(true);
					setLocaleHydrated(false);
					configHydratedRef.current = false;
					setConfigHydrated(false);
					setShowAdkSetup(false);
				},
				onOnboardingComplete: () => {
					const completedConfig = loadConfig();
					if (completedConfig?.ttsEnabled !== undefined)
						setTtsEnabled(completedConfig.ttsEnabled);
					Logger.info("App", "Onboarding complete — mounting main app apps");
					setShowOnboarding(false);
				},
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
			}}
		/>
	);
}
