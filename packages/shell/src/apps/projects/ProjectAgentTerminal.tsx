import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { Logger } from "../../lib/logger";
import {
	type ProjectAgentAppId,
	resizeProjectAgent,
	writeProjectAgent,
} from "./project-agent-runtime";
import "@xterm/xterm/css/xterm.css";

export interface ProjectAgentTerminalProps {
	projectPath: string;
	appId: ProjectAgentAppId;
	output: string;
	label: string;
	running: boolean;
}

export function ProjectAgentTerminal({
	projectPath,
	appId,
	output,
	label,
	running,
}: ProjectAgentTerminalProps) {
	Logger.debug("ProjectAgentTerminal", "rendering project-owned terminal", {
		appId,
	});
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<XTerminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const lastOutputRef = useRef("");
	const outputRef = useRef(output);
	outputRef.current = output;

	useEffect(() => {
		Logger.debug("ProjectAgentTerminal", "creating xterm for project agent", {
			appId,
		});
		const container = containerRef.current;
		if (!container) {
			Logger.debug(
				"ProjectAgentTerminal",
				"terminal mount skipped without a host element",
			);
			return;
		}
		const terminal = new XTerminal({
			allowProposedApi: false,
			convertEol: false,
			cursorBlink: true,
			fontFamily: '"Cascadia Code", "Fira Code", monospace',
			fontSize: 13,
			scrollback: 5000,
			theme: {
				background: "#08111f",
				foreground: "#e5edf7",
				cursor: "#8db8ff",
			},
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(container);
		terminalRef.current = terminal;
		fitRef.current = fit;
		lastOutputRef.current = "";
		if (outputRef.current) {
			terminal.write(outputRef.current);
			lastOutputRef.current = outputRef.current;
		}
		const sendSize = () => {
			Logger.debug(
				"ProjectAgentTerminal",
				"fitting project terminal to visible area",
				{ appId },
			);
			try {
				fit.fit();
				void resizeProjectAgent(
					projectPath,
					appId,
					terminal.rows,
					terminal.cols,
				);
			} catch {
				Logger.debug(
					"ProjectAgentTerminal",
					"terminal fit skipped while container is hidden",
					{ appId },
				);
			}
		};
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(() => sendSize());
		observer?.observe(container);
		const frame = requestAnimationFrame(sendSize);
		const input = terminal.onData((data) => {
			Logger.debug("ProjectAgentTerminal", "forwarding terminal input", {
				appId,
			});
			void writeProjectAgent(projectPath, appId, data);
		});
		return () => {
			Logger.debug("ProjectAgentTerminal", "disposing project-owned terminal", {
				appId,
			});
			cancelAnimationFrame(frame);
			observer?.disconnect();
			input.dispose();
			terminal.dispose();
			terminalRef.current = null;
			fitRef.current = null;
		};
	}, [appId, projectPath]);

	useEffect(() => {
		Logger.debug("ProjectAgentTerminal", "applying buffered project output", {
			appId,
		});
		const terminal = terminalRef.current;
		if (!terminal) {
			Logger.debug(
				"ProjectAgentTerminal",
				"output buffered until terminal mount",
			);
			return;
		}
		const previous = lastOutputRef.current;
		if (output.startsWith(previous)) {
			const delta = output.slice(previous.length);
			if (delta) terminal.write(delta);
		} else {
			terminal.reset();
			terminal.write(output);
		}
		lastOutputRef.current = output;
		if (fitRef.current) {
			try {
				fitRef.current.fit();
			} catch {
				Logger.debug(
					"ProjectAgentTerminal",
					"terminal refit deferred after output update",
					{ appId },
				);
			}
		}
	}, [appId, output]);

	useEffect(() => {
		Logger.debug(
			"ProjectAgentTerminal",
			"synchronizing native PTY size after lifecycle change",
			{ appId, running },
		);
		if (!running) return;
		const terminal = terminalRef.current;
		const fit = fitRef.current;
		if (!terminal || !fit) {
			Logger.debug(
				"ProjectAgentTerminal",
				"PTY size sync deferred until terminal mount",
				{ appId },
			);
			return;
		}
		try {
			fit.fit();
			void resizeProjectAgent(projectPath, appId, terminal.rows, terminal.cols);
		} catch {
			Logger.debug(
				"ProjectAgentTerminal",
				"PTY size sync skipped for hidden terminal",
				{ appId },
			);
		}
	}, [appId, projectPath, running]);

	return (
		<div
			className="projects-app__terminal"
			ref={containerRef}
			role="region"
			aria-label={label}
			data-project-terminal="true"
		/>
	);
}
