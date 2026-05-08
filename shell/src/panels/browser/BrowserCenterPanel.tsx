import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { addAllowedTool } from "../../lib/config";
import { useTabSkills } from "../../lib/tab-skills";
import { Logger } from "../../lib/logger";
import { panelRegistry } from "../../lib/panel-registry";
import type { PanelCenterProps } from "../../lib/panel-registry";
import { usePanelStore } from "../../stores/panel";

// ─── Panel API ───────────────────────────────────────────────────────────────

/**
 * Programmatic API exposed by the Browser panel.
 * Access via `panelRegistry.getApi<BrowserPanelApi>("browser")`.
 */
export interface BrowserPanelApi {
	/** Navigate the browser webview to a URL. */
	navigate: (url: string) => void;
	/** Switch the center panel to Browser. */
	activatePanel: () => void;
	/** Hide the browser webview. */
	hide: () => void;
	/** Show the browser webview. */
	show: () => void;
}

type PanelStatus =
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

const PERMS_KEY = "browser-tool-perms";
const TOOLBAR_COLLAPSED_KEY = "browser-toolbar-collapsed";
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

function loadPerms(): BrowserToolPerms {
	try {
		const raw = localStorage.getItem(PERMS_KEY);
		if (raw) return { ...DEFAULT_PERMS, ...JSON.parse(raw) };
	} catch {}
	return { ...DEFAULT_PERMS };
}

function savePerms(p: BrowserToolPerms) {
	try {
		localStorage.setItem(PERMS_KEY, JSON.stringify(p));
	} catch {}
}

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

export function BrowserCenterPanel({ naia }: PanelCenterProps) {
	const [status, setStatus] = useState<PanelStatus>("launching");
	const [error, setError] = useState("");
	// viewport div is always rendered so getBoundingClientRect is available
	const viewportRef = useRef<HTMLDivElement>(null);

	// ── Address bar state ─────────────────────────────────────────────────────
	const [currentUrl, setCurrentUrl] = useState("");
	const [inputUrl, setInputUrl] = useState("");
	const [inputFocused, setInputFocused] = useState(false);

	// AI tool permissions — loaded from localStorage
	const [toolPerms, setToolPerms] = useState<BrowserToolPerms>(loadPerms);
	const toolPermsRef = useRef(toolPerms);
	useEffect(() => {
		toolPermsRef.current = toolPerms;
		savePerms(toolPerms);
	}, [toolPerms]);

	// Toolbar collapsed state — persisted
	const [toolbarCollapsed, setToolbarCollapsed] = useState(
		() => localStorage.getItem(TOOLBAR_COLLAPSED_KEY) === "1",
	);
	function toggleToolbar() {
		setToolbarCollapsed((c) => {
			const next = !c;
			localStorage.setItem(TOOLBAR_COLLAPSED_KEY, next ? "1" : "0");
			return next;
		});
	}

	const allEnabled = PERM_KEYS.every((k) => toolPerms[k]);
	const someEnabled = PERM_KEYS.some((k) => toolPerms[k]);
	function toggleAll(on: boolean) {
		const next = { ...DEFAULT_PERMS };
		for (const k of PERM_KEYS) next[k] = on;
		setToolPerms(next);
	}
	function setOne(key: PermKey, on: boolean) {
		setToolPerms((p) => ({ ...p, [key]: on }));
	}

	// ── Page info ─────────────────────────────────────────────────────────────

	const refreshPageInfo = useCallback(async () => {
		try {
			const [u, t] = await invoke<[string, string]>("browser_wv_page_info");
			if (u) naia.pushContext({ type: "browser", data: { url: u, title: t } });
		} catch {
			// ignore — best-effort
		}
	}, [naia]);

	// ── Webview init ──────────────────────────────────────────────────────────

	const initWebview = useCallback(async () => {
		setStatus("launching");
		setError("");
		try {
			const el = viewportRef.current!;

			// Wait for layout to complete — keepAlive panels mount while hidden
			// (opacity:0), so getBoundingClientRect() may return zeros on the first
			// paint. Two rAF calls ensure the layout pass has fully settled.
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			);

			const rect = el.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) {
				// Panel not visible yet — wait for resize observer to trigger
				// browser_wv_resize once the panel becomes active.
				setStatus("ready");
				return;
			}
			await invoke("browser_wv_create", {
				x: rect.left,
				y: rect.top,
				width: rect.width,
				height: rect.height,
			});
			Logger.info("BrowserCenterPanel", "Browser webview created");
			setStatus("ready");
			await refreshPageInfo();
		} catch (e) {
			Logger.error("BrowserCenterPanel", "webview create failed", {
				error: String(e),
			});
			setError(String(e));
			setStatus("error");
		}
	}, [refreshPageInfo]);

	// ── URL polling (address bar sync) ───────────────────────────────────────

	useEffect(() => {
		if (status !== "ready") return;
		const id = setInterval(async () => {
			const [u] = await invoke<[string, string]>("browser_wv_page_info").catch(
				() => ["", ""] as [string, string],
			);
			if (u) {
				setCurrentUrl(u);
				setInputUrl((prev) => (inputFocused ? prev : u));
			}
		}, 600);
		return () => clearInterval(id);
	}, [status, inputFocused]);

	// ── Activate panel when login flow requests it ────────────────────────────

	useEffect(() => {
		const unlistenPromise = listen("browser_panel_activate", () => {
			usePanelStore.getState().setActivePanel("browser");
		});
		return () => {
			unlistenPromise.then((unlisten) => unlisten());
		};
	}, []);

	// ── Mount: create webview; unmount: hide it ───────────────────────────────

	useEffect(() => {
		initWebview();
		return () => {
			invoke("browser_wv_hide").catch(() => {});
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── Sync browser bounds when viewport div resizes ─────────────────────────

	useEffect(() => {
		if (status !== "ready") return;
		const el = viewportRef.current;
		if (!el) return;
		const sync = () => {
			const rect = el.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return;
			// Use create (which re-positions if already exists) so that panels
			// that were initially hidden (keepAlive + opacity:0) get created here.
			invoke("browser_wv_create", {
				x: rect.left,
				y: rect.top,
				width: rect.width,
				height: rect.height,
			}).catch(() => {});
		};
		const obs = new ResizeObserver(sync);
		obs.observe(el);
		sync();
		return () => obs.disconnect();
	}, [status]);

	// ── Re-sync bounds on panel activation ───────────────────────────────────
	// When the browser panel becomes active (opacity:0→1 via CSS), no resize
	// event fires. Explicitly re-sync so the child WebView2 gets the correct
	// bounds and YouTube/other sites render at the right viewport width.

	const activePanel = usePanelStore((s) => s.activePanel);
	useEffect(() => {
		if (activePanel !== "browser" || status !== "ready") return;
		const el = viewportRef.current;
		if (!el) return;
		// Two rAF to let the CSS opacity transition settle before measuring.
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				const rect = el.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) return;
				invoke("browser_wv_create", {
					x: rect.left,
					y: rect.top,
					width: rect.width,
					height: rect.height,
				}).catch(() => {});
			}),
		);
	}, [activePanel, status]);

	// ── Panel API (BrowserPanelApi) ───────────────────────────────────────────

	useEffect(() => {
		panelRegistry.updateApi("browser", {
			navigate: (url: string) => {
				invoke("browser_wv_navigate", { url }).catch(() => {});
			},
			activatePanel: () => usePanelStore.getState().setActivePanel("browser"),
			hide: () => invoke("browser_wv_hide").catch(() => {}),
			show: () => invoke("browser_wv_show").catch(() => {}),
		} satisfies BrowserPanelApi);
		return () => panelRegistry.updateApi("browser", undefined);
	}, []);

	// ── Tab skills (screenshot, common across all panels) ────────────────────
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
			`'${label}' 도구가 비활성화되어 있습니다. 패널 하단 AI 도구 설정에서 켜주세요.`;

		const u1 = naia.onToolCall("skill_browser_navigate", async (args) => {
			if (!p.current.navigate) return denied("탐색");
			const url = String(args.url ?? "");
			if (!url) return "Error: url required";
			Logger.info("BrowserPanel", "skill_browser_navigate invoked", { url, status });
			try {
				await invoke("browser_wv_navigate", { url });
				await refreshPageInfo();
				Logger.info("BrowserPanel", "browser_wv_navigate ok", { url });
				return `Navigated to ${url}`;
			} catch (e) {
				Logger.warn("BrowserPanel", "browser_wv_navigate failed", { url, error: String(e) });
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
				const text = await invoke<string>("browser_wv_get_text", {
					selector: ref_,
				});
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
	}, [naia, refreshPageInfo]);

	// ── Render ────────────────────────────────────────────────────────────────

	function handleNavigate(raw: string) {
		let url = raw.trim();
		if (!url) return;
		if (!url.includes("://")) url = `https://${url}`;
		invoke("browser_wv_navigate", { url }).catch(() => {});
		setCurrentUrl(url);
		setInputUrl(url);
	}

	return (
		<div className="browser-panel">
			{/* Address bar — always in HTML layer, native webview sits below */}
			<div className="browser-panel__toolbar">
				<button
					type="button"
					className="browser-panel__nav-btn"
					title="뒤로"
					onClick={() => invoke("browser_wv_back").catch(() => {})}
				>
					‹
				</button>
				<button
					type="button"
					className="browser-panel__nav-btn"
					title="앞으로"
					onClick={() => invoke("browser_wv_forward").catch(() => {})}
				>
					›
				</button>
				<button
					type="button"
					className="browser-panel__nav-btn"
					title="새로고침"
					onClick={() => invoke("browser_wv_reload").catch(() => {})}
				>
					↻
				</button>
				<form
					className="browser-panel__url-form"
					onSubmit={(e) => {
						e.preventDefault();
						handleNavigate(inputUrl);
						(e.currentTarget.querySelector("input") as HTMLInputElement)?.blur();
					}}
				>
					<input
						type="text"
						className="browser-panel__url-input"
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
			</div>

			{/* Overlays for non-ready states */}
			{status === "launching" && (
				<div className="browser-panel__overlay">
					<span className="browser-panel__overlay-text">브라우저 시작 중…</span>
				</div>
			)}
			{status === "error" && (
				<div className="browser-panel__overlay browser-panel__overlay--error">
					<p className="browser-panel__overlay-text browser-panel__overlay-text--error">
						{error}
					</p>
					<button
						type="button"
						className="browser-panel__install-btn"
						onClick={initWebview}
					>
						다시 시도
					</button>
				</div>
			)}

			{/*
			 * Transparent placeholder div — the native child webview is
			 * positioned over this area by Rust. Always rendered so that
			 * getBoundingClientRect() is available for create / resize calls.
			 */}
			<div
				ref={viewportRef}
				className="browser-panel__viewport browser-panel__viewport--embedded"
			/>

			{/* AI tool permission toolbar — stays in HTML layer below the webview */}
			{status === "ready" && (
				<div
					className={`browser-panel__ai-toolbar${toolbarCollapsed ? " browser-panel__ai-toolbar--collapsed" : ""}`}
				>
					{toolbarCollapsed ? (
						<button
							type="button"
							className="browser-panel__ai-collapse"
							title="AI 도구 설정 펼치기"
							onClick={toggleToolbar}
						>
							▲ AI
						</button>
					) : (
						<>
							<span className="browser-panel__ai-label">AI</span>

							<label
								className="browser-panel__ai-toggle"
								title="모두 허용 / 차단"
							>
								<input
									type="checkbox"
									className="browser-panel__ai-switch"
									checked={allEnabled}
									ref={(el) => {
										if (el) el.indeterminate = !allEnabled && someEnabled;
									}}
									onChange={(e) => toggleAll(e.target.checked)}
								/>
								<span className="browser-panel__ai-toggle-label">전체</span>
							</label>

							<span className="browser-panel__ai-sep" />

							{PERM_KEYS.map((key) => (
								<label
									key={key}
									className="browser-panel__ai-toggle"
									title={PERM_TITLES[key]}
								>
									<input
										type="checkbox"
										className="browser-panel__ai-switch"
										checked={toolPerms[key]}
										onChange={(e) => setOne(key, e.target.checked)}
									/>
									<span className="browser-panel__ai-toggle-label">
										{PERM_LABELS[key]}
									</span>
								</label>
							))}

							<button
								type="button"
								className="browser-panel__ai-collapse"
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
