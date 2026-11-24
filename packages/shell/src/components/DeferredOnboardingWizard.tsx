import { type ComponentType, Suspense, lazy, useMemo, useState } from "react";
import { t } from "../lib/i18n";
import { ErrorBoundary } from "./ErrorBoundary";

type OnboardingComponent = ComponentType<{ onComplete: () => void }>;
type OnboardingLoader = () => Promise<{ default: OnboardingComponent }>;

const defaultLoader: OnboardingLoader = () =>
	import("./OnboardingWizard").then((module) => ({
		default: module.OnboardingWizard,
	}));

export function DeferredOnboardingWizard({
	onComplete,
	load = defaultLoader,
}: {
	onComplete: () => void;
	load?: OnboardingLoader;
}) {
	const [attempt, setAttempt] = useState(0);
	const retry = () => {
		if (load === defaultLoader) {
			window.location.reload();
			return;
		}
		setAttempt((value) => value + 1);
	};
	const Wizard = useMemo(
		() =>
			lazy(() => {
				void attempt;
				return load();
			}),
		[load, attempt],
	);

	return (
		<ErrorBoundary
			scope="OnboardingWizard"
			resetKey={attempt}
			fallback={
				<div role="alert">
					<p>{t("chat.error")}</p>
					<button
						type="button"
						data-usage-event="deferred-onboarding-wizard.button-1.click"
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
				<Wizard onComplete={onComplete} />
			</Suspense>
		</ErrorBoundary>
	);
}
