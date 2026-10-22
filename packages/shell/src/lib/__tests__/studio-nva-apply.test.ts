// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StudioNvaApplyHost from "../../components/StudioNvaApplyHost";
import {
	hasPendingStudioNvaTarget,
	runStudioNvaApplyFlow,
} from "../studio-nva-apply";
import {
	type StudioNvaApplyRequest,
	isStudioNvaApplyRequest,
} from "../studio-nva-apply-request";

const tauriMocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	listen: vi.fn(),
	listener: null as ((event: { payload: unknown }) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => tauriMocks.invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: (
		event: string,
		handler: (event: { payload: unknown }) => void,
	) => {
		tauriMocks.listen(event, handler);
		tauriMocks.listener = handler;
		return Promise.resolve(() => {
			if (tauriMocks.listener === handler) {
				tauriMocks.listener = null;
			}
		});
	},
}));

vi.mock("../../components/StudioNvaApplyDialog", () => ({
	StudioNvaApplyDialog: ({
		request,
		onClose,
	}: {
		request: StudioNvaApplyRequest;
		onClose: () => void;
	}) =>
		createElement(
			"div",
			{ "data-testid": "studio-nva-apply-dialog" },
			createElement(
				"span",
				null,
				`${request.requestId}:${request.avatarId}:${request.environment}`,
			),
			createElement(
				"button",
				{ type: "button", onClick: onClose },
				"close-dialog",
			),
		),
}));

afterEach(() => {
	cleanup();
	tauriMocks.invoke.mockReset();
	tauriMocks.listen.mockReset();
	tauriMocks.listener = null;
});

function makeFlow(confirmed: boolean, inspectManifest: () => void = () => {}) {
	const steps: string[] = [];
	return {
		steps,
		flow: {
			confirmed,
			download: vi.fn(async () => {
				steps.push("download");
				return {
					path: "/cache/naia-studio-avatar.nva",
					manifestJson: "{}",
					sha256: "abc",
				};
			}),
			inspectManifest: vi.fn((manifestJson: string) => {
				steps.push("inspect");
				expect(manifestJson).toBe("{}");
				inspectManifest();
			}),
			importAsset: vi.fn(async () => {
				steps.push("import");
				return "/adk/naia-settings/nva-files/루나";
			}),
			applyModel: vi.fn(async (modelName: string) => {
				steps.push(`apply:${modelName}`);
			}),
			cleanup: vi.fn(async () => {
				steps.push("cleanup");
			}),
		},
	};
}

describe("Studio NVA apply flow", () => {
	it("waits for confirmation before downloading, then inspects before import and apply", async () => {
		const { flow, steps } = makeFlow(true);
		await expect(runStudioNvaApplyFlow(flow)).resolves.toEqual({
			status: "applied",
			modelName: "루나",
		});
		expect(steps).toEqual([
			"download",
			"inspect",
			"import",
			"apply:루나",
			"cleanup",
		]);
	});

	it("does not download or apply until the user confirms", async () => {
		const { flow, steps } = makeFlow(false);
		await expect(runStudioNvaApplyFlow(flow)).resolves.toEqual({
			status: "cancelled",
		});
		expect(steps).toEqual([]);
		expect(flow.download).not.toHaveBeenCalled();
	});

	it("does not import or apply when manifest inspection fails", async () => {
		const { flow, steps } = makeFlow(true, () => {
			throw new Error("invalid_manifest");
		});
		await expect(runStudioNvaApplyFlow(flow)).rejects.toThrow(
			"invalid_manifest",
		);
		expect(steps).toEqual(["download", "inspect", "cleanup"]);
		expect(flow.importAsset).not.toHaveBeenCalled();
		expect(flow.applyModel).not.toHaveBeenCalled();
	});
});

describe("Studio NVA apply duplicate links", () => {
	const pending = [
		{ requestId: "r1", avatarId: "av_1", environment: "production" },
	];

	it("treats the same avatar on the same environment as a repeat", () => {
		expect(
			hasPendingStudioNvaTarget(pending, {
				avatarId: "av_1",
				environment: "production",
			}),
		).toBe(true);
	});

	it("keeps a different avatar or environment as a new request", () => {
		expect(
			hasPendingStudioNvaTarget(pending, {
				avatarId: "av_2",
				environment: "production",
			}),
		).toBe(false);
		expect(
			hasPendingStudioNvaTarget(pending, {
				avatarId: "av_1",
				environment: "development",
			}),
		).toBe(false);
	});
});

describe("isStudioNvaApplyRequest", () => {
	it("accepts only well-formed deep link requests", () => {
		expect(
			isStudioNvaApplyRequest({
				requestId: "r1",
				avatarId: "av_1",
				environment: "development",
			}),
		).toBe(true);
		expect(isStudioNvaApplyRequest(null)).toBe(false);
		expect(
			isStudioNvaApplyRequest({
				requestId: "r1",
				avatarId: "av_1",
				environment: "staging",
			}),
		).toBe(false);
		expect(isStudioNvaApplyRequest({ requestId: 1, avatarId: "av_1" })).toBe(
			false,
		);
	});
});

describe("StudioNvaApplyHost deferred receiver", () => {
	it("drains queued cold-start requests on late mount, deduplicates repeats, and advances on close", async () => {
		tauriMocks.invoke.mockImplementation(async (cmd: string) => {
			if (cmd === "studio_nva_apply_pending") {
				return [
					{
						requestId: "req-cold-1",
						avatarId: "av_1",
						environment: "production",
					},
					{
						requestId: "req-cold-dup",
						avatarId: "av_1",
						environment: "production",
					},
				];
			}
			return undefined;
		});

		render(createElement(StudioNvaApplyHost));

		expect(tauriMocks.listen).toHaveBeenCalledWith(
			"studio_nva_apply_requested",
			expect.any(Function),
		);
		expect(tauriMocks.invoke).toHaveBeenCalledWith("studio_nva_apply_pending");

		expect(
			await screen.findByText("req-cold-1:av_1:production"),
		).toBeInTheDocument();

		act(() => {
			tauriMocks.listener?.({
				payload: {
					requestId: "req-cold-1",
					avatarId: "av_1",
					environment: "production",
				},
			});
			tauriMocks.listener?.({
				payload: {
					requestId: "req-live-2",
					avatarId: "av_2",
					environment: "development",
				},
			});
		});

		fireEvent.click(screen.getByRole("button", { name: "close-dialog" }));

		expect(
			await screen.findByText("req-live-2:av_2:development"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "close-dialog" }));
		expect(
			screen.queryByTestId("studio-nva-apply-dialog"),
		).not.toBeInTheDocument();
	});
});
