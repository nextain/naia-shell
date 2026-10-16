// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../lib/i18n";
import { ProjectAgentTerminal } from "../ProjectAgentTerminal";

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		rows = 24;
		cols = 80;
		loadAddon() {}
		open() {}
		onData() {
			return { dispose() {} };
		}
		write() {}
		reset() {}
		dispose() {}
	},
}));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit() {}
		dispose() {}
	},
}));
vi.mock("../project-agent-runtime", () => ({
	resizeProjectAgent: vi.fn(async () => {}),
	writeProjectAgent: vi.fn(async () => {}),
}));

describe("ProjectAgentTerminal input status", () => {
	beforeEach(() => {
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it.each([
		[
			"en",
			"Terminal input was not delivered. Start a new session to retry.",
		],
		[
			"ko",
			"터미널 입력을 전달하지 못했습니다. 새 세션을 시작해 다시 시도하세요.",
		],
	] as const)("shows the %s input delivery status", async (locale, message) => {
		await setLocale(locale);
		render(
			<ProjectAgentTerminal
				projectPath="/fixture/project"
				adapterRoot="/fixture/adapter"
				appId="claude"
				output=""
				inputFailed
				running={false}
				label="Claude terminal"
			/>,
		);

		expect(screen.getByRole("alert")).toHaveTextContent(message);
		expect(screen.getByRole("region", { name: "Claude terminal" })).toBeTruthy();
	});
});
