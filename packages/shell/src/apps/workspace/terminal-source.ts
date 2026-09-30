import type { PtyCreated } from "./useHerdrRuntime";

export type TerminalSourceKind = "pty" | "herdr";

/**
 * 터미널 백엔드 소스 인터페이스 (FR-WORKSPACE-QUAD.2).
 * 기존 Herdr 런타임(useHerdrRuntime)과 일반 PTY(pty_create)를 추상화하여
 * Herdr 유무와 무관하게 xterm 터미널을 동일하게 구동할 수 있도록 분리한다.
 */
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
