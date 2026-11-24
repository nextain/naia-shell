import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { appRegistry } from "../../lib/app-registry";
import { getLocale, t } from "../../lib/i18n";
import { Logger } from "../../lib/logger";
import { isNarrowPortraitScreen } from "../../lib/web-runtime/web-assets";
import { useAppStore } from "../../stores/app";

type SettingsComponent = typeof import("../../components/SettingsTab")["SettingsTab"];
let settingsModulePromise: Promise<{ default: SettingsComponent }> | null = null;

function loadSettingsTabModule(): Promise<{ default: SettingsComponent }> {
	settingsModulePromise ??= import("../../components/SettingsTab")
		.then(({ SettingsTab }) => ({ default: SettingsTab }))
		.catch((error) => {
			settingsModulePromise = null;
			throw error;
		});
	return settingsModulePromise;
}

if (typeof window !== "undefined") {
	// 좁은 세로 화면(모바일 웹·모바일 앱 공통)에서는 메뉴에서 설정을 열었을 때 빈 화면으로 멈추지 않도록 유휴 시점에 청크를 미리 받아 둔다.
	const schedulePreload = () => {
		if (!isNarrowPortraitScreen()) return;
		const idle = (
			window as Window & {
				requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
			}
		).requestIdleCallback;
		if (typeof idle === "function") {
			idle(() => void loadSettingsTabModule().catch(() => {}), { timeout: 3000 });
		} else {
			window.setTimeout(() => void loadSettingsTabModule().catch(() => {}), 1500);
		}
	};
	if (document.readyState === "complete") {
		schedulePreload();
	} else {
		window.addEventListener("load", schedulePreload, { once: true });
	}
}

function SettingsCenterArea() {
	const rootRef = useRef<HTMLDivElement>(null);
	const active = useAppStore((state) => state.activeApp === "settings");
	const [attempt, setAttempt] = useState(0);
	const SettingsTab = useMemo(
		() =>
			lazy(() => {
				void attempt;
				return loadSettingsTabModule();
			}),
		[attempt],
	);
	useEffect(() => {
		if (!active) return;
		const root = rootRef.current!;
		const controls = () =>
			Array.from(
				root.querySelectorAll<HTMLElement>(
					"button, input, select, textarea, a[href], [tabindex]",
				),
			).filter(
				(el) =>
					!el.matches(':disabled, [tabindex="-1"]') &&
					!el.closest("[inert]") &&
					el.getClientRects().length > 0 &&
					getComputedStyle(el).visibility !== "hidden",
			);
		const focusFirst = () => (controls()[0] ?? root).focus();
		focusFirst();
		// SettingsTab is lazy: move from the loading region to its first control.
		const observer = new MutationObserver(() => {
			if (document.activeElement === root) focusFirst();
		});
		observer.observe(root, { childList: true, subtree: true });
		Logger.debug("SettingsCenterArea", "keyboard scope opened");
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			if (event.key === "Escape") {
				event.preventDefault();
				useAppStore.getState().setActiveApp(null);
				document.querySelector<HTMLElement>(".app-bar-settings")?.focus();
				Logger.debug("SettingsCenterArea", "keyboard scope closed");
			} else if (event.key === "Tab") {
				const items = controls();
				const index = items.indexOf(document.activeElement as HTMLElement);
				const next =
					index < 0
						? event.shiftKey
							? items.length - 1
							: 0
						: (index + (event.shiftKey ? -1 : 1) + items.length) % items.length;
				event.preventDefault();
				(items[next] ?? root).focus();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => {
			observer.disconnect();
			document.removeEventListener("keydown", onKey);
		};
	}, [active]);
	return (
		<div
			ref={rootRef}
			tabIndex={-1}
			role="dialog"
			aria-label={t("settings.title")}
			aria-modal="true"
			style={{
				height: "100%",
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
			}}
		>
			<ErrorBoundary
				scope="SettingsCenterArea"
				resetKey={attempt}
				fallback={
					<div
						role="alert"
						style={{
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							justifyContent: "center",
							gap: 12,
							height: "100%",
							padding: 24,
							color: "#e2e8f0",
							textAlign: "center",
						}}
					>
						<p style={{ margin: 0 }}>
							{getLocale() === "ko"
								? "설정 화면을 불러오지 못했습니다."
								: "Could not load settings."}
						</p>
						<button
							type="button"
							className="settings-icon-btn"
							onClick={() => {
								settingsModulePromise = null;
								setAttempt((prev) => prev + 1);
							}}
						>
							{t("common.retry")}
						</button>
					</div>
				}
			>
				<Suspense
					fallback={
						<output
							aria-live="polite"
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								height: "100%",
								padding: 24,
								color: "#cbd5e1",
								fontSize: 14,
							}}
						>
							{t("progress.loading")}
						</output>
					}
				>
					<SettingsTab />
				</Suspense>
			</ErrorBoundary>
		</div>
	);
}

appRegistry.register({
	id: "settings",
	name: "설정",
	names: { ko: "설정", en: "Settings" },
	icon: "⚙️",
	builtIn: true,
	keepAlive: true, // SettingsTab must stay mounted during browser-app login to keep naia_auth_complete listener alive
	deferMountUntilActive: true,
	center: SettingsCenterArea,
});
