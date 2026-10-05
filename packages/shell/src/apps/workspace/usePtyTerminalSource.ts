import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAdkPath } from "../../lib/adk-store";
import { t } from "../../lib/i18n";
import { killPty, writePty } from "./pty-ipc";
import type { TerminalSource } from "./terminal-source";
import type { PtyCreated } from "./useHerdrRuntime";

export interface PtyTerminalSourceOptions {
	workspaceRoot?: string;
	shellCommand?: string;
	autoLaunchOpencode?: boolean;
	initialCommand?: string;
	enabled?: boolean;
}

export type LaunchErrorKind = "missing-root" | "pty-create" | "pty-exit" | null;

export type PtyAction = "stop" | "invalidate" | "restart" | "launch" | "none";

export interface DecidePtyActionInput {
	enabled: boolean;
	rootIsAbsolute: boolean;
	rootChangedSinceLastEnabled: boolean;
	hasLivePty: boolean;
	launching: boolean;
	errorKind: LaunchErrorKind;
	initialLaunchStarted: boolean;
}

/**
 * PTY 세션의 생명주기 및 실행 여부를 결정하는 순수 결정 함수.
 * 결정표 순서대로 위에서부터 처음 맞는 조건을 반환한다.
 */
export function decidePtyAction(input: DecidePtyActionInput): PtyAction {
	const {
		enabled,
		rootIsAbsolute,
		rootChangedSinceLastEnabled,
		hasLivePty,
		launching,
		errorKind,
		initialLaunchStarted,
	} = input;

	if (!enabled) {
		return hasLivePty ? "stop" : "none";
	}
	if (launching && rootChangedSinceLastEnabled && rootIsAbsolute) {
		return "invalidate";
	}
	if (launching) {
		return "none";
	}
	if (hasLivePty && rootChangedSinceLastEnabled && rootIsAbsolute) {
		return "restart";
	}
	if (hasLivePty) {
		return "none";
	}
	if (errorKind !== "missing-root" && errorKind !== null) {
		return "none";
	}
	if (!initialLaunchStarted) {
		return "launch";
	}
	if (errorKind === "missing-root" && rootIsAbsolute) {
		return "launch";
	}
	if (errorKind === null && rootIsAbsolute) {
		return "launch";
	}
	return "none";
}

export function isAbsolutePath(candidate: string | null | undefined): boolean {
	if (!candidate || typeof candidate !== "string") return false;
	const trimmed = candidate.trim();
	return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(trimmed);
}

export function detectDefaultShell(): string {
	if (
		typeof navigator !== "undefined" &&
		/win/i.test(navigator.platform || navigator.userAgent)
	) {
		return "powershell";
	}
	return "bash";
}

export function usePtyTerminalSource(
	options: PtyTerminalSourceOptions = {},
): TerminalSource {
	const [pty, setPty] = useState<PtyCreated | null>(null);
	const [launching, setLaunching] = useState(false);
	const [launchError, setLaunchError] = useState("");
	const [launchErrorKind, setLaunchErrorKind] = useState<LaunchErrorKind>(null);
	const [terminalReady, setTerminalReady] = useState(false);
	const [terminalError, setTerminalError] = useState("");
	const [workingDir, setWorkingDir] = useState(
		isAbsolutePath(options.workspaceRoot) ? options.workspaceRoot!.trim() : "",
	);

	const mountedRef = useRef(false);
	const launchGenerationRef = useRef(0);
	const initialLaunchStartedRef = useRef(false);
	const currentPtyIdRef = useRef<string | null>(null);
	const currentBoundPtyRef = useRef<{
		id: string;
		generation: number;
		root: string | undefined;
	} | null>(null);
	const prevRootRef = useRef<string | undefined>(options.workspaceRoot);
	const autoCommandTimerRef = useRef<number | null>(null);
	const autoCommandSentPtyIdRef = useRef<string | null>(null);
	const currentRootRef = useRef<string | undefined>(options.workspaceRoot);
	currentRootRef.current = options.workspaceRoot;

	const isEnabled = options.enabled !== false;
	const isEnabledRef = useRef(isEnabled);
	isEnabledRef.current = isEnabled;

	const shellCmd = options.shellCommand || detectDefaultShell();

	useEffect(() => {
		currentPtyIdRef.current = pty?.pty_id ?? null;
	}, [pty]);

	const resolveAbsoluteDir = useCallback(
		async (targetRoot?: string): Promise<string> => {
			const root = targetRoot ?? currentRootRef.current;
			if (isAbsolutePath(root)) {
				return root!.trim();
			}
			const adk = getAdkPath();
			if (adk && isAbsolutePath(adk)) {
				return adk.trim();
			}
			try {
				const detected = await invoke<string>("workspace_detect_adk_root");
				if (isAbsolutePath(detected)) {
					return detected.trim();
				}
			} catch {}
			return "";
		},
		[],
	);

	const doLaunch = useCallback(
		async (targetRoot?: string) => {
			if (!isEnabledRef.current) return;
			const generation = ++launchGenerationRef.current;
			const capturedRoot = targetRoot ?? currentRootRef.current;
			let created: PtyCreated | null = null;

			if (autoCommandTimerRef.current) {
				window.clearTimeout(autoCommandTimerRef.current);
				autoCommandTimerRef.current = null;
			}

			setLaunching(true);
			setLaunchError("");
			setLaunchErrorKind(null);
			setTerminalReady(false);
			setTerminalError("");

			try {
				const dir = await resolveAbsoluteDir(capturedRoot);

				if (
					!mountedRef.current ||
					!isEnabledRef.current ||
					generation !== launchGenerationRef.current ||
					capturedRoot !== currentRootRef.current
				) {
					return;
				}

				// 절대 경로가 확보되기 전에는 pty_create를 호출하지 않는다.
				if (!dir || !isAbsolutePath(dir)) {
					setLaunchErrorKind("missing-root");
					setLaunchError("Absolute workspace directory required");
					setLaunching(false);
					return;
				}

				setWorkingDir(dir);

				if (
					!mountedRef.current ||
					!isEnabledRef.current ||
					generation !== launchGenerationRef.current ||
					capturedRoot !== currentRootRef.current
				) {
					return;
				}

				created = await invoke<PtyCreated>("pty_create", {
					dir,
					command: shellCmd,
					rows: 30,
					cols: 120,
				});

				if (
					!mountedRef.current ||
					!isEnabledRef.current ||
					generation !== launchGenerationRef.current ||
					capturedRoot !== currentRootRef.current
				) {
					if (created?.pty_id) {
						await killPty(created.pty_id).catch(() => {});
					}
					return;
				}

				currentPtyIdRef.current = created.pty_id;
				currentBoundPtyRef.current = {
					id: created.pty_id,
					generation,
					root: capturedRoot,
				};
				setPty(created);
			} catch (error) {
				if (created?.pty_id) {
					await killPty(created.pty_id).catch(() => {});
				}
				if (
					!mountedRef.current ||
					!isEnabledRef.current ||
					generation !== launchGenerationRef.current ||
					capturedRoot !== currentRootRef.current
				) {
					return;
				}
				setLaunchErrorKind("pty-create");
				setLaunchError(String(error));
			} finally {
				if (
					mountedRef.current &&
					generation === launchGenerationRef.current &&
					capturedRoot === currentRootRef.current
				) {
					setLaunching(false);
				}
			}
		},
		[resolveAbsoluteDir, shellCmd],
	);

	const launch = useCallback(async () => {
		await doLaunch(currentRootRef.current);
	}, [doLaunch]);

	const retry = useCallback(async () => {
		if (autoCommandTimerRef.current) {
			window.clearTimeout(autoCommandTimerRef.current);
			autoCommandTimerRef.current = null;
		}
		setLaunchErrorKind(null);
		setLaunchError("");

		const retryGeneration = ++launchGenerationRef.current;
		const retryRoot = currentRootRef.current;

		const priorId = currentPtyIdRef.current;
		currentPtyIdRef.current = null;
		currentBoundPtyRef.current = null;
		setPty(null);
		setTerminalReady(false);
		setTerminalError("");

		if (priorId) {
			await killPty(priorId).catch(() => {});
		}

		if (
			!mountedRef.current ||
			!isEnabledRef.current ||
			retryGeneration !== launchGenerationRef.current ||
			retryRoot !== currentRootRef.current
		) {
			return;
		}

		await doLaunch(retryRoot);
	}, [doLaunch]);

	const runOpencode = useCallback(async () => {
		const targetId = currentPtyIdRef.current;
		if (!targetId) return;
		const cmd = options.initialCommand?.trim() || "opencode";
		if (cmd.includes("\n") || cmd.includes("\r")) return;
		await writePty(targetId, `${cmd}\r`).catch(() => {});
	}, [options.initialCommand]);

	useEffect(() => {
		currentRootRef.current = options.workspaceRoot;
		isEnabledRef.current = isEnabled;

		const prevRoot = prevRootRef.current;
		const rootChangedSinceLastEnabled = prevRoot !== options.workspaceRoot;
		const rootIsAbsolute = isAbsolutePath(options.workspaceRoot);
		const hasLivePty = !!currentPtyIdRef.current;

		const action = decidePtyAction({
			enabled: isEnabled,
			rootIsAbsolute,
			rootChangedSinceLastEnabled,
			hasLivePty,
			launching,
			errorKind: launchErrorKind,
			initialLaunchStarted: initialLaunchStartedRef.current,
		});

		if (!isEnabled) {
			++launchGenerationRef.current;
			setLaunching(false);

			if (autoCommandTimerRef.current) {
				window.clearTimeout(autoCommandTimerRef.current);
				autoCommandTimerRef.current = null;
			}

			if (action === "stop") {
				const idToKill = currentPtyIdRef.current;
				currentPtyIdRef.current = null;
				currentBoundPtyRef.current = null;
				setPty(null);
				setTerminalReady(false);
				setTerminalError("");
				setLaunchErrorKind(null);
				setLaunchError("");
				if (idToKill) {
					killPty(idToKill).catch(() => {});
				}
			}
			return;
		}

		if (action === "invalidate") {
			++launchGenerationRef.current;
			setLaunching(false);
			return;
		}

		if (action === "restart") {
			++launchGenerationRef.current;
			setLaunching(false);
			if (autoCommandTimerRef.current) {
				window.clearTimeout(autoCommandTimerRef.current);
				autoCommandTimerRef.current = null;
			}
			const priorId = currentPtyIdRef.current;
			currentPtyIdRef.current = null;
			currentBoundPtyRef.current = null;
			setPty(null);
			setTerminalReady(false);
			setTerminalError("");
			setLaunchErrorKind(null);
			setLaunchError("");
			if (priorId) {
				killPty(priorId).catch(() => {});
			}
			prevRootRef.current = options.workspaceRoot;
			if (options.workspaceRoot && isAbsolutePath(options.workspaceRoot)) {
				setWorkingDir(options.workspaceRoot.trim());
			}
			void doLaunch(options.workspaceRoot);
			return;
		}

		if (action === "launch") {
			initialLaunchStartedRef.current = true;
			prevRootRef.current = options.workspaceRoot;
			if (options.workspaceRoot && isAbsolutePath(options.workspaceRoot)) {
				setWorkingDir(options.workspaceRoot.trim());
			}
			void doLaunch(options.workspaceRoot);
			return;
		}

		prevRootRef.current = options.workspaceRoot;
	}, [
		isEnabled,
		launchErrorKind,
		launching,
		options.workspaceRoot,
		doLaunch,
	]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			++launchGenerationRef.current;
			setLaunching(false);
			if (autoCommandTimerRef.current) {
				window.clearTimeout(autoCommandTimerRef.current);
				autoCommandTimerRef.current = null;
			}
			if (currentPtyIdRef.current) {
				const idToKill = currentPtyIdRef.current;
				currentPtyIdRef.current = null;
				currentBoundPtyRef.current = null;
				killPty(idToKill).catch(() => {});
			}
		};
	}, []);

	const boundPtyId = pty?.pty_id ?? null;
	const boundGeneration = currentBoundPtyRef.current?.generation ?? -1;
	const boundRoot = currentBoundPtyRef.current?.root;

	const onTerminalReady = useCallback(() => {
		if (!boundPtyId || boundGeneration < 0) return;

		if (
			!mountedRef.current ||
			!isEnabledRef.current ||
			boundGeneration !== launchGenerationRef.current ||
			boundPtyId !== currentPtyIdRef.current ||
			boundRoot !== currentRootRef.current
		) {
			return;
		}

		setTerminalReady(true);
		setTerminalError("");

		const cmd = options.initialCommand;
		if (
			autoCommandSentPtyIdRef.current !== boundPtyId &&
			cmd &&
			cmd.trim() &&
			!cmd.includes("\n") &&
			!cmd.includes("\r")
		) {
			autoCommandSentPtyIdRef.current = boundPtyId;
			if (autoCommandTimerRef.current) {
				window.clearTimeout(autoCommandTimerRef.current);
			}
			const timerGeneration = boundGeneration;
			const timerPtyId = boundPtyId;
			const timerRoot = boundRoot;

			autoCommandTimerRef.current = window.setTimeout(() => {
				if (
					mountedRef.current &&
					isEnabledRef.current &&
					timerGeneration === launchGenerationRef.current &&
					timerPtyId === currentPtyIdRef.current &&
					timerRoot === currentRootRef.current
				) {
					writePty(timerPtyId, `${cmd.trim()}\r`).catch(() => {});
				}
			}, 100);
		}
	}, [boundPtyId, boundGeneration, boundRoot, options.initialCommand]);

	const onPtyExit = useCallback((ptyId?: string) => {
		const currentId = currentPtyIdRef.current;
		if (!currentId || (ptyId && currentId !== ptyId)) {
			return;
		}

		if (autoCommandTimerRef.current) {
			window.clearTimeout(autoCommandTimerRef.current);
			autoCommandTimerRef.current = null;
		}
		currentPtyIdRef.current = null;
		currentBoundPtyRef.current = null;
		setPty(null);
		setTerminalReady(false);
		setLaunchErrorKind("pty-exit");
		setLaunchError(t("workspace.herdrExited"));
	}, []);

	return {
		kind: "pty",
		pty,
		launching,
		launchError,
		terminalReady,
		terminalError,
		workingDir,
		launch,
		retry,
		onTerminalReady,
		onPtyExit,
		runOpencode,
	};
}
