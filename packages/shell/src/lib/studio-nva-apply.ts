export interface StudioNvaStagedDownload {
	path: string;
	manifestJson: string;
	sha256: string;
}

export interface StudioNvaApplyFlow {
	confirmed: boolean;
	download: () => Promise<StudioNvaStagedDownload>;
	inspectManifest: (manifestJson: string) => void;
	importAsset: (path: string) => Promise<string>;
	applyModel: (modelName: string) => Promise<void>;
	cleanup: (path: string) => Promise<void>;
}

export type StudioNvaApplyResult =
	| { status: "cancelled" }
	| { status: "applied"; modelName: string };

function basename(path: string): string {
	return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
}

export async function runStudioNvaApplyFlow(
	flow: StudioNvaApplyFlow,
): Promise<StudioNvaApplyResult> {
	if (!flow.confirmed) return { status: "cancelled" };
	const staged = await flow.download();
	try {
		flow.inspectManifest(staged.manifestJson);
		const importedDirectory = await flow.importAsset(staged.path);
		const modelName = basename(importedDirectory);
		if (!modelName) throw new Error("nva_import_path_invalid");
		await flow.applyModel(modelName);
		return { status: "applied", modelName };
	} finally {
		try {
			await flow.cleanup(staged.path);
		} catch {
			// Cleanup is best-effort after the imported asset has been copied.
		}
	}
}

export {
	hasPendingStudioNvaTarget,
	type StudioNvaApplyTarget,
} from "./studio-nva-apply-request";
