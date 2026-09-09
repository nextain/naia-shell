import { invoke } from "@tauri-apps/api/core";
import { t } from "../../lib/i18n";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { emitAiInterferenceEvent } from "../../lib/ai-interference";
import {
	addBrowserBookmark,
	addBrowserShortcut,
} from "../../lib/browser-prefs";
import { addAllowedTool } from "../../lib/config";
import { Logger } from "../../lib/logger";
import { isCurrentBgmYoutubeUrl } from "../../lib/bgm-playback";
import { appRegistry } from "../../lib/app-registry";
import type { AppCenterProps } from "../../lib/app-registry";
import { useTabSkills } from "../../lib/tab-skills";
import {
	UI_PREFERENCE_KEYS,
	patchUiPreferences,
	useUiPreference,
} from "../../lib/ui-preferences";
import { useAppStore } from "../../stores/app";
import { BrowserMetaArea } from "./BrowserMetaArea";

// ─── App API ───────────────────────────────────────────────────────────────

/**
 * Programmatic API exposed by the Browser app.
 * Access via `appRegistry.getApi<BrowserAppApi>("browser")`.
 */
export interface BrowserAppApi {
	/** Navigate the browser webview to a URL. */
	navigate: (url: string) => void;
	/** Switch the center app to Browser. */
	activateApp: () => void;
	/** Hide the browser webview. */
	hide: () => void;
	/** Show the browser webview. */
	show: () => void;
}

type AppStatus =
	| "launching" // creating child webview
	| "ready" // webview visible and running
	| "error"; // fatal error

/**
 * Per-tool AI permission state.
 * Persisted to localStorage under "browser-tool-perms".
 */
interface BrowserToolPerms {
	navigate: boolean;
	back: boolean;
	forward: boolean;
	reload: boolean;
	click: boolean;
	fill: boolean;
	scroll: boolean;
	press: boolean;
	snapshot: boolean;
	getText: boolean;
	eval: boolean;
}

const DEFAULT_PERMS: BrowserToolPerms = {
	navigate: true,
	back: true,
	forward: true,
	reload: true,
	click: true,
	fill: true,
	scroll: true,
	press: true,
	snapshot: true,
	getText: true,
	eval: false, // JS eval off by default (high risk)
};

type PermKey = keyof BrowserToolPerms;

const PERM_LABELS: Record<PermKey, string> = {
	navigate: "탐색",
	back: "뒤로",
	forward: "앞으로",
	reload: "새로고침",
	click: "클릭",
	fill: "입력",
	scroll: "스크롤",
	press: "키보드",
	snapshot: "스냅샷",
	getText: "읽기",
	eval: "JS실행",
};

const PERM_TITLES: Record<PermKey, string> = {
	navigate: "URL 탐색 허용",
	back: "뒤로 가기 허용",
	forward: "앞으로 가기 허용",
	reload: "페이지 새로고침 허용",
	click: "요소 클릭 허용",
	fill: "텍스트 입력 허용",
	scroll: "페이지 스크롤 허용",
	press: "키보드 입력 허용",
	snapshot: "접근성 트리 읽기 허용",
	getText: "페이지 텍스트 읽기 허용",
	eval: "JavaScript 실행 허용 (위험)",
};

const PERM_KEYS: PermKey[] = [
	"navigate",
	"back",
	"forward",
	"reload",
	"click",
	"fill",
	"scroll",
	"press",
	"snapshot",
	"getText",
	"eval",
];

const BROWSER_TOOL_NAMES = [
	"skill_browser_navigate",
	"skill_browser_back",
	"skill_browser_forward",
	"skill_browser_reload",
	"skill_browser_click",
	"skill_browser_fill",
	"skill_browser_scroll",
	"skill_browser_press",
	"skill_browser_snapshot",
	"skill_browser_get_text",
	"skill_browser_eval",
] as const;

export const NAVIGATE_READ_DELAY_MS = 1200;
export const NAVIGATE_TEXT_TIMEOUT_MS = 3000;
export const GET_TEXT_TIMEOUT_MS = 5000;
export const NAVIGATE_TEXT_LIMIT = 6000;

export function decodeBrowserEvalString(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed === "string") return parsed;
		if (parsed === null || parsed === undefined) return "";
		return String(parsed);
	} catch {
		return raw;
	}
}

export function browserTextExcerpt(
	raw: string,
	limit = NAVIGATE_TEXT_LIMIT,
): { text: string; truncated: boolean } {
	const decoded = decodeBrowserEvalString(raw)
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (decoded.length <= limit) return { text: decoded, truncated: false };
	return { text: decoded.slice(0, limit).trimEnd(), truncated: true };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Module-level guard — persists across React StrictMode mount/unmount cycles.
let _browserWvCreating = false;
let _browserWvCreated = false;

export function BrowserCenterArea({ naia }: AppCenterProps) {
	const [status, setStatus] = useState<AppStatus>("launching");
	/**
	 * 화면이 비었을 때 **왜 비었는지** 를 말하는 한 줄.
	 *
	 * 이 앱은 HTML 이 아니라 네이티브 자식 웹뷰로 페이지를 그린다. 그래서 그
	 * 웹뷰가 없거나 이동이 실패하면 이 자리가 그냥 검게 남고, 주소창에는 사용자가
	 * 친 주소가 그대로 남아 성공한 것처럼 보인다. 실측한 탐색에서 example.com 을
	 * 열고 6초를 기다려도 화면은 검은 채였고 아무 안내도 없었다(#576). 실패를
	 * 삼키던 `.catch(() => {})` 가 그 침묵의 자리였다.
	 *
	 * 전면 덮개로 만들지 않는다 — 브라우저 앱의 오류 덮개가 그 뒤 화면의 클릭을
	 * 먹은 사고가 있었다(92-browser-app-clicks). 뷰포트 안에 pointer-events 없이
	 * 얹는다.
	 */
	const [surfaceNotice, setSurfaceNotice] = useState("");
	const [error, setError] = useState("");
	// viewport div is always rendered so getBoundingClientRect is available
	const viewportRef = useRef<HTMLDivElement>(null);

	// ── Address bar state ─────────────────────────────────────────────────────
	const [currentUrl, setCurrentUrl] = useState("");
	const [currentTitle, setCurrentTitle] = useState("");
	const [inputUrl, setInputUrl] = useState("");
	const [inputFocused, setInputFocused] = useState(false);
	const [bookmarksOpen, setBookmarksOpen] = useState(false);
	const lastAiEventUrlRef = useRef("");

	// AI tool permissions — the helper reads legacy localStorage only until the
	// selected ADK has hydrated its ui-config.json.
	const persistedToolPerms = useUiPreference<BrowserToolPerms>(
		UI_PREFERENCE_KEYS.browserToolPerms,
		DEFAULT_PERMS,
	);
	const [toolPerms, setToolPerms] =
		useState<BrowserToolPerms>(persistedToolPerms);
	const toolPermsRef = useRef(toolPerms);
	useEffect(() => {
		toolPermsRef.current = toolPerms;
	}, [toolPerms]);
	useEffect(() => {
		setToolPerms(persistedToolPerms);
	}, [persistedToolPerms]);

	// Toolbar collapsed state — persisted
	const persistedToolbarCollapsed = useUiPreference<boolean>(
		UI_PREFERENCE_KEYS.browserToolbarCollapsed,
		false,
	);
	const [toolbarCollapsed, setToolbarCollapsed] = useState(
		persistedToolbarCollapsed,
	);
	useEffect(() => {
		setToolbarCollapsed(persistedToolbarCollapsed);
	}, [persistedToolbarCollapsed]);
	function toggleToolbar() {
		setToolbarCollapsed((c) => {
			const next = !c;
			void patchUiPreferences({
				[UI_PREFERENCE_KEYS.browserToolbarCollapsed]: next,
			});
			return next;
		});
	}

	const allEnabled = PERM_KEYS.every((k) => toolPerms[k]);
	const someEnabled = PERM_KEYS.some((k) => toolPerms[k]);
	function toggleAll(on: boolean) {
		const next = { ...DEFAULT_PERMS };
		for (const k of PERM_KEYS) next[k] = on;
		setToolPerms(next);
		void patchUiPreferences({
			[UI_PREFERENCE_KEYS.browserToolPerms]: next,
		});
	}
	function setOne(key: PermKey, on: boolean) {
		setToolPerms((p) => {
			const next = { ...p, [key]: on };
			void patchUiPreferences({
				[UI_PREFERENCE_KEYS.browserToolPerms]: next,
			});
			return next;
		});
	}

	// ── Page info ─────────────────────────────────────────────────────────────

	const refreshPageInfo = useCallback(async () => {
		try {
			const [u, t] = await invoke<[string, string]>("browser_wv_page_info");
			if (u) {
				setCurrentUrl(u);
				setCurrentTitle(t);
				naia.pushContext({ type: "browser", data: { url: u, title: t } });
			}
		} catch {
			// ignore — best-effort
		}
	}, [naia]);

	const syncBrowserBounds = useCallback(() => {
		if (useAppStore.getState().activeApp !== "browser") return;
		if (!_browserWvCreated) return;
		const el = viewportRef.current;
		if (!el) return;
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				const rect = el.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) return;
				invoke("browser_wv_resize", {
					x: rect.left,
					y: rect.top,
					width: rect.width,
					height: rect.height,
				}).catch(() => {});
			}),
		);
	}, []);

	// ── Webview init ──────────────────────────────────────────────────────────

	const showBrowserWebview = useCallback(async () => {
		syncBrowserBounds();
		await invoke("browser_wv_show");
	}, [syncBrowserBounds]);

	const initWebview = useCallback(async () => {
		if (_browserWvCreating) return;
		if (_browserWvCreated) {
			setStatus("ready");
			if (useAppStore.getState().activeApp === "browser") {
				showBrowserWebview().catch(() => {});
			}
			return;
		}
		_browserWvCreating = true;
		setStatus("launching");
		setError("");
		try {
			const el = viewportRef.current;
			if (!el) {
				_browserWvCreating = false;
				return;
			}

			// Wait for layout to complete — keepAlive apps mount while hidden
			// (opacity:0), so getBoundingClientRect() may return zeros on the first
			// paint. Two rAF calls ensure the layout pass has fully settled.
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			);

			const rect = el.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				_browserWvCreating = false;
				setStatus("ready");
				return;
			}
			// 이 명령은 **웹뷰가 실제로 생겼는지** 를 돌려준다. 자동 테스트처럼
			// 자식 웹뷰를 띄우지 않는 실행에서는 성공이면서 `false` 다. 예전에는
			// 그 구별이 없어 화면이 "준비됨" 인 채로 비어 있었다.
			const created = await invoke<boolean>("browser_wv_create", {
				x: rect.left,
				y: rect.top,
				width: rect.width,
				height: rect.height,
			});
			// 다시 부르지 않게 표시는 남긴다 — 없는 것을 계속 만들려 하면 매 앱
			// 전환마다 헛일을 한다.
			setSurfaceNotice(created === false ? t("browser.noSurface") : "");
			_browserWvCreated = true;
			_browserWvCreating = false;
			// Immediately hide if browser is not the active app on startup.
			if (useAppStore.getState().activeApp !== "browser") {
				invoke("browser_wv_hide").catch(() => {});
			}
			Logger.info("BrowserCenterArea", "Browser webview created");
			setStatus("ready");
			await refreshPageInfo();
			syncBrowserBounds();
		} catch (e) {
			_browserWvCreating = false;
			_browserWvCreated = false;
			Logger.error("BrowserCenterArea", "webview create failed", {
				error: String(e),
			});
			setError(String(e));
			setStatus("error");
		}
	}, [refreshPageInfo, showBrowserWebview, syncBrowserBounds]);

	// ── URL polling (address bar sync) ───────────────────────────────────────

	useEffect(() => {
		if (status !== "ready") return;
		const id = setInterval(async () => {
			const info = await invoke<[string, string]>(
				"browser_wv_page_info",
			).catch(() => ["", ""] as [string, string]);
			// #509 — non-tuple resolve(IPC mock 등)도 폴백: 구조분해가 catch 밖에서 터지지 않게
			const [u, t] = Array.isArray(info) ? info : ["", ""];
			if (u) {
				setCurrentUrl(u);
				setCurrentTitle(t);
				setInputUrl((prev) => (inputFocused ? prev : u));
				if (lastAiEventUrlRef.current !== u) {
					lastAiEventUrlRef.current = u;
					emitAiInterferenceEvent({
						source: "browser",
						action: "navigated",
						title: t,
						url: u,
					});
				}
			}
		}, 600);
		return () => clearInterval(id);
	}, [status, inputFocused]);

	// ── Activate app when login flow requests it ────────────────────────────

	useEffect(() => {
		const unlistenPromise = listen("browser_app_activate", () => {
			useAppStore.getState().setActiveApp("browser");
		});
		return () => {
			unlistenPromise.then((unlisten) => unlisten());
		};
	}, []);

	// ── Mount: create webview; unmount: hide it ───────────────────────────────

	useEffect(() => {
		const t = setTimeout(() => initWebview(), 80);
		return () => {
			clearTimeout(t);
			invoke("browser_wv_hide").catch(() => {});
		};
	}, [initWebview]);

	// ── Sync browser bounds when viewport div resizes ─────────────────────────

	useEffect(() => {
		if (status !== "ready") return;
		const el = viewportRef.current;
		if (!el) return;
		const obs = new ResizeObserver(syncBrowserBounds);
		obs.observe(el);
		syncBrowserBounds();
		return () => obs.disconnect();
	}, [status, syncBrowserBounds]);

	useEffect(() => {
		if (status !== "ready") return;
		let lastDpr = window.devicePixelRatio;
		const sync = () => syncBrowserBounds();
		const dprPoll = window.setInterval(() => {
			if (window.devicePixelRatio === lastDpr) return;
			lastDpr = window.devicePixelRatio;
			syncBrowserBounds();
		}, 1000);
		window.addEventListener("resize", sync);
		window.visualViewport?.addEventListener("resize", sync);
		window.visualViewport?.addEventListener("scroll", sync);
		window.addEventListener("naia-width-changed", sync);
		return () => {
			window.clearInterval(dprPoll);
			window.removeEventListener("resize", sync);
			window.visualViewport?.removeEventListener("resize", sync);
			window.visualViewport?.removeEventListener("scroll", sync);
			window.removeEventListener("naia-width-changed", sync);
		};
	}, [status, syncBrowserBounds]);

	// ── Re-sync bounds on app activation ───────────────────────────────────
	// When the browser app becomes active (opacity:0→1 via CSS), no resize
	// event fires. Explicitly re-sync so the child WebView2 gets the correct
	// bounds and YouTube/other sites render at the right viewport width.

	const activeApp = useAppStore((s) => s.activeApp);
	const modalCount = useAppStore((s) => s.modalCount);
	useEffect(() => {
		if (status !== "ready") return;
		if (activeApp !== "browser" || modalCount > 0) {
			invoke("browser_wv_hide").catch(() => {});
			return;
		}
		if (!_browserWvCreated) {
			initWebview();
			return;
		}
		showBrowserWebview().catch(() => {});
	}, [activeApp, initWebview, modalCount, showBrowserWebview, status]);

	// ── Sync bounds on OS-level window resize (Win snap / maximize) ──────────

	useEffect(() => {
		if (status !== "ready") return;
		let unlisten: (() => void) | undefined;
		listen("tauri://window-resized", () => syncBrowserBounds()).then((fn) => {
			unlisten = fn;
		});
		return () => {
			unlisten?.();
		};
	}, [status, syncBrowserBounds]);

	// ── Visibility sync event (from app/chat store) ─────────────────────────

	useEffect(() => {
		if (status !== "ready") return;
		const sync = () => {
			const { activeApp, modalCount } = useAppStore.getState();
			if (activeApp !== "browser" || modalCount > 0) {
				invoke("browser_wv_hide").catch(() => {});
				return;
			}
			if (!_browserWvCreated) {
				initWebview();
				return;
			}
			showBrowserWebview().catch(() => {});
		};
		window.addEventListener("naia-browser-visibility-sync", sync);
		return () =>
			window.removeEventListener("naia-browser-visibility-sync", sync);
	}, [initWebview, showBrowserWebview, status]);

	// ── App API (BrowserAppApi) ───────────────────────────────────────────

	useEffect(() => {
		appRegistry.updateApi("browser", {
			navigate: (url: string) => {
				invoke("browser_wv_navigate", { url }).catch(() => {});
			},
			activateApp: () => useAppStore.getState().setActiveApp("browser"),
			hide: () => invoke("browser_wv_hide").catch(() => {}),
			show: () => invoke("browser_wv_show").catch(() => {}),
		} satisfies BrowserAppApi);
		return () => appRegistry.updateApi("browser", undefined);
	}, []);

	// ── Tab skills (screenshot, common across all apps) ────────────────────
	// viewportRef covers the native WebView2 area — captures that screen region.
	useTabSkills(viewportRef, naia);

	// ── Auto-allow browser tools (bypass PermissionModal) ────────────────────

	useEffect(() => {
		for (const name of BROWSER_TOOL_NAMES) {
			addAllowedTool(name);
		}
	}, []);

	// ── AI tool handlers ──────────────────────────────────────────────────────

	useEffect(() => {
		const p = toolPermsRef;
		const denied = (label: string) =>
			`'${label}' 도구가 비활성화되어 있습니다. 앱 하단 AI 도구 설정에서 켜주세요.`;

		const readPageTextAfterNavigate = async () => {
			await sleep(NAVIGATE_READ_DELAY_MS);
			await refreshPageInfo();
			const raw = await invoke<string>("browser_wv_get_text", {
				selector: "",
				timeout_ms: NAVIGATE_TEXT_TIMEOUT_MS,
			});
			return browserTextExcerpt(raw);
		};

		const u1 = naia.onToolCall("skill_browser_navigate", async (args) => {
			if (!p.current.navigate) return denied("탐색");
			const url = String(args.url ?? "");
			if (!url) return "Error: url required";
			if (isCurrentBgmYoutubeUrl(url)) {
				Logger.warn("BrowserArea", "blocked browser fallback for internal BGM", {
					url,
				});
				return (
					"Blocked: this YouTube video belongs to Naia's internal BGM request. " +
					"Do not use browser navigation as a music fallback; check skill_youtube_bgm status instead."
				);
			}
			Logger.info("BrowserArea", "skill_browser_navigate invoked", {
				url,
				status,
			});
			try {
				await invoke("browser_wv_navigate", { url });
				if (!p.current.getText) {
					await refreshPageInfo();
					Logger.info("BrowserArea", "browser_wv_navigate ok", { url });
					return `Navigated to ${url}\nPage text not read: ${denied("읽기")}`;
				}
				Logger.info("BrowserArea", "browser_wv_navigate ok", { url });
				let readResult: { text: string; truncated: boolean };
				try {
					readResult = await readPageTextAfterNavigate();
				} catch (readError) {
					Logger.warn(
						"BrowserArea",
						"browser_wv_get_text after navigate failed",
						{
							url,
							error: String(readError),
						},
					);
					return `Navigated to ${url}\nPage text read failed: ${String(readError)}\nThe page may still be loading. Call skill_browser_get_text before answering if content is needed.`;
				}
				const { text, truncated } = readResult;
				if (!text) {
					return `Navigated to ${url}\nPage text: (empty)\nIf the page is still loading, call skill_browser_get_text before answering.`;
				}
				const suffix = truncated
					? `first ${NAVIGATE_TEXT_LIMIT} chars, truncated`
					: "visible body";
				return `Navigated to ${url}\nPage text (${suffix}):\n${text}`;
			} catch (e) {
				Logger.warn("BrowserArea", "browser_wv_navigate failed", {
					url,
					error: String(e),
				});
				return `Navigation failed: ${String(e)}`;
			}
		});

		const u2 = naia.onToolCall("skill_browser_back", async () => {
			if (!p.current.back) return denied("뒤로");
			try {
				await invoke("browser_wv_back");
				await refreshPageInfo();
				return "Navigated back";
			} catch (e) {
				return `Back failed: ${String(e)}`;
			}
		});

		const u3 = naia.onToolCall("skill_browser_forward", async () => {
			if (!p.current.forward) return denied("앞으로");
			try {
				await invoke("browser_wv_forward");
				await refreshPageInfo();
				return "Navigated forward";
			} catch (e) {
				return `Forward failed: ${String(e)}`;
			}
		});

		const u4 = naia.onToolCall("skill_browser_reload", async () => {
			if (!p.current.reload) return denied("새로고침");
			try {
				await invoke("browser_wv_reload");
				await refreshPageInfo();
				return "Page reloaded";
			} catch (e) {
				return `Reload failed: ${String(e)}`;
			}
		});

		const u5 = naia.onToolCall("skill_browser_snapshot", async () => {
			if (!p.current.snapshot) return denied("스냅샷");
			try {
				const tree = await invoke<string>("browser_wv_snapshot");
				await refreshPageInfo();
				return tree || "(empty snapshot)";
			} catch (e) {
				return `Snapshot failed: ${String(e)}`;
			}
		});

		const u6 = naia.onToolCall("skill_browser_click", async (args) => {
			if (!p.current.click) return denied("클릭");
			const ref_ = String(args.ref ?? args.selector ?? "");
			if (!ref_) return "Error: ref required (use @eN from snapshot)";
			try {
				await invoke("browser_wv_click", { selector: ref_ });
				await refreshPageInfo();
				return `Clicked ${ref_}`;
			} catch (e) {
				return `Click failed: ${String(e)}`;
			}
		});

		const u7 = naia.onToolCall("skill_browser_fill", async (args) => {
			if (!p.current.fill) return denied("입력");
			const ref_ = String(args.ref ?? args.selector ?? "");
			const text = String(args.text ?? "");
			if (!ref_) return "Error: ref required (use @eN from snapshot)";
			try {
				await invoke("browser_wv_fill", { selector: ref_, text });
				return `Filled ${ref_} with "${text}"`;
			} catch (e) {
				return `Fill failed: ${String(e)}`;
			}
		});

		const u8 = naia.onToolCall("skill_browser_get_text", async (args) => {
			if (!p.current.getText) return denied("읽기");
			const ref_ = String(args.ref ?? args.selector ?? "");
			try {
				const raw = await invoke<string>("browser_wv_get_text", {
					selector: ref_,
					timeout_ms: GET_TEXT_TIMEOUT_MS,
				});
				const text = decodeBrowserEvalString(raw).trim();
				return text || "(empty)";
			} catch (e) {
				return `Get text failed: ${String(e)}`;
			}
		});

		const u9 = naia.onToolCall("skill_browser_scroll", async (args) => {
			if (!p.current.scroll) return denied("스크롤");
			const dir = String(args.direction ?? args.dir ?? "down");
			const px = Number(args.pixels ?? args.px ?? 300);
			try {
				await invoke("browser_wv_scroll", { direction: dir, pixels: px });
				return `Scrolled ${dir} ${px}px`;
			} catch (e) {
				return `Scroll failed: ${String(e)}`;
			}
		});

		const u10 = naia.onToolCall("skill_browser_press", async (args) => {
			if (!p.current.press) return denied("키보드");
			const key = String(args.key ?? "");
			if (!key) return "Error: key required (e.g. Enter, Tab, Control+a)";
			try {
				await invoke("browser_wv_press", { key });
				return `Pressed ${key}`;
			} catch (e) {
				return `Press failed: ${String(e)}`;
			}
		});

		const u12 = naia.onToolCall("skill_browser_eval", async (args) => {
			if (!p.current.eval) return denied("JS실행");
			const js = String(args.js ?? args.script ?? "");
			if (!js) return "Error: js argument required";
			try {
				const result = await invoke<string>("browser_wv_eval", { js });
				return result ?? "null";
			} catch (e) {
				return `Eval failed: ${String(e)}`;
			}
		});

		return () => {
			u1();
			u2();
			u3();
			u4();
			u5();
			u6();
			u7();
			u8();
			u9();
			u10();
			u12();
		};
	}, [naia, refreshPageInfo, status]);

	// ── Render ────────────────────────────────────────────────────────────────

	function handleNavigate(raw: string) {
		let url = raw.trim();
		if (!url) return;
		if (!url.includes("://")) url = `https://${url}`;
		invoke("browser_wv_navigate", { url })
			.then(() => setSurfaceNotice(""))
			.catch((error) => {
				// 삼키지 않는다. 삼키면 주소창만 바뀌고 화면은 검은 채로 남아,
				// 사용자는 자기가 무엇을 잘못했는지조차 알 수 없다.
				Logger.warn("BrowserCenterArea", "navigate failed", {
					url,
					error: String(error),
				});
				setSurfaceNotice(
					t("browser.navigateFailed", { url, error: String(error) }),
				);
			});
		setCurrentUrl(url);
		setInputUrl(url);
	}

	function pageTitle(): string {
		return currentTitle.trim() || currentUrl.trim() || inputUrl.trim();
	}

	function currentPageUrl(): string {
		return (currentUrl || inputUrl).trim();
	}

	async function readPageMetadata(): Promise<{
		title: string;
		url: string;
		iconUrl?: string;
	}> {
		const fallbackUrl = currentPageUrl();
		const fallbackTitle = pageTitle();
		let fallbackIconUrl: string | undefined;
		try {
			const u = new URL(fallbackUrl || "about:blank");
			if (u.protocol === "https:" || u.protocol === "http:") {
				fallbackIconUrl = `${u.origin}/favicon.ico`;
			}
		} catch {}
		try {
			const raw = await invoke<string>("browser_wv_eval", {
				js: `
const pick = (...selectors) => {
	for (const selector of selectors) {
		const el = document.querySelector(selector);
		const value = el?.content || el?.href;
		if (value) return new URL(value, location.href).href;
	}
	return "";
};
return {
	title: document.querySelector("meta[property='og:title']")?.content || document.title || location.href,
	url: document.querySelector("meta[property='og:url']")?.content || location.href,
	iconUrl: pick(
		"link[rel~='icon'][sizes~='192x192']",
		"link[rel~='icon'][sizes~='180x180']",
		"link[rel='apple-touch-icon']",
		"link[rel~='icon'][type='image/svg+xml']",
		"link[rel~='icon']",
		"link[rel='shortcut icon']",
		"meta[property='og:image']",
		"meta[name='twitter:image']"
	)
};`,
			});
			const meta = JSON.parse(raw) as {
				title?: string;
				url?: string;
				iconUrl?: string;
			};
			return {
				title: meta.title?.trim() || fallbackTitle,
				url: meta.url?.trim() || fallbackUrl,
				iconUrl: meta.iconUrl?.trim() || fallbackIconUrl,
			};
		} catch (err) {
			Logger.warn("BrowserCenterArea", "page metadata read failed", {
				error: String(err),
			});
			return {
				title: fallbackTitle,
				url: fallbackUrl,
				iconUrl: fallbackIconUrl,
			};
		}
	}

	async function handleAddBookmark() {
		const url = currentPageUrl();
		if (!url) return;
		try {
			await addBrowserBookmark(pageTitle(), url);
			setBookmarksOpen(true);
			Logger.info("BrowserCenterArea", "bookmark added", {
				url,
				title: pageTitle(),
			});
		} catch (err) {
			Logger.warn("BrowserCenterArea", "bookmark save failed", {
				url,
				error: String(err),
			});
		}
	}

	async function handleAddShortcut() {
		const url = currentPageUrl();
		if (!url) return;
		const meta = await readPageMetadata();
		try {
			await addBrowserShortcut(meta.title, meta.url, meta.iconUrl);
			Logger.info("BrowserCenterArea", "shortcut added", {
				url: meta.url,
				title: meta.title,
			});
		} catch (err) {
			Logger.warn("BrowserCenterArea", "shortcut save failed", {
				url,
				error: String(err),
			});
		}
	}

	function toggleBookmarkList() {
		setBookmarksOpen((open) => !open);
	}

	useEffect(() => {
		if (status !== "ready") return;
		if (bookmarksOpen) {
			Logger.debug("BrowserCenterArea", "bookmark drawer opened");
		}
		syncBrowserBounds();
	}, [bookmarksOpen, status, syncBrowserBounds]);

	return (
		<div className="browser-app">
			{/* Address bar — always in HTML layer, native webview sits below */}
			<div className="browser-app__toolbar">
				<button
					type="button"
					className="browser-app__nav-btn"
					title="뒤로"
					onClick={() => invoke("browser_wv_back").catch(() => {})}
				>
					‹
				</button>
				<button
					type="button"
					className="browser-app__nav-btn"
					title="앞으로"
					onClick={() => invoke("browser_wv_forward").catch(() => {})}
				>
					›
				</button>
				<button
					type="button"
					className="browser-app__nav-btn"
					title="새로고침"
					onClick={() => invoke("browser_wv_reload").catch(() => {})}
				>
					↻
				</button>
				<form
					className="browser-app__url-form"
					onSubmit={(e) => {
						e.preventDefault();
						handleNavigate(inputUrl);
						(
							e.currentTarget.querySelector("input") as HTMLInputElement
						)?.blur();
					}}
				>
					<input
						type="text"
						className="browser-app__url-input"
						value={inputFocused ? inputUrl : currentUrl}
						placeholder="주소 입력…"
						onFocus={() => {
							setInputFocused(true);
							setInputUrl(currentUrl);
						}}
						onBlur={() => setInputFocused(false)}
						onChange={(e) => setInputUrl(e.target.value)}
					/>
				</form>
				<button
					type="button"
					className="browser-app__nav-btn"
					title="바로가기 추가"
					onClick={handleAddShortcut}
				>
					↗
				</button>
				<button
					type="button"
					className="browser-app__nav-btn"
					title="북마크 추가"
					onClick={handleAddBookmark}
				>
					★
				</button>
				<button
					type="button"
					className={`browser-app__nav-btn${bookmarksOpen ? " browser-app__nav-btn--active" : ""}`}
					title="북마크 리스트"
					onClick={toggleBookmarkList}
				>
					≡
				</button>
			</div>

			{/* Overlays for non-ready states */}
			{status === "launching" && (
				<div className="browser-app__overlay">
					<span className="browser-app__overlay-text">브라우저 시작 중…</span>
				</div>
			)}
			{status === "error" && (
				<div className="browser-app__overlay browser-app__overlay--error">
					<p className="browser-app__overlay-text browser-app__overlay-text--error">
						{error}
					</p>
					<button
						type="button"
						className="browser-app__install-btn"
						onClick={initWebview}
					>
						{t("common.retry")}
					</button>
				</div>
			)}

			<div className="browser-app__body">
				{/*
				 * Transparent placeholder div — the native child webview is
				 * positioned over this area by Rust. Always rendered so that
				 * getBoundingClientRect() is available for create / resize calls.
				 */}
				<div
					ref={viewportRef}
					className="browser-app__viewport browser-app__viewport--embedded"
				>
					{surfaceNotice && (
						<div
							className="browser-app__viewport-notice"
							data-testid="browser-surface-notice"
						>
							{surfaceNotice}
						</div>
					)}
				</div>

				{bookmarksOpen && (
					<div className="browser-app__bookmark-drawer">
						<BrowserMetaArea
							onNavigate={(url) => {
								handleNavigate(url);
								setBookmarksOpen(false);
							}}
						/>
					</div>
				)}
			</div>

			{/* AI tool permission toolbar — stays in HTML layer below the webview */}
			{status === "ready" && (
				<div
					className={`browser-app__ai-toolbar${toolbarCollapsed ? " browser-app__ai-toolbar--collapsed" : ""}`}
				>
					{toolbarCollapsed ? (
						<button
							type="button"
							className="browser-app__ai-collapse"
							title="AI 도구 설정 펼치기"
							onClick={toggleToolbar}
						>
							▲ AI
						</button>
					) : (
						<>
							<span className="browser-app__ai-label">AI</span>

							<label
								className="browser-app__ai-toggle"
								title="모두 허용 / 차단"
							>
								<input
									type="checkbox"
									className="browser-app__ai-switch"
									checked={allEnabled}
									ref={(el) => {
										if (el) el.indeterminate = !allEnabled && someEnabled;
									}}
									onChange={(e) => toggleAll(e.target.checked)}
								/>
								<span className="browser-app__ai-toggle-label">전체</span>
							</label>

							<span className="browser-app__ai-sep" />

							{PERM_KEYS.map((key) => (
								<label
									key={key}
									className="browser-app__ai-toggle"
									title={PERM_TITLES[key]}
								>
									<input
										type="checkbox"
										className="browser-app__ai-switch"
										checked={toolPerms[key]}
										onChange={(e) => setOne(key, e.target.checked)}
									/>
									<span className="browser-app__ai-toggle-label">
										{PERM_LABELS[key]}
									</span>
								</label>
							))}

							<button
								type="button"
								className="browser-app__ai-collapse"
								title="AI 도구 설정 접기"
								onClick={toggleToolbar}
							>
								▼
							</button>
						</>
					)}
				</div>
			)}
		</div>
	);
}
