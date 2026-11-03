import { Suspense, lazy, useEffect, useRef } from "react";
import { appRegistry } from "../../lib/app-registry";

import { useAppStore } from "../../stores/app";
import { t } from "../../lib/i18n";
import { Logger } from "../../lib/logger";

const SettingsTab = lazy(() =>
	import("../../components/SettingsTab").then(({ SettingsTab }) => ({
		default: SettingsTab,
	})),
);

function SettingsCenterArea() {
	const rootRef = useRef<HTMLDivElement>(null);
	const active = useAppStore((state) => state.activeApp === "settings");
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
			<Suspense fallback={null}>
				<SettingsTab />
			</Suspense>
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
