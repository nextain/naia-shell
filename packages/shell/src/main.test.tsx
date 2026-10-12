import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapShell } from "./lib/bootstrap-shell";

const startup = vi.hoisted(() => ({
	initializeI18n: vi.fn(),
	render: vi.fn(),
	afterRender: vi.fn(),
	projectImport: vi.fn(),
	logError: vi.fn(),
}));

describe("shell startup", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders after i18n when the project registration module fails to import", async () => {
		let finishI18n: (() => void) | undefined;
		startup.initializeI18n.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishI18n = resolve;
				}),
		);

		const bootstrap = bootstrapShell({
			initializeI18n: startup.initializeI18n,
			renderApp: startup.render,
			afterRender: startup.afterRender,
			registerProjectApp: () => {
				startup.projectImport();
				return import(
					"./apps/projects/__tests__/failing-registration-module.fixture"
				);
			},
			onProjectRegistrationFailure: startup.logError,
		});

		expect(startup.initializeI18n).toHaveBeenCalledTimes(1);
		expect(startup.render).not.toHaveBeenCalled();
		expect(startup.projectImport).not.toHaveBeenCalled();
		expect(startup.logError).not.toHaveBeenCalled();

		finishI18n?.();
		await bootstrap;

		expect(startup.render).toHaveBeenCalledTimes(1);
		expect(startup.afterRender).toHaveBeenCalledTimes(1);
		expect(startup.logError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "injected project registration import failure",
			}),
		);
		expect(startup.render.mock.invocationCallOrder[0]).toBeLessThan(
			startup.projectImport.mock.invocationCallOrder[0],
		);
		expect(startup.projectImport.mock.invocationCallOrder[0]).toBeLessThan(
			startup.logError.mock.invocationCallOrder[0],
		);
	});
});
