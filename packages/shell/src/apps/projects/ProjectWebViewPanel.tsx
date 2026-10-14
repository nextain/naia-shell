import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { Logger } from "../../lib/logger";
import { classifyProjectUrl } from "./project-catalog";
import { projectText } from "./translations";

export type ProjectWebViewKind = "dashboard" | "issues";
type OpenState = "idle" | "opening" | "opened" | "unavailable" | "error";

export interface ProjectWebViewPanelProps {
	adapterRoot: string;
	projectPath: string;
	view: ProjectWebViewKind;
	url: string | null;
}

function urlKey(view: ProjectWebViewKind): "dashboard_url" | "issues_url" {
	Logger.debug(
		"ProjectWebViewPanel",
		"mapping fixed project view to config key",
		{ view },
	);
	return view === "dashboard" ? "dashboard_url" : "issues_url";
}

function openErrorMessage(error: unknown): string {
	Logger.debug("ProjectWebViewPanel", "mapping project webview error code");
	const code =
		typeof error === "string"
			? error
			: error instanceof Error
				? error.message
				: "";
	if (code === "project_url_missing")
		return projectText("projects.webviewMissing");
	if (code === "project_url_invalid")
		return projectText("projects.webviewInvalid");
	if (code === "webview_unavailable")
		return projectText("projects.webviewUnavailable");
	if (code === "project_webview_origin_changed")
		return projectText("projects.webviewOriginChanged");
	return projectText("projects.webviewOpenFailed");
}

export function ProjectWebViewPanel({
	adapterRoot,
	projectPath,
	view,
	url,
}: ProjectWebViewPanelProps) {
	Logger.debug(
		"ProjectWebViewPanel",
		"rendering project-owned web view action",
		{ view },
	);
	const [openState, setOpenState] = useState<OpenState>("idle");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const urlState = classifyProjectUrl(url);
	const configKey = urlKey(view);
	const label =
		view === "dashboard"
			? projectText("projects.webviewOpenDashboard")
			: projectText("projects.webviewOpenIssues");

	async function openProjectWebView() {
		Logger.debug("ProjectWebViewPanel", "opening dedicated project webview", {
			view,
		});
		if (urlState !== "configured" || openState === "opening") {
			Logger.debug(
				"ProjectWebViewPanel",
				"webview request blocked by URL or lifecycle state",
				{
					view,
					urlState,
				},
			);
			return;
		}
		setOpenState("opening");
		setErrorMessage(null);
		try {
			const opened = await invoke<boolean>("project_webview_open", {
				adapterRoot,
				projectPath,
				view,
			});
			if (opened === true) {
				Logger.debug(
					"ProjectWebViewPanel",
					"dedicated project webview opened or reused",
					{ view },
				);
				setOpenState("opened");
			} else {
				Logger.debug(
					"ProjectWebViewPanel",
					"native webview skipped for test mode",
					{ view },
				);
				setOpenState("unavailable");
			}
		} catch (error) {
			Logger.debug(
				"ProjectWebViewPanel",
				"dedicated project webview open failed",
				{ view },
			);
			setErrorMessage(openErrorMessage(error));
			setOpenState("error");
		}
	}

	return (
		<section
			className="projects-app__webview"
			aria-label={projectText("projects.webviewSectionLabel")}
		>
			{urlState === "missing" && (
				<div className="projects-app__notice">
					<h3>{projectText("projects.webviewNotConfigured")}</h3>
					<p>{projectText("projects.webviewConfigure", { key: configKey })}</p>
				</div>
			)}
			{urlState === "invalid" && (
				<div
					className="projects-app__notice projects-app__notice--error"
					role="alert"
				>
					<h3>{projectText("projects.webviewInvalidTitle")}</h3>
					<p>
						{projectText("projects.webviewInvalidHint", { key: configKey })}
					</p>
				</div>
			)}
			{urlState === "configured" && (
				<div className="projects-app__webview-action">
					<p>{projectText("projects.webviewSeparateWindow")}</p>
					<button
						className="projects-app__primary-button"
						type="button"
						disabled={openState === "opening"}
						onClick={() => void openProjectWebView()}
					>
						{openState === "opening"
							? projectText("projects.webviewOpening")
							: label}
					</button>
				</div>
			)}
			{openState === "opened" && (
				<output className="projects-app__agent-running" aria-live="polite">
					{projectText("projects.webviewOpened")}
				</output>
			)}
			{openState === "unavailable" && (
				<output className="projects-app__recovery" aria-live="polite">
					{projectText("projects.webviewTestSkipped")}
				</output>
			)}
			{errorMessage && (
				<div className="projects-app__recovery" role="alert" aria-live="polite">
					{errorMessage}
				</div>
			)}
		</section>
	);
}
