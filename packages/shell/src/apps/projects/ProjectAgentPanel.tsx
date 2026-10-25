import { Suspense, lazy, useEffect, useState } from "react";
import { Logger } from "../../lib/logger";
import {
	PROJECT_AGENT_APPS,
	type ProjectAgentAppId,
	type ProjectAgentError,
	type ProjectAgentState,
	attachProjectAgent,
	getProjectAgentState,
	loadProjectAgentAvailability,
	preselectProjectAgentIfUnset,
	selectProjectAgent,
	startProjectAgent,
	stopProjectAgent,
	subscribeProjectAgent,
} from "./project-agent-runtime";
import { projectText } from "./translations";

const ProjectAgentTerminal = lazy(() =>
	import("./ProjectAgentTerminal").then((module) => ({
		default: module.ProjectAgentTerminal,
	})),
);

export interface ProjectAgentPanelProps {
	projectPath: string;
	adapterRoot: string;
	codingApp?: string | null;
	resetting?: boolean;
}

const APP_LABELS: Record<ProjectAgentAppId, string> = {
	claude: "Claude",
	codex: "Codex",
	muse: "Muse",
	opencode: "OpenCode",
};

function translateAgentError(error: ProjectAgentError): string {
	Logger.debug("ProjectAgentPanel", "translating fixed agent error", {
		code: error.code,
	});
	switch (error.code) {
		case "checkout_missing":
			return projectText("projects.agentCheckoutMissing", {
				path:
					error.expectedPath ?? projectText("projects.agentExpectedCheckout"),
			});
		case "repository_invalid":
			return projectText("projects.agentRepositoryInvalid");
		case "checkout_unsafe":
			return projectText("projects.agentCheckoutUnsafe");
		case "project_unverified":
			return projectText("projects.agentProjectUnverified");
		case "agent_unavailable":
			return projectText("projects.agentUnavailableHint");
		case "agent_invalid":
			return projectText("projects.agentInvalid");
		case "session_mismatch":
			return projectText("projects.agentSessionMismatch");
		case "session_missing":
			return projectText("projects.agentSessionMissing");
		case "class_reset_in_progress":
			return projectText("projects.agentClassResetInProgress");
		case "input_failed":
			return projectText("projects.agentInputFailed");
		case "unknown":
			return projectText("projects.agentUnknownError");
	}
}

function appLabel(appId: ProjectAgentAppId): string {
	Logger.debug("ProjectAgentPanel", "resolving fixed coding app label", {
		appId,
	});
	return APP_LABELS[appId];
}

export function ProjectAgentPanel({
	projectPath,
	adapterRoot,
	codingApp,
	resetting = false,
}: ProjectAgentPanelProps) {
	Logger.debug("ProjectAgentPanel", "rendering coding agent controls");
	const [state, setState] = useState<ProjectAgentState>(() => {
		if (codingApp) preselectProjectAgentIfUnset(projectPath, codingApp);
		return getProjectAgentState(projectPath);
	});
	const [availabilityFailed, setAvailabilityFailed] = useState(false);
	const [startPending, setStartPending] = useState(false);
	const [stopPending, setStopPending] = useState(false);

	useEffect(() => {
		Logger.debug(
			"ProjectAgentPanel",
			"subscribing to selected project runtime",
		);
		let active = true;
		if (codingApp) preselectProjectAgentIfUnset(projectPath, codingApp);
		const unsubscribe = subscribeProjectAgent(projectPath, (nextState) => {
			if (active) setState(nextState);
		});
		void loadProjectAgentAvailability().catch(() => {
			if (active) {
				Logger.debug("ProjectAgentPanel", "availability check failed");
				setAvailabilityFailed(true);
			}
		});
		const current = getProjectAgentState(projectPath);
		if (
			current.selectedAppId &&
			current.ptyId &&
			current.status === "running"
		) {
			Logger.debug(
				"ProjectAgentPanel",
				"reattaching previously selected in-memory session",
				{
					appId: current.selectedAppId,
				},
			);
			void attachProjectAgent(projectPath, adapterRoot, current.selectedAppId);
		}
		return () => {
			Logger.debug(
				"ProjectAgentPanel",
				"leaving selected project runtime view",
			);
			active = false;
			unsubscribe();
		};
	}, [adapterRoot, codingApp, projectPath]);

	const selectedAppId = state.selectedAppId;
	const selectedAvailable = selectedAppId
		? state.availability[selectedAppId]
		: false;
	const hasUnavailableApp = PROJECT_AGENT_APPS.some(
		(appId) => state.availability[appId] === false,
	);
	if (hasUnavailableApp) {
		Logger.debug(
			"ProjectAgentPanel",
			"showing installation guidance for unavailable coding apps",
		);
	}
	const isStarting =
		startPending ||
		state.status === "starting" ||
		state.status === "connecting";
	const isRunning = state.status === "running" || state.status === "stopping";

	async function handleStart() {
		Logger.debug(
			"ProjectAgentPanel",
			"starting explicitly selected coding app",
			{
				appId: selectedAppId,
			},
		);
		if (
			!selectedAppId ||
			selectedAvailable !== true ||
			isStarting ||
			isRunning ||
			resetting
		) {
			Logger.debug(
				"ProjectAgentPanel",
				"start action ignored by current UI state",
			);
			return;
		}
		setStartPending(true);
		try {
			await startProjectAgent(projectPath, adapterRoot, selectedAppId);
		} finally {
			setStartPending(false);
		}
	}

	async function handleStop() {
		Logger.debug("ProjectAgentPanel", "requesting selected project PTY stop", {
			appId: selectedAppId,
		});
		if (!selectedAppId || !isRunning || state.status === "stopping") return;
		setStopPending(true);
		try {
			await stopProjectAgent(projectPath, adapterRoot, selectedAppId);
		} finally {
			setStopPending(false);
		}
	}

	function selectApp(appId: ProjectAgentAppId) {
		Logger.debug("ProjectAgentPanel", "user selected a fixed coding app", {
			appId,
		});
		selectProjectAgent(projectPath, appId);
	}

	return (
		<section
			className="projects-app__agent"
			aria-label={projectText("projects.agentChoicesLabel")}
		>
			<p className="projects-app__hint">
				{projectText("projects.agentCheckoutHint")}
			</p>
			<fieldset
				className="projects-app__agent-options"
				disabled={isStarting || isRunning || resetting}
			>
				<legend>{projectText("projects.agentChoicesLabel")}</legend>
				{PROJECT_AGENT_APPS.map((appId) => {
					const available = state.availability[appId];
					const unavailable = available === false;
					const selected = selectedAppId === appId;
					return (
						<label
							className={`projects-app__agent-option${
								selected ? " projects-app__agent-option--selected" : ""
							}`}
							key={appId}
						>
							<input
								type="radio"
								name="project-coding-agent"
								value={appId}
								checked={selected}
								disabled={
									unavailable || available === null || availabilityFailed
								}
								onChange={() => selectApp(appId)}
							/>
							<span>{appLabel(appId)}</span>
							{unavailable && (
								<small>{projectText("projects.agentNotInstalled")}</small>
							)}
							{available === null && !availabilityFailed && (
								<small>{projectText("projects.agentChecking")}</small>
							)}
						</label>
					);
				})}
			</fieldset>
			{hasUnavailableApp && (
				<p className="projects-app__hint">
					{projectText("projects.agentInstallHint")}
				</p>
			)}
			{availabilityFailed && (
				<output className="projects-app__recovery" aria-live="polite">
					{projectText("projects.agentAvailabilityFailed")}
				</output>
			)}
			{selectedAppId && selectedAvailable === true && !isRunning && (
				<button
					className="projects-app__primary-button"
					type="button"
					disabled={isStarting || resetting}
					onClick={() => void handleStart()}
				>
					{isStarting
						? projectText("projects.agentStarting")
						: projectText("projects.agentStart", {
								app: appLabel(selectedAppId),
							})}
				</button>
			)}
			{isRunning && selectedAppId && (
				<button
					className="projects-app__secondary-button"
					type="button"
					disabled={state.status === "stopping" || stopPending}
					onClick={() => void handleStop()}
				>
					{state.status === "stopping" || stopPending
						? projectText("projects.agentStopping")
						: projectText("projects.agentStop", {
								app: appLabel(selectedAppId),
							})}
				</button>
			)}
			{state.status === "connecting" && (
				<output className="projects-app__recovery" aria-live="polite">
					{projectText("projects.agentReattaching")}
				</output>
			)}
			{state.status === "starting" && (
				<output className="projects-app__recovery" aria-live="polite">
					{projectText("projects.agentStarting")}
				</output>
			)}
			{state.status === "running" && selectedAppId && (
				<output className="projects-app__agent-running" aria-live="polite">
					{projectText("projects.agentRunning", {
						app: appLabel(selectedAppId),
					})}
				</output>
			)}
			{state.status === "running" &&
				selectedAppId === "opencode" &&
				state.naiaLoginRequired && (
					<output
						className="projects-app__recovery"
						role="status"
						aria-live="polite"
					>
						<strong>{projectText("projects.agentNaiaLoginRequired")}</strong>{" "}
						{projectText("projects.agentNaiaLoginHint")}
					</output>
				)}
			{state.status === "stopping" && selectedAppId && (
				<output className="projects-app__recovery" aria-live="polite">
					{projectText("projects.agentStopping")}
				</output>
			)}
			{state.status === "exited" && (
				<output className="projects-app__recovery" aria-live="polite">
					{projectText("projects.agentExited", {
						code: state.exitCode ?? projectText("projects.agentUnknownExit"),
					})}
				</output>
			)}
			{state.error && (
				<section
					className="projects-app__notice projects-app__notice--error"
					role="alert"
				>
					<h3>{projectText("projects.agentErrorTitle")}</h3>
					<p>{translateAgentError(state.error)}</p>
					{state.error.code === "checkout_missing" &&
						state.error.expectedPath && (
							<p>
								{projectText("projects.agentExpectedCheckoutLabel")}{" "}
								<code>{state.error.expectedPath}</code>
							</p>
						)}
					{[
						"checkout_missing",
						"repository_invalid",
						"checkout_unsafe",
						"project_unverified",
					].includes(state.error.code) && (
						<p>{projectText("projects.agentRecoveryHint")}</p>
					)}
				</section>
			)}
			{selectedAppId && selectedAvailable === true && (
				<Suspense
					fallback={
						<output className="projects-app__recovery" aria-live="polite">
							{projectText("projects.panelLoading")}
						</output>
					}
				>
					<ProjectAgentTerminal
						projectPath={projectPath}
						adapterRoot={adapterRoot}
						appId={selectedAppId}
						output={state.output}
						inputFailed={state.inputError !== null}
						running={state.status === "running"}
						label={projectText("projects.agentTerminalLabel", {
							app: appLabel(selectedAppId),
						})}
					/>
				</Suspense>
			)}
		</section>
	);
}
