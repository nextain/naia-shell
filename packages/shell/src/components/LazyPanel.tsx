import {
	Component,
	type ComponentType,
	type ErrorInfo,
	type LazyExoticComponent,
	type ReactNode,
	Suspense,
} from "react";
import { Logger } from "../lib/logger";

class PanelErrorBoundary extends Component<
	{ children: ReactNode; errorLabel: string; stateClassName: string },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		Logger.error("LazyPanel", "Panel failed to load or render", {
			error: error.message,
			componentStack: info.componentStack?.split("\n").slice(0, 6).join("\n"),
		});
	}

	render() {
		if (this.state.failed) {
			return (
				<div className={this.props.stateClassName} role="alert">
					{this.props.errorLabel}
				</div>
			);
		}
		return this.props.children;
	}
}

interface LazyPanelProps<Props extends object> {
	component: LazyExoticComponent<ComponentType<Props>>;
	renderComponent: (
		component: LazyExoticComponent<ComponentType<Props>>,
	) => ReactNode;
	loadingLabel: string;
	errorLabel: string;
	compact?: boolean;
}

export function LazyPanel<Props extends object>({
	component,
	renderComponent,
	loadingLabel,
	errorLabel,
	compact = false,
}: LazyPanelProps<Props>) {
	const stateClassName = `chat-panel-state${compact ? " chat-panel-state--compact" : ""}`;
	return (
		<PanelErrorBoundary errorLabel={errorLabel} stateClassName={stateClassName}>
			<Suspense
				fallback={
					<output className={stateClassName} aria-live="polite">
						{loadingLabel}
					</output>
				}
			>
				{renderComponent(component)}
			</Suspense>
		</PanelErrorBoundary>
	);
}
