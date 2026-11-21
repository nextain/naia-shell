// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { listNaiaAssets, toLocalBlobUrl } from "../adk-store";
import {
	WEB_BACKGROUND_ASSETS,
	WEB_DEFAULT_BACKGROUND,
	setWebAssetsModeForTests,
} from "../web-runtime/web-assets";
import { WEB_SETTINGS_BACKGROUND_DIR } from "../web-runtime/web-settings-assets";

afterEach(() => {
	setWebAssetsModeForTests(null);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function notFound(): DOMException {
	return new DOMException("missing", "NotFoundError");
}

class MemDir {
	readonly kind = "directory";
	dirs = new Map<string, MemDir>();
	files = new Map<string, Blob>();
	constructor(readonly name: string) {}
	async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
		let dir = this.dirs.get(name);
		if (!dir) {
			if (!opts?.create) throw notFound();
			dir = new MemDir(name);
			this.dirs.set(name, dir);
		}
		return dir;
	}
	async getFileHandle(name: string, opts?: { create?: boolean }) {
		if (!this.files.has(name)) {
			if (!opts?.create) throw notFound();
			this.files.set(name, new Blob([]));
		}
		return {
			kind: "file",
			name,
			getFile: async () => new File([this.files.get(name) ?? new Blob([])], name),
		};
	}
	async *values() {
		for (const name of this.files.keys()) yield { kind: "file", name };
		for (const dir of this.dirs.values()) yield dir;
	}
}

async function seedBackground(root: MemDir, name: string, content: string) {
	const bg = await root
		.getDirectoryHandle("naia-adk", { create: true })
		.then((d) => d.getDirectoryHandle("naia-settings", { create: true }))
		.then((d) => d.getDirectoryHandle("background", { create: true }));
	bg.files.set(name, new Blob([content], { type: "image/png" }));
}

describe("web background assets (settings import follow-up)", () => {
	it("merges bundled backgrounds with user OPFS files without dropping either", async () => {
		setWebAssetsModeForTests(true);
		const root = new MemDir("");
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
		await seedBackground(root, "my-photo.png", "img-bytes");
		const paths = await listNaiaAssets("background");
		const bundled = WEB_BACKGROUND_ASSETS.map((asset) => asset.url);
		expect(paths.slice(0, bundled.length)).toEqual(bundled);
		expect(paths).toContain(`${WEB_SETTINGS_BACKGROUND_DIR}/my-photo.png`);
	});

	it("keeps a user file beside a same-name bundled background", async () => {
		setWebAssetsModeForTests(true);
		const root = new MemDir("");
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
		await seedBackground(root, "naia-dawn-city-uhd.webp", "user-bytes");
		const paths = await listNaiaAssets("background");
		expect(paths).toContain("/backgrounds/naia-dawn-city-uhd.webp");
		expect(paths).toContain(
			`${WEB_SETTINGS_BACKGROUND_DIR}/naia-dawn-city-uhd.webp`,
		);
	});

	it("reads a user background file into a fresh blob URL", async () => {
		setWebAssetsModeForTests(true);
		const root = new MemDir("");
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
		await seedBackground(root, "mine.png", "png-bytes");
		const created: Blob[] = [];
		vi.stubGlobal(
			"URL",
			class extends URL {
				static createObjectURL = vi.fn((blob: Blob) => {
					created.push(blob);
					return `blob:user-${created.length}`;
				});
				static revokeObjectURL = vi.fn();
			},
		);
		const url = await toLocalBlobUrl(
			`${WEB_SETTINGS_BACKGROUND_DIR}/mine.png`,
		);
		expect(url).toBe("blob:user-1");
		expect(await created[0]!.text()).toBe("png-bytes");
	});

	it("rejects a missing user background that has no bundled twin", async () => {
		setWebAssetsModeForTests(true);
		const root = new MemDir("");
		vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
		await expect(
			toLocalBlobUrl(`${WEB_SETTINGS_BACKGROUND_DIR}/gone.png`),
		).rejects.toThrow();
		expect(WEB_DEFAULT_BACKGROUND).toBe("naia-autumn-office-live.mp4");
	});
});
