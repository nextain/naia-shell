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
	const [workingDir, setWorkingDir] = useState(options.workspaceRoot || "");

	const mountedRef = useRef(false);
	const launchGenerationRef = useRef(0);
	const initialLaunchStartedRef = useRef(false);
	const shellCmd = options.shellCommand || detectDefaultShell();

	useEffect(() => {
		if (options.workspaceRoot) {
			setWorkingDir(options.workspaceRoot);
		}
	}, [options.workspaceRoot]);

	const launch = useCallback(async () => {
		const generation = ++launchGenerationRef.current;
		let created: PtyCreated | null = null;
		setLaunching(true);
		setLaunchError("");
		setTerminalReady(false);
		setTerminalError("");

		try {
			let dir = options.workspaceRoot || getAdkPath();
			if (!dir) {
				try {
					dir = await invoke<string>("workspace_detect_adk_root");
				} catch {
					dir = "";
				}
			}
			if (dir) setWorkingDir(dir);

			created = await invoke<PtyCreated>("pty_create", {
				dir: dir || ".",
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

			setPty(created);

			if (options.autoLaunchOpencode || options.initialCommand) {
				const cmd = options.initialCommand || "opencode";
				window.setTimeout(() => {
					if (created?.pty_id) {
						writePty(created.pty_id, `${cmd}\r`).catch(() => {});
					}
				}, 600);
			}
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
	}, [options.autoLaunchOpencode, options.initialCommand, options.workspaceRoot, shellCmd]);

	const retry = useCallback(async () => {
		const prior = pty;
		setPty(null);
		setTerminalReady(false);
		setTerminalError("");
		if (prior?.pty_id) {
			await killPty(prior.pty_id).catch(() => {});
		}
		await launch();
	}, [launch, pty]);

	const runOpencode = useCallback(async () => {
		if (!pty?.pty_id) return;
		await writePty(pty.pty_id, "opencode\r");
	}, [pty]);

	useEffect(() => {
		mountedRef.current = true;
		if (!initialLaunchStartedRef.current) {
			initialLaunchStartedRef.current = true;
			void launch();
		}
		return () => {
			mountedRef.current = false;
			if (pty?.pty_id) {
				killPty(pty.pty_id).catch(() => {});
			}
		};
	}, [launch, pty]);

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
		},
		onPtyExit: (ptyId) => {
			setPty((current) => {
				if (!ptyId || current?.pty_id === ptyId) {
					return null;
				}
				return current;
			});
			setLaunchError(t("workspace.herdrExited"));
		},
		runOpencode,
	};
}
