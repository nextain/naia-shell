import { Component, type ErrorInfo, type ReactNode } from "react";
import { Logger } from "../lib/logger";

interface ErrorBoundaryProps {
	/** Identifier for logging — e.g. "Panel(workspace)" or "ChatArea". */
	scope: string;
	children: ReactNode;
	/** Optional custom fallback UI. Default: empty `<div>` so siblings keep mounting. */
	fallback?: ReactNode;
}

interface ErrorBoundaryState {
	error: Error | null;
}

/**
 * Isolates a subtree from React tree-wide unmount when one component throws.
 *
 * Without this, a render error inside any keepAlive panel (e.g. SettingsTab
 * doing `.length` on an undefined IPC result, or SkillLauncher's `.filter`
 * on undefined) propagates up to <App> and unmounts every panel — including
 * the Chat panel the user is currently looking at.
 */
export class ErrorBoundary extends Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		Logger.error("ErrorBoundary", `${this.props.scope} crashed`, {
			error: error.message,
			stack: error.stack?.split("\n").slice(0, 8).join("\n"),
			componentStack: info.componentStack?.split("\n").slice(0, 6).join("\n"),
		});
	}

	render(): ReactNode {
		if (this.state.error) {
			return this.props.fallback ?? <div data-error-scope={this.props.scope} />;
		}
		return this.props.children;
	}
}
