import { describe, expect, it, vi } from "vitest";
import {
	hasPendingStudioNvaTarget,
	runStudioNvaApplyFlow,
} from "../studio-nva-apply";

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
