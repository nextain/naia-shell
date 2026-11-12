import { type ComponentType, Suspense, lazy, useMemo, useState } from "react";
import { t } from "../lib/i18n";
import { ErrorBoundary } from "./ErrorBoundary";

type SetupComponent = ComponentType<{ onComplete: () => void }>;
type SetupLoader = () => Promise<{ default: SetupComponent }>;

const defaultLoader: SetupLoader = () =>
	import("./AdkSetupScreen").then((module) => ({
		default: module.AdkSetupScreen,
	}));

export function DeferredAdkSetupScreen({
	onComplete,
	load = defaultLoader,
}: {
	onComplete: () => void;
	load?: SetupLoader;
}) {
	const [attempt, setAttempt] = useState(0);
	const retry = () => {
		if (load === defaultLoader) {
			window.location.reload();
			return;
		}
		setAttempt((value) => value + 1);
	};
	const Setup = useMemo(
		() =>
			lazy(() => {
				void attempt;
				return load();
			}),
		[load, attempt],
	);

	return (
		<ErrorBoundary
			scope="AdkSetupScreen"
			resetKey={attempt}
			fallback={
				<div role="alert">
					<p>{t("chat.error")}</p>
					<button
						type="button"
						data-usage-event="deferred-adk-setup-screen.button-1.click"
						onClick={retry}
					>
						{t("common.retry")}
					</button>
				</div>
			}
		>
			<Suspense
				fallback={<output aria-live="polite">{t("progress.loading")}</output>}
			>
				<Setup onComplete={onComplete} />
			</Suspense>
		</ErrorBoundary>
	);
}
