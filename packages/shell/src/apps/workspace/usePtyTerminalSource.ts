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
	const [terminalReady, setTerminalReady] = useState(false);
	const [terminalError, setTerminalError] = useState("");
	const [workingDir, setWorkingDir] = useState(
		isAbsolutePath(options.workspaceRoot) ? options.workspaceRoot!.trim() : "",
	);

	const mountedRef = useRef(false);
	const launchGenerationRef = useRef(0);
	const initialLaunchStartedRef = useRef(false);
	const currentPtyIdRef = useRef<string | null>(null);
	const prevRootRef = useRef<string | undefined>(options.workspaceRoot);
	const autoCommandTimerRef = useRef<number | null>(null);
	const autoCommandSentPtyIdRef = useRef<string | null>(null);

	const isEnabled = options.enabled !== false;
	const shellCmd = options.shellCommand || detectDefaultShell();

	useEffect(() => {
		currentPtyIdRef.current = pty?.pty_id ?? null;
	}, [pty]);

	const resolveAbsoluteDir = useCallback(async (): Promise<string> => {
		if (isAbsolutePath(options.workspaceRoot)) {
			return options.workspaceRoot!.trim();
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
	}, [options.workspaceRoot]);

	const launch = useCallback(async () => {
		if (!isEnabled) return;
		const generation = ++launchGenerationRef.current;
		let created: PtyCreated | null = null;

		if (autoCommandTimerRef.current) {
			window.clearTimeout(autoCommandTimerRef.current);
			autoCommandTimerRef.current = null;
		}

		setLaunching(true);
		setLaunchError("");
		setTerminalReady(false);
		setTerminalError("");

		try {
			const dir = await resolveAbsoluteDir();
			// 절대 경로가 확보되기 전에는 pty_create를 호출하지 않는다.
			if (!dir || !isAbsolutePath(dir)) {
				if (mountedRef.current && generation === launchGenerationRef.current) {
					setLaunchError("Absolute workspace directory required");
					setLaunching(false);
				}
				return;
			}

			setWorkingDir(dir);

			created = await invoke<PtyCreated>("pty_create", {
				dir,
				command: shellCmd,
				rows: 30,
				cols: 120,
			});

			if (!mountedRef.current || generation !== launchGenerationRef.current) {
				if (created?.pty_id) {
					await killPty(created.pty_id).catch(() => {});
				}
				return;
			}

			currentPtyIdRef.current = created.pty_id;
			setPty(created);
		} catch (error) {
			if (created?.pty_id) {
				await killPty(created.pty_id).catch(() => {});
			}
			if (!mountedRef.current || generation !== launchGenerationRef.current) {
				return;
			}
			setLaunchError(String(error));
		} finally {
			if (mountedRef.current && generation === launchGenerationRef.current) {
				setLaunching(false);
			}
		}
	}, [isEnabled, resolveAbsoluteDir, shellCmd]);

	const retry = useCallback(async () => {
		if (autoCommandTimerRef.current) {
			window.clearTimeout(autoCommandTimerRef.current);
			autoCommandTimerRef.current = null;
		}
		const priorId = currentPtyIdRef.current;
		currentPtyIdRef.current = null;
		setPty(null);
		setTerminalReady(false);
		setTerminalError("");
		if (priorId) {
			await killPty(priorId).catch(() => {});
		}
		await launch();
	}, [launch]);

	const runOpencode = useCallback(async () => {
		const targetId = currentPtyIdRef.current;
		if (!targetId) return;
		const cmd = options.initialCommand?.trim() || "opencode";
		if (cmd.includes("\n") || cmd.includes("\r")) return;
		await writePty(targetId, `${cmd}\r`).catch(() => {});
	}, [options.initialCommand]);

	// enabled 상태 변경 및 작업 디렉터리 변경 반응
	useEffect(() => {
		const prevRoot = prevRootRef.current;
		prevRootRef.current = options.workspaceRoot;

		if (!isEnabled) {
			if (autoCommandTimerRef.current) {
				window.clearTimeout(autoCommandTimerRef.current);
				autoCommandTimerRef.current = null;
			}
			if (currentPtyIdRef.current) {
				const idToKill = currentPtyIdRef.current;
				currentPtyIdRef.current = null;
				setPty(null);
				setTerminalReady(false);
				killPty(idToKill).catch(() => {});
			}
			return;
		}

		if (options.workspaceRoot && isAbsolutePath(options.workspaceRoot)) {
			setWorkingDir(options.workspaceRoot.trim());
			if (
				prevRoot !== undefined &&
				prevRoot !== options.workspaceRoot
			) {
				const priorId = currentPtyIdRef.current;
				currentPtyIdRef.current = null;
				setPty(null);
				setTerminalReady(false);
				if (priorId) {
					killPty(priorId).catch(() => {});
				}
				void launch();
				return;
			}
		}

		if (!initialLaunchStartedRef.current && isEnabled) {
			initialLaunchStartedRef.current = true;
			void launch();
		} else if (
			isEnabled &&
			!currentPtyIdRef.current &&
			!launching &&
			!launchError &&
			isAbsolutePath(options.workspaceRoot)
		) {
			void launch();
		}
	}, [isEnabled, launch, launchError, launching, options.workspaceRoot]);

	// 언마운트 시에만 최신 pty_id 종료
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (autoCommandTimerRef.current) {
				window.clearTimeout(autoCommandTimerRef.current);
				autoCommandTimerRef.current = null;
			}
			if (currentPtyIdRef.current) {
				const idToKill = currentPtyIdRef.current;
				currentPtyIdRef.current = null;
				killPty(idToKill).catch(() => {});
			}
		};
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
		onTerminalReady: () => {
			setTerminalReady(true);
			setTerminalError("");

			const currentId = currentPtyIdRef.current;
			const cmd = options.initialCommand;
			if (
				currentId &&
				autoCommandSentPtyIdRef.current !== currentId &&
				cmd &&
				cmd.trim() &&
				!cmd.includes("\n") &&
				!cmd.includes("\r")
			) {
				autoCommandSentPtyIdRef.current = currentId;
				if (autoCommandTimerRef.current) {
					window.clearTimeout(autoCommandTimerRef.current);
				}
				autoCommandTimerRef.current = window.setTimeout(() => {
					if (currentPtyIdRef.current === currentId) {
						writePty(currentId, `${cmd.trim()}\r`).catch(() => {});
					}
				}, 100);
			}
		},
		onPtyExit: (ptyId) => {
			if (autoCommandTimerRef.current) {
				window.clearTimeout(autoCommandTimerRef.current);
				autoCommandTimerRef.current = null;
			}
			setPty((current) => {
				if (!ptyId || current?.pty_id === ptyId) {
					currentPtyIdRef.current = null;
					return null;
				}
				return current;
			});
			setLaunchError(t("workspace.herdrExited"));
		},
		runOpencode,
	};
}
