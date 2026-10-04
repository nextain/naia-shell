export interface WebFs {
	readText(path: string): Promise<string | null>; // 없으면 null
	writeBytes(path: string, data: string | Uint8Array): Promise<void>; // 중간 폴더를 만든다
	exists(path: string): Promise<boolean>; // 파일이나 폴더
	ensureDir(path: string): Promise<void>;
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

export function createOpfsWebFs(
	getRoot: () => Promise<FileSystemDirectoryHandle>,
): WebFs {
	return {
		async readText(path: string): Promise<string | null> {
			const segs = validateAndSplitPath(path);
			let currentDir: FileSystemDirectoryHandle;
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
			let fileHandle: FileSystemFileHandle;
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
				} finally {
					await writable.close();
				}
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
			let currentDir: FileSystemDirectoryHandle;
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
