// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../../lib/i18n";
import { ProjectAgentPanel } from "../ProjectAgentPanel";
import { PROJECT_APP_TRANSLATIONS } from "../translations";

const runtime = vi.hoisted(() => ({
	state: {
		selectedAppId: "claude",
		availability: { claude: true, codex: true, muse: true, opencode: true },
		status: "error",
		output: "",
		error: { code: "agent_unavailable" },
		inputError: { code: "input_failed" },
		exitCode: null,
		ptyId: null,
	},
}));

vi.mock("../project-agent-runtime", () => ({
	PROJECT_AGENT_APPS: ["claude", "codex", "muse", "opencode"],
	getProjectAgentState: vi.fn(() => runtime.state),
	subscribeProjectAgent: vi.fn(
		(_projectPath: string, listener: (state: typeof runtime.state) => void) => {
			listener(runtime.state);
			return vi.fn();
		},
	),
	loadProjectAgentAvailability: vi.fn(async () => {}),
	preselectProjectAgentIfUnset: vi.fn(),
	selectProjectAgent: vi.fn(),
	startProjectAgent: vi.fn(async () => {}),
	stopProjectAgent: vi.fn(async () => {}),
	attachProjectAgent: vi.fn(async () => {}),
}));

vi.mock("../ProjectAgentTerminal", () => ({
	ProjectAgentTerminal: ({
		inputFailed,
		label,
	}: {
		inputFailed: boolean;
		label: string;
	}) => (
		<section aria-label={label}>
			{inputFailed && (
				<output role="alert">
					{PROJECT_APP_TRANSLATIONS.en["projects.agentInputFailed"]}
				</output>
			)}
		</section>
	),
}));

describe("ProjectAgentPanel error notices", () => {
	beforeEach(async () => {
		await setLocale("en");
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("shows the start failure and input delivery banner together", async () => {
		render(
			<ProjectAgentPanel
				projectPath="/fixture/project"
				adapterRoot="/fixture/adapter"
			/>,
		);

		expect(
			await screen.findByRole("heading", {
				name: PROJECT_APP_TRANSLATIONS.en["projects.agentErrorTitle"],
			}),
		).toBeTruthy();
		expect(
			screen.getByText(
				PROJECT_APP_TRANSLATIONS.en["projects.agentUnavailableHint"],
			),
		).toBeTruthy();
		expect(
			screen.getByText(
				PROJECT_APP_TRANSLATIONS.en["projects.agentInputFailed"],
			),
		).toBeTruthy();
		expect(screen.getAllByRole("alert")).toHaveLength(2);
	});
});
