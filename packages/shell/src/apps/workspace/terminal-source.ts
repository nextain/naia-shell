import type { PtyCreated } from "./useHerdrRuntime";

export type TerminalSourceKind = "pty" | "herdr";

export interface TerminalSource {
	kind: TerminalSourceKind;
	pty: PtyCreated | null;
	launching: boolean;
	launchError: string;
	terminalReady: boolean;
	terminalError: string;
	workingDir: string;
	launch: () => Promise<void>;
	retry: () => Promise<void>;
	onTerminalReady: () => void;
	onPtyExit: (ptyId?: string) => void;
	runOpencode?: () => Promise<void>;
}
