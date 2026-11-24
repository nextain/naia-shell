// @vitest-environment jsdom
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWebAssetsModeForTests } from "../web-assets";
import {
	WEB_NVA_FILES_DIR,
	WEB_SETTINGS_ASSETS_CHANGED_EVENT,
} from "../web-nva-archive";
import { WEB_SETTINGS_ROOT } from "../web-settings-catalog";
import {
	WEB_SETTINGS_BACKGROUND_DIR,
	WEB_SETTINGS_BACKGROUND_MAX_BYTES,
	WebSettingsAssetImportError,
	importWebSettingsAsset,
	listWebBackgroundPaths,
	readWebSettingsAssetBlob,
	removeWebSettingsAsset,
	resolveWebBackgroundSelection,
	resolveWebNvaSelection,
} from "../web-settings-assets";

beforeEach(() => {
	vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
});

afterEach(() => {
	vi.restoreAllMocks();
	setWebAssetsModeForTests(null);
	vi.unstubAllGlobals();
	vi.resetModules();
});

function notFound(): DOMException {
	return new DOMException("missing", "NotFoundError");
}

type Writer = {
	write(data: Blob): Promise<void>;
	close(): Promise<void>;
	abort(): Promise<void>;
};

/** 메모리 OPFS (web-bgm-music.test.ts의 MemDir와 같은 계약). */
class MemDir {
	readonly kind = "directory";
	dirs = new Map<string, MemDir>();
	files = new Map<string, Blob>();
	failWrite: DOMException | null = null;
	constructor(readonly name: string) {}
	isSameEntry(other: unknown): boolean {
		return this === other;
	}
	async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
		let dir = this.dirs.get(name);
		if (!dir) {
			if (!opts?.create) throw notFound();
			dir = new MemDir(name);
			dir.failWrite = this.failWrite;
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
			createWritable: async (): Promise<Writer> => {
				let data: Blob = new Blob([]);
				return {
					write: async (blob: Blob) => {
						if (this.failWrite) throw this.failWrite;
						data = blob;
					},
					close: async () => {
						this.files.set(name, data);
					},
					abort: async () => {},
				};
			},
		};
	}
	async removeEntry(name: string) {
		if (!this.files.delete(name) && !this.dirs.delete(name)) throw notFound();
	}
	async *values() {
		for (const name of this.files.keys()) yield { kind: "file", name };
		for (const dir of this.dirs.values()) yield dir;
	}
}

function stubOpfs(root = new MemDir("")) {
	vi.stubGlobal("navigator", {
		storage: { getDirectory: async () => root },
		locks: { request: async (_name: string, fn: () => unknown) => fn() },
	});
	return root;
}

/** 1x1 빨강 PNG. 가져오기 형식 검사를 통과하는 실제 이미지 바이트. */
function tinyPngBytes(): Uint8Array<ArrayBuffer> {
	return new Uint8Array([
		137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0,
		0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73,
		68, 65, 84, 120, 218, 99, 252, 207, 192, 80, 15, 0, 4, 133, 1, 128,
		132, 169, 140, 33, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
	]);
}

function buildNvaZipBytes(
	clipPrefix = "",
	secondClip?: string,
): Uint8Array<ArrayBuffer> {
	const manifest = {
		tva_version: undefined,
		nva_version: "0.2",
		canvas: { width: 720, height: 1280 },
		animations: {
			idle: { clip: `${clipPrefix}clips/idle.webm`, loop: true, can_talk: false },
			...(secondClip ? { talk: { clip: "clips/talk.webm", loop: true } } : {}),
		},
	};
	const entries: Record<string, Uint8Array> = {
		"manifest.json": strToU8(JSON.stringify(manifest)),
		[`${clipPrefix}clips/idle.webm`]: strToU8("webm-idle-bytes"),
	};
	if (secondClip) entries["clips/talk.webm"] = strToU8(secondClip);
	return new Uint8Array(zipSync(entries));
}

function stubVideoDecoder(outcomes: Array<"loadeddata" | "error"> = []) {
	vi.stubGlobal("URL", class extends URL {
		static override createObjectURL = vi.fn(() => "blob:settings-test");
		static override revokeObjectURL = vi.fn();
	});
	vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
	vi.spyOn(HTMLMediaElement.prototype, "src", "set").mockImplementation(
		function (this: HTMLMediaElement) {
			const type = outcomes.shift() ?? "loadeddata";
			queueMicrotask(() => this.dispatchEvent(new Event(type)));
		},
	);
}

const BG = `${WEB_SETTINGS_ROOT}/background`;

describe("web-settings-assets background selection", () => {
	it("prefers the exact stored identifier over basename suffix matching", () => {
		const bundled = "/backgrounds/my-photo.webp";
		const user = `${BG}/my-photo.webp`;
		expect(resolveWebBackgroundSelection(user, [bundled, user])).toBe(user);
		expect(resolveWebBackgroundSelection(bundled, [bundled, user])).toBe(bundled);
	});

	it("resolves a legacy bare filename to the bundled file, never a longer name", () => {
		const bundled = "/backgrounds/my-photo.webp";
		const user = `${BG}/my-photo.webp`;
		const longer = "/backgrounds/xmy-photo.webp";
		// bare 이름은 안정적인 번들 카탈로그가 이긴다. 사용자 파일은 전체 식별자로 고른다.
		expect(resolveWebBackgroundSelection("my-photo.webp", [bundled, user])).toBe(
			bundled,
		);
		// 끝부분 일치 fashion (endsWith) would match xmy-photo.webp; exact basename must not.
		expect(
			resolveWebBackgroundSelection("my-photo.webp", [longer]),
		).toBeNull();
		expect(
			resolveWebBackgroundSelection("my-photo.webp", [bundled]),
		).toBe(bundled);
	});

	it("returns null for empty, unknown, or directory-traversal identifiers", () => {
		expect(resolveWebBackgroundSelection("", ["/backgrounds/a.webp"])).toBeNull();
		expect(
			resolveWebBackgroundSelection(undefined, ["/backgrounds/a.webp"]),
		).toBeNull();
		expect(
			resolveWebBackgroundSelection("missing.webp", ["/backgrounds/a.webp"]),
		).toBeNull();
		expect(
			resolveWebBackgroundSelection("../a.webp", [`${BG}/a.webp`]),
		).toBeNull();
	});
});

describe("web-settings-assets NVA selection", () => {
	it("resolves bare names, leaves, and full OPFS identifiers to the list entry", () => {
		expect(resolveWebNvaSelection("naia", ["naia", "custom.nva"])).toBe("naia");
		expect(
			resolveWebNvaSelection("custom.nva", ["naia", "custom.nva"]),
		).toBe("custom.nva");
		expect(
			resolveWebNvaSelection(`${WEB_NVA_FILES_DIR}/custom.nva`, [
				"naia",
				"custom.nva",
			]),
		).toBe("custom.nva");
	});

	it("keeps same-name user and built-in NVA files distinct", () => {
		expect(resolveWebNvaSelection("naia", ["naia", "naia.nva"])).toBe("naia");
		expect(resolveWebNvaSelection("naia.nva", ["naia", "naia.nva"])).toBe(
			"naia.nva",
		);
		expect(resolveWebNvaSelection("nope", ["naia"])).toBeNull();
	});
});

describe("web-settings-assets background OPFS list", () => {
	it("lists user background files with full identifiers newest-name order", async () => {
		const root = stubOpfs();
		const bg = await root
			.getDirectoryHandle("naia-adk", { create: true })
			.then((d) => d.getDirectoryHandle("naia-settings", { create: true }))
			.then((d) => d.getDirectoryHandle("background", { create: true }));
		await (await bg.getFileHandle("b.MP4", { create: true })).createWritable()
			.then((w) => w.write(new Blob(["v"])))
			.catch(() => {});
		bg.files.set("a.png", new Blob(["i"]));
		bg.files.set("b.MP4", new Blob(["v"]));
		bg.files.set("note.txt", new Blob(["t"]));
		bg.files.set(".hidden.png", new Blob(["h"]));
		expect(await listWebBackgroundPaths()).toEqual([
			`${WEB_SETTINGS_BACKGROUND_DIR}/a.png`,
			`${WEB_SETTINGS_BACKGROUND_DIR}/b.MP4`,
		]);
	});

	it("lists nothing when the background folder is absent", async () => {
		stubOpfs();
		expect(await listWebBackgroundPaths()).toEqual([]);
	});
});

describe("web-settings-assets import", () => {
	it("rejects a wrong file type for background without saving", async () => {
		stubOpfs();
		const events: string[] = [];
		window.addEventListener(WEB_SETTINGS_ASSETS_CHANGED_EVENT, () =>
			events.push("changed"),
		);
		await expect(
			importWebSettingsAsset(
				"background",
				new File(["x"], "avatar.vrm", { type: "model/vrm" }),
			),
		).rejects.toMatchObject({ code: "unsupported" });
		expect(events).toEqual([]);
		expect(await listWebBackgroundPaths()).toEqual([]);
	});

	it("rejects an oversized background without saving", async () => {
		stubOpfs();
		const big = new File(["x"], "big.png", { type: "image/png" });
		Object.defineProperty(big, "size", {
			value: WEB_SETTINGS_BACKGROUND_MAX_BYTES + 1,
		});
		await expect(importWebSettingsAsset("background", big)).rejects.toMatchObject(
			{ code: "too_large" },
		);
		expect(await listWebBackgroundPaths()).toEqual([]);
	});

	it("saves a PNG background and reports the stored identifier", async () => {
		stubOpfs();
		const events: string[] = [];
		window.addEventListener(WEB_SETTINGS_ASSETS_CHANGED_EVENT, () =>
			events.push("changed"),
		);
		const stored = await importWebSettingsAsset(
			"background",
			new File([tinyPngBytes()], "my-photo.png", { type: "image/png" }),
		);
		expect(stored).toBe(`${WEB_SETTINGS_BACKGROUND_DIR}/my-photo.png`);
		expect(events).toEqual(["changed"]);
		expect(await listWebBackgroundPaths()).toEqual([stored]);
	});

	it("keeps both files when the same background name is imported twice", async () => {
		stubOpfs();
		const first = await importWebSettingsAsset(
			"background",
			new File([tinyPngBytes()], "a.png", { type: "image/png" }),
		);
		const second = await importWebSettingsAsset(
			"background",
			new File([tinyPngBytes()], "a.png", { type: "image/png" }),
		);
		expect(first).toBe(`${WEB_SETTINGS_BACKGROUND_DIR}/a.png`);
		expect(second).toBe(`${WEB_SETTINGS_BACKGROUND_DIR}/a (2).png`);
		expect(await listWebBackgroundPaths()).toHaveLength(2);
	});

	it("maps OPFS quota exhaustion to a quota error and keeps the old list", async () => {
		const root = stubOpfs();
		stubVideoDecoder();
		root.failWrite = new DOMException("full", "QuotaExceededError");
		await expect(
			importWebSettingsAsset(
				"background",
				new File([tinyPngBytes()], "q.png", { type: "image/png" }),
			),
		).rejects.toMatchObject({ code: "quota" });
		expect(await listWebBackgroundPaths()).toEqual([]);
		await expect(
			importWebSettingsAsset(
				"nva-files",
				new File([buildNvaZipBytes()], "a.nva"),
			),
		).rejects.toMatchObject({ code: "quota" });
	});

	it("rejects a non-NVA file and a corrupt NVA archive without saving", async () => {
		stubOpfs();
		await expect(
			importWebSettingsAsset("nva-files", new File(["x"], "a.png")),
		).rejects.toMatchObject({ code: "unsupported" });
		await expect(
			importWebSettingsAsset(
				"nva-files",
				new File(["not-a-zip"], "broken.nva"),
			),
		).rejects.toMatchObject({ code: "invalid_nva" });
		const events: string[] = [];
		window.addEventListener(WEB_SETTINGS_ASSETS_CHANGED_EVENT, () =>
			events.push("changed"),
		);
		expect(events).toEqual([]);
	});

	it("saves a valid NVA archive and keeps same-name uploads distinct", async () => {
		stubOpfs();
		stubVideoDecoder();
		const events: string[] = [];
		window.addEventListener(WEB_SETTINGS_ASSETS_CHANGED_EVENT, () =>
			events.push("changed"),
		);
		const first = await importWebSettingsAsset(
			"nva-files",
			new File([buildNvaZipBytes()], "custom.nva"),
		);
		expect(first).toBe(`${WEB_NVA_FILES_DIR}/custom.nva`);
		const second = await importWebSettingsAsset(
			"nva-files",
			new File([buildNvaZipBytes()], "custom.nva"),
		);
		expect(second).toBe(`${WEB_NVA_FILES_DIR}/custom (2).nva`);
		expect(events).toEqual(["changed", "changed"]);
	});

describe("web-settings-assets review fixes (fx1)", () => {
	it("rejects an NVA archive whose manifest clip is missing from the ZIP", async () => {
		stubOpfs();
		const manifest = {
			nva_version: "0.2",
			canvas: { width: 720, height: 1280 },
			animations: {
				idle: { clip: "clips/idle.webm", loop: true, can_talk: false },
			},
		};
		const bytes = new Uint8Array(
			zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)) }),
		);
		await expect(
			importWebSettingsAsset(
				"nva-files",
				new File([bytes], "missing-clip.nva"),
			),
		).rejects.toMatchObject({ code: "invalid_nva" });
		expect(await listWebBackgroundPaths()).toEqual([]);
	});

	it("rejects an NVA clip that the browser cannot decode", async () => {
		stubOpfs();
		vi.useFakeTimers();
		const createObjectURL = vi.fn(() => "blob:nva-clip");
		vi.stubGlobal("URL", class extends URL {
			static override createObjectURL = createObjectURL;
			static override revokeObjectURL = vi.fn();
		});
		try {
			const video = document.createElement("video");
			vi.spyOn(video, "canPlayType").mockReturnValue("probably");
			vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
				if (tag === "video") return video;
				return document.createElement(tag);
			}) as typeof document.createElement);
			const promise = importWebSettingsAsset(
				"nva-files",
				new File([buildNvaZipBytes()], "garbage-clip.nva"),
			);
			// 거부 핸들러를 타이머 전진보다 먼저 붙인다. 늦게 붙이면
			// 타이머 만료 시점에 미처리 거부가 기록돼 묶음 종료 코드가 1이 된다.
			const assertion = expect(promise).rejects.toMatchObject({
				code: "invalid_nva",
			});
			await vi.advanceTimersByTimeAsync(6000);
			await assertion;
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		}
	});

	it("rejects an NVA before saving when a later required clip cannot decode", async () => {
		const root = stubOpfs();
		stubVideoDecoder(["loadeddata", "error"]);
		await expect(
			importWebSettingsAsset("nva-files", new File([
				buildNvaZipBytes("", "damaged"),
			], "second-clip.nva")),
		).rejects.toMatchObject({ code: "invalid_nva" });
		expect(root.dirs.has("naia-adk")).toBe(false);
	});

	it("rejects an NVA before saving when the codec is unsupported", async () => {
		const root = stubOpfs();
		vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
		await expect(
			importWebSettingsAsset("nva-files", new File([buildNvaZipBytes()], "unsupported.nva")),
		).rejects.toMatchObject({ code: "invalid_nva" });
		expect(root.dirs.has("naia-adk")).toBe(false);
	});

	it("uses the browser image decoder when createImageBitmap is absent", async () => {
		const root = stubOpfs();
		stubVideoDecoder();
		vi.stubGlobal("createImageBitmap", undefined);
		let decodes = 0;
		vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(1);
		vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(
			function (this: HTMLImageElement) {
				const type = decodes++ === 0 ? "error" : "load";
				queueMicrotask(() => this.dispatchEvent(new Event(type)));
			},
		);
		await expect(importWebSettingsAsset("background", new File([
			tinyPngBytes().slice(0, 8),
		], "truncated.png"))).rejects.toMatchObject({ code: "unplayable" });
		expect(root.dirs.has("naia-adk")).toBe(false);
		await expect(importWebSettingsAsset("background", new File([
			tinyPngBytes(),
		], "valid.png"))).resolves.toBe(`${WEB_SETTINGS_BACKGROUND_DIR}/valid.png`);
		expect(decodes).toBe(2);
	});

	it("rejects an image whose bytes do not match its extension", async () => {
		stubOpfs();
		await expect(
			importWebSettingsAsset(
				"background",
				new File(["not-an-image"], "fake.png", { type: "image/png" }),
			),
		).rejects.toMatchObject({ code: "unplayable" });
		expect(await listWebBackgroundPaths()).toEqual([]);
	});

	it("rejects a video the browser reports as unsupported", async () => {
		stubOpfs();
		vi.spyOn(
			HTMLVideoElement.prototype,
			"canPlayType",
		).mockReturnValue("");
		try {
			await expect(
				importWebSettingsAsset(
					"background",
					new File(["mp4"], "movie.mp4", { type: "video/mp4" }),
				),
			).rejects.toMatchObject({ code: "unplayable" });
		} finally {
			vi.restoreAllMocks();
		}
		expect(await listWebBackgroundPaths()).toEqual([]);
	});

	it("returns null for a missing full identifier even when a bundled file shares the name", () => {
		const bundled = "/backgrounds/shared.webp";
		const user = `${WEB_SETTINGS_BACKGROUND_DIR}/shared.webp`;
		expect(resolveWebBackgroundSelection(user, [bundled])).toBeNull();
	});

	it("reads no bundled bytes for a missing user file that shares a bundled name", async () => {
		const root = stubOpfs();
		const bg = await root
			.getDirectoryHandle("naia-adk", { create: true })
			.then((d) => d.getDirectoryHandle("naia-settings", { create: true }))
			.then((d) => d.getDirectoryHandle("background", { create: true }));
		bg.files.set("other.png", new Blob(["i"]));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("bundled-bytes")),
		);
		try {
			await expect(
				readWebSettingsAssetBlob(
					`${WEB_SETTINGS_BACKGROUND_DIR}/naia-dawn-city-uhd.webp`,
				),
			).rejects.toThrow();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("resolves full identifiers that contain double dots in the file name", () => {
		const user = `${WEB_SETTINGS_BACKGROUND_DIR}/photo..png`;
		expect(resolveWebBackgroundSelection(user, [user])).toBe(user);
		expect(resolveWebBackgroundSelection("photo..png", [user])).toBe(user);
	});

	it("shares one background media-type contract that includes BMP", async () => {
		const mod = (await import("../web-settings-assets")) as Record<
			string,
			unknown
		>;
		expect(typeof mod.getWebBackgroundMediaType).toBe("function");
		const classify = mod.getWebBackgroundMediaType as (
			path: string,
		) => string;
		expect(classify("photo.bmp")).toBe("image");
		expect(classify("clip.mp4")).toBe("video");
		expect(classify("note.txt")).toBe("");
	});

	it("exposes a deletability guard that refuses bundled assets", async () => {
		const mod = (await import("../web-settings-assets")) as Record<
			string,
			unknown
		>;
		expect(typeof mod.canDeleteWebSettingsAsset).toBe("function");
		const canDelete = mod.canDeleteWebSettingsAsset as (
			kind: string,
			stored: string,
			uploadedNvas: readonly string[],
		) => boolean;
		expect(canDelete("background", "/backgrounds/x.webp", [])).toBe(false);
		expect(
			canDelete("background", `${WEB_SETTINGS_BACKGROUND_DIR}/mine.png`, []),
		).toBe(true);
		expect(canDelete("nva-files", "naia", [])).toBe(false);
		expect(canDelete("nva-files", "custom.nva", ["custom.nva"])).toBe(true);
	});

	it("still rejects real parent-directory segments", () => {
		expect(
			resolveWebBackgroundSelection(`${BG}/../a.webp`, [`${BG}/a.webp`]),
		).toBeNull();
		expect(
			resolveWebNvaSelection(
				`${WEB_NVA_FILES_DIR}/../evil.nva`,
				["evil.nva"],
			),
		).toBeNull();
	});
});

	it("removes a user asset and ignores a missing one", async () => {
		stubOpfs();
		const stored = await importWebSettingsAsset(
			"background",
			new File([tinyPngBytes()], "gone.png", { type: "image/png" }),
		);
		const events: string[] = [];
		window.addEventListener(WEB_SETTINGS_ASSETS_CHANGED_EVENT, () =>
			events.push("changed"),
		);
		await removeWebSettingsAsset(stored);
		expect(await listWebBackgroundPaths()).toEqual([]);
		expect(events).toEqual(["changed"]);
		await expect(removeWebSettingsAsset(stored)).resolves.toBeUndefined();
		await expect(
			removeWebSettingsAsset("/backgrounds/naia-dawn-city-uhd.webp"),
		).rejects.toThrow();
		expect(WebSettingsAssetImportError).toBeDefined();
	});
});
