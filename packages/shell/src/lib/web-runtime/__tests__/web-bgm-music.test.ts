import { afterEach, describe, expect, it, vi } from "vitest";
import {
	WEB_BGM_MAX_BYTES,
	WEB_BGM_MUSIC_DIR,
	WebBgmImportError,
	importWebBgmMusic,
	isWebBgmAudioFile,
	listWebBgmMusicPaths,
	readWebBgmMusicBlob,
	removeWebBgmMusic,
	webBgmFileName,
} from "../web-bgm-music";

afterEach(() => vi.unstubAllGlobals());

function notFound(): DOMException {
	return new DOMException("missing", "NotFoundError");
}

type Writer = { write(data: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> };

/** 메모리 OPFS. `failWrite` 로 쓰기 오류를 흉내 낸다. */
class MemDir {
	readonly kind = "directory";
	dirs = new Map<string, MemDir>();
	files = new Map<string, Blob>();
	failWrite: DOMException | null = null;
	constructor(readonly name: string) {}
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
					write: async (blob) => {
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
		if (!this.files.delete(name)) throw notFound();
	}
	async *values() {
		for (const name of this.files.keys()) yield { kind: "file", name };
		for (const dir of this.dirs.values()) yield dir;
	}
}

function stubOpfs(root = new MemDir("")) {
	vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
	return root;
}

function bgmDir(root: MemDir): MemDir | undefined {
	return root.dirs.get("naia-adk")?.dirs.get("naia-settings")?.dirs.get("bgm-musics");
}

describe("R10 web local music import (OPFS)", () => {
	it("R10 lists nothing before any music is imported", async () => {
		stubOpfs();
		expect(await listWebBgmMusicPaths()).toEqual([]);
	});

	it("R10 imports an audio file into naia-settings/bgm-musics and lists it", async () => {
		const root = stubOpfs();
		const path = await importWebBgmMusic(new File(["abc"], "song.mp3", { type: "audio/mpeg" }));
		expect(path).toBe(`${WEB_BGM_MUSIC_DIR}/song.mp3`);
		expect(await bgmDir(root)?.files.get("song.mp3")?.text()).toBe("abc");
		expect(await listWebBgmMusicPaths()).toEqual([path]);
	});

	it("R10 keeps both files when the same name is imported twice", async () => {
		stubOpfs();
		await importWebBgmMusic(new File(["1"], "a.ogg"));
		const second = await importWebBgmMusic(new File(["2"], "a.ogg"));
		expect(second).toBe(`${WEB_BGM_MUSIC_DIR}/a (2).ogg`);
		expect(await listWebBgmMusicPaths()).toHaveLength(2);
	});

	it("R10 rejects non-audio and oversized files without writing", async () => {
		const root = stubOpfs();
		await expect(importWebBgmMusic(new File(["x"], "notes.txt", { type: "text/plain" }))).rejects.toMatchObject({
			code: "not_audio",
		});
		const big = new File(["x"], "big.wav");
		Object.defineProperty(big, "size", { value: WEB_BGM_MAX_BYTES + 1 });
		await expect(importWebBgmMusic(big)).rejects.toMatchObject({ code: "too_large" });
		expect(bgmDir(root)?.files.size ?? 0).toBe(0);
	});

	it("R10 reports a full browser storage as quota and leaves no partial file", async () => {
		const root = new MemDir("");
		root.failWrite = new DOMException("full", "QuotaExceededError");
		stubOpfs(root);
		const error = await importWebBgmMusic(new File(["x"], "s.flac")).catch((e) => e);
		expect(error).toBeInstanceOf(WebBgmImportError);
		expect(error.code).toBe("quota");
		expect(bgmDir(root)?.files.size).toBe(0);
	});

	it("R10 reads the imported file back with an audio MIME type for playback", async () => {
		stubOpfs();
		const path = await importWebBgmMusic(new File(["abc"], "track.m4a"));
		const blob = await readWebBgmMusicBlob(path);
		expect(blob.type).toBe("audio/mp4");
		expect(blob.size).toBe(3);
	});

	it("R10 removes an imported file", async () => {
		stubOpfs();
		const path = await importWebBgmMusic(new File(["abc"], "x.wav"));
		await removeWebBgmMusic(path);
		expect(await listWebBgmMusicPaths()).toEqual([]);
		await expect(removeWebBgmMusic(path)).resolves.toBeUndefined();
	});

	it.each([
		"opfs://naia-adk/naia-settings/bgm-musics/../secret.mp3",
		"opfs://naia-adk/naia-settings/bgm-musics/a/b.mp3",
		"opfs://naia-adk/docs/a.mp3",
		"/home/user/a.mp3",
	])("R10 refuses paths outside the music folder: %s", (path) => {
		expect(webBgmFileName(path)).toBeNull();
	});

	it("R10 accepts audio by extension or MIME type", () => {
		expect(isWebBgmAudioFile({ name: "a.FLAC" })).toBe(true);
		expect(isWebBgmAudioFile({ name: "voice", type: "audio/webm" })).toBe(true);
		expect(isWebBgmAudioFile({ name: "a.png", type: "image/png" })).toBe(false);
	});
});
