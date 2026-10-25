export interface WebFs {
	readText(path: string): Promise<string | null>; // 없으면 null
	writeBytes(path: string, data: string | Uint8Array): Promise<void>; // 중간 폴더를 만든다
	exists(path: string): Promise<boolean>; // 파일이나 폴더
	ensureDir(path: string): Promise<void>;
	/** 디렉토리 직속 항목 이름 목록. 디렉토리가 없으면 빈 배열. */
	listEntries?(path: string): Promise<string[]>;
	/** 파일 삭제. 이미 없으면 무시. */
	removeFile?(path: string): Promise<void>;
}

export function validateAndSplitPath(path: string): string[] {
	if (!path || typeof path !== "string") {
		throw new Error(`web_fs_invalid_path:${path}`);
	}
	const segs = path.split("/");
	for (const seg of segs) {
		if (seg === "" || seg === "." || seg === "..") {
			throw new Error(`web_fs_invalid_path:${path}`);
		}
	}
	return segs;
}

function isNotFoundError(e: unknown): boolean {
	if (typeof DOMException !== "undefined" && e instanceof DOMException) {
		return e.name === "NotFoundError" || e.name === "TypeMismatchError";
	}
	if (e && typeof e === "object" && "name" in e) {
		const name = (e as { name?: unknown }).name;
		return name === "NotFoundError" || name === "TypeMismatchError";
	}
	return false;
}

function isExactNotFoundError(e: unknown): boolean {
	if (typeof DOMException !== "undefined" && e instanceof DOMException) {
		return e.name === "NotFoundError";
	}
	if (e && typeof e === "object" && "name" in e) {
		const name = (e as { name?: unknown }).name;
		return name === "NotFoundError";
	}
	return false;
}

export interface WebFsWritableFileStream {
	write(data: string | Blob): Promise<void>;
	close(): Promise<void>;
}

export interface WebFsFileHandle {
	getFile(): Promise<{ text(): Promise<string> }>;
	createWritable(): Promise<WebFsWritableFileStream>;
}

export interface WebFsDirectoryHandle {
	getDirectoryHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<WebFsDirectoryHandle>;
	getFileHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<WebFsFileHandle>;
	removeEntry(name: string): Promise<void>;
	keys?(): AsyncIterable<string>;
	entries?(): AsyncIterable<[string, unknown]>;
	[Symbol.asyncIterator]?(): AsyncIterableIterator<[string, unknown]>;
}

export function createOpfsWebFs(
	getRoot: () => Promise<WebFsDirectoryHandle>,
): WebFs {
	return {
		async readText(path: string): Promise<string | null> {
			const segs = validateAndSplitPath(path);
			let currentDir: WebFsDirectoryHandle;
			try {
				currentDir = await getRoot();
			} catch (e) {
				if (isNotFoundError(e)) return null;
				throw e;
			}

			for (let i = 0; i < segs.length - 1; i++) {
				try {
					currentDir = await currentDir.getDirectoryHandle(segs[i], {
						create: false,
					});
				} catch (e) {
					if (isNotFoundError(e)) return null;
					throw e;
				}
			}

			const fileName = segs[segs.length - 1];
			let fileHandle: WebFsFileHandle;
			try {
				fileHandle = await currentDir.getFileHandle(fileName, {
					create: false,
				});
			} catch (e) {
				if (isNotFoundError(e)) return null;
				throw e;
			}

			try {
				const file = await fileHandle.getFile();
				return await file.text();
			} catch (e) {
				if (isNotFoundError(e)) return null;
				throw e;
			}
		},

		async writeBytes(path: string, data: string | Uint8Array): Promise<void> {
			const segs = validateAndSplitPath(path);
			let currentDir = await getRoot();

			for (let i = 0; i < segs.length - 1; i++) {
				currentDir = await currentDir.getDirectoryHandle(segs[i], {
					create: true,
				});
			}

			const fileName = segs[segs.length - 1];
			let isNewFile = false;
			try {
				await currentDir.getFileHandle(fileName, { create: false });
			} catch (e) {
				if (isExactNotFoundError(e)) {
					isNewFile = true;
				} else {
					throw e;
				}
			}

			const fileHandle = await currentDir.getFileHandle(fileName, {
				create: true,
			});

			try {
				const writable = await fileHandle.createWritable();
				let writeError: unknown = null;
				let hasWriteError = false;
				try {
					let chunk: string | Blob;
					if (typeof data === "string") {
						chunk = data;
					} else {
						const buf = new ArrayBuffer(data.byteLength);
						new Uint8Array(buf).set(data);
						chunk = new Blob([buf]);
					}
					await writable.write(chunk);
				} catch (err) {
					hasWriteError = true;
					writeError = err;
				}

				if (hasWriteError) {
					try {
						await writable.close();
					} catch {
						// write 실패 시 close 실패는 무시하고 원래 writeError 보존
					}
					throw writeError;
				}

				await writable.close();
			} catch (e) {
				if (isNewFile) {
					try {
						await currentDir.removeEntry(fileName);
					} catch {
						// ignore cleanup error to preserve original error
					}
				}
				throw e;
			}
		},

		async exists(path: string): Promise<boolean> {
			const segs = validateAndSplitPath(path);
			let currentDir: WebFsDirectoryHandle;
			try {
				currentDir = await getRoot();
			} catch (e) {
				if (isNotFoundError(e)) return false;
				throw e;
			}

			for (let i = 0; i < segs.length - 1; i++) {
				try {
					currentDir = await currentDir.getDirectoryHandle(segs[i], {
						create: false,
					});
				} catch (e) {
					if (isNotFoundError(e)) return false;
					throw e;
				}
			}

			const last = segs[segs.length - 1];
			try {
				await currentDir.getFileHandle(last, { create: false });
				return true;
			} catch (e) {
				if (!isNotFoundError(e)) throw e;
			}

			try {
				await currentDir.getDirectoryHandle(last, { create: false });
				return true;
			} catch (e) {
				if (!isNotFoundError(e)) throw e;
			}

			return false;
		},

		async ensureDir(path: string): Promise<void> {
			const segs = validateAndSplitPath(path);
			let currentDir = await getRoot();
			for (let i = 0; i < segs.length; i++) {
				currentDir = await currentDir.getDirectoryHandle(segs[i], {
					create: true,
				});
			}
		},

		async listEntries(path: string): Promise<string[]> {
			const segs = validateAndSplitPath(path);
			let currentDir: WebFsDirectoryHandle;
			try {
				currentDir = await getRoot();
			} catch (e) {
				if (isNotFoundError(e)) return [];
				throw e;
			}
			for (let i = 0; i < segs.length; i++) {
				try {
					currentDir = await currentDir.getDirectoryHandle(segs[i], {
						create: false,
					});
				} catch (e) {
					if (isNotFoundError(e)) return [];
					throw e;
				}
			}
			const names: string[] = [];
			if (typeof currentDir.keys === "function") {
				for await (const name of currentDir.keys()) {
					names.push(name);
				}
			} else if (typeof currentDir.entries === "function") {
				for await (const [name] of currentDir.entries()) {
					names.push(name);
				}
			} else if (typeof currentDir[Symbol.asyncIterator] === "function") {
				for await (const [name] of currentDir as AsyncIterable<
					[string, unknown]
				>) {
					names.push(name);
				}
			}
			return names.sort();
		},

		async removeFile(path: string): Promise<void> {
			const segs = validateAndSplitPath(path);
			let currentDir: WebFsDirectoryHandle;
			try {
				currentDir = await getRoot();
			} catch (e) {
				if (isNotFoundError(e)) return;
				throw e;
			}
			for (let i = 0; i < segs.length - 1; i++) {
				try {
					currentDir = await currentDir.getDirectoryHandle(segs[i], {
						create: false,
					});
				} catch (e) {
					if (isNotFoundError(e)) return;
					throw e;
				}
			}
			const fileName = segs[segs.length - 1];
			try {
				await currentDir.removeEntry(fileName);
			} catch (e) {
				if (isNotFoundError(e)) return;
				throw e;
			}
		},
	};
}

export function createMemoryWebFs(): WebFs & {
	snapshot(): Record<string, string | "<dir>">;
} {
	const dirs = new Set<string>();
	const files = new Map<string, string | Uint8Array>();

	return {
		async readText(path: string): Promise<string | null> {
			const segs = validateAndSplitPath(path);
			const norm = segs.join("/");
			const val = files.get(norm);
			if (val === undefined) return null;
			if (typeof val === "string") return val;
			return new TextDecoder().decode(val);
		},

		async writeBytes(path: string, data: string | Uint8Array): Promise<void> {
			const segs = validateAndSplitPath(path);
			for (let i = 1; i < segs.length; i++) {
				dirs.add(segs.slice(0, i).join("/"));
			}
			const norm = segs.join("/");
			files.set(norm, data);
		},

		async exists(path: string): Promise<boolean> {
			const segs = validateAndSplitPath(path);
			const norm = segs.join("/");
			return files.has(norm) || dirs.has(norm);
		},

		async ensureDir(path: string): Promise<void> {
			const segs = validateAndSplitPath(path);
			for (let i = 1; i <= segs.length; i++) {
				dirs.add(segs.slice(0, i).join("/"));
			}
		},

		async listEntries(path: string): Promise<string[]> {
			const segs = validateAndSplitPath(path);
			const prefix = `${segs.join("/")}/`;
			const entries = new Set<string>();
			for (const filePath of files.keys()) {
				if (filePath.startsWith(prefix)) {
					const rest = filePath.slice(prefix.length);
					const firstSeg = rest.split("/")[0];
					if (firstSeg) entries.add(firstSeg);
				}
			}
			for (const dirPath of dirs) {
				if (dirPath.startsWith(prefix)) {
					const rest = dirPath.slice(prefix.length);
					const firstSeg = rest.split("/")[0];
					if (firstSeg) entries.add(firstSeg);
				}
			}
			return [...entries];
		},

		async removeFile(path: string): Promise<void> {
			const segs = validateAndSplitPath(path);
			const norm = segs.join("/");
			files.delete(norm);
		},

		snapshot(): Record<string, string | "<dir>"> {
			const res: Record<string, string | "<dir>"> = {};
			for (const d of dirs) {
				res[d] = "<dir>";
			}
			for (const [p, val] of files.entries()) {
				res[p] = typeof val === "string" ? val : new TextDecoder().decode(val);
			}
			return res;
		},
	};
}

let activeFs: WebFs | null = null;
let testFs: WebFs | null = null;

export function setWebFsForTests(fs: WebFs | null): void {
	testFs = fs;
}

export function getWebFs(): WebFs {
	if (testFs) return testFs;
	if (!activeFs) {
		activeFs = createOpfsWebFs(() => navigator.storage.getDirectory());
	}
	return activeFs;
}
