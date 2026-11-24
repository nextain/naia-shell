import type {
	BrowserReadEntry,
	BrowserReadFs,
	BrowserReadStat,
} from "@naia-agent/composition/browser-agent.js";
import { WEB_ADK_OPFS_DIR } from "../src/lib/web-runtime/web-adk-path";

export interface OpfsFileLike {
	readonly size: number;
	text(): Promise<string>;
}

export interface OpfsFileHandleLike {
	readonly kind?: "file";
	readonly name?: string;
	getFile(): Promise<OpfsFileLike>;
}

export interface OpfsEntryLike {
	readonly kind: "file" | "directory";
	readonly name: string;
}

export interface OpfsDirectoryHandleLike {
	readonly kind?: "directory";
	readonly name?: string;
	getDirectoryHandle(name: string): Promise<OpfsDirectoryHandleLike>;
	getFileHandle(name: string): Promise<OpfsFileHandleLike>;
	values(): AsyncIterable<OpfsEntryLike> | Iterable<OpfsEntryLike>;
}

function getErrorName(err: unknown): string | undefined {
	if (typeof err === "object" && err !== null && "name" in err) {
		const name = (err as { name: unknown }).name;
		if (typeof name === "string") {
			return name;
		}
	}
	return undefined;
}

export function makeOpfsReadFs(
	getRoot: () => Promise<OpfsDirectoryHandleLike>,
): BrowserReadFs {
	return {
		async stat(segments: readonly string[]): Promise<BrowserReadStat> {
			const root = await getRoot();
			let dir: OpfsDirectoryHandleLike;
			try {
				dir = await root.getDirectoryHandle(WEB_ADK_OPFS_DIR);
			} catch (err: unknown) {
				const name = getErrorName(err);
				if (name === "NotFoundError" || name === "TypeMismatchError") {
					return null;
				}
				throw err;
			}

			if (segments.length === 0) {
				return { kind: "directory" };
			}

			for (let i = 0; i < segments.length - 1; i++) {
				const segment = segments[i];
				try {
					dir = await dir.getDirectoryHandle(segment);
				} catch (err: unknown) {
					const name = getErrorName(err);
					if (name === "NotFoundError" || name === "TypeMismatchError") {
						return null;
					}
					throw err;
				}
			}

			const lastSegment = segments[segments.length - 1];
			try {
				await dir.getDirectoryHandle(lastSegment);
				return { kind: "directory" };
			} catch (err: unknown) {
				const name = getErrorName(err);
				if (name === "NotFoundError") {
					return null;
				}
				if (name !== "TypeMismatchError") {
					throw err;
				}
				// TypeMismatchError -> proceed to file handle inspection
			}

			try {
				const fileHandle = await dir.getFileHandle(lastSegment);
				const file = await fileHandle.getFile();
				return { kind: "file", size: file.size };
			} catch (err: unknown) {
				const name = getErrorName(err);
				if (name === "NotFoundError" || name === "TypeMismatchError") {
					return null;
				}
				throw err;
			}
		},

		async list(segments: readonly string[]): Promise<readonly BrowserReadEntry[]> {
			const root = await getRoot();
			let dir = await root.getDirectoryHandle(WEB_ADK_OPFS_DIR);
			for (const segment of segments) {
				dir = await dir.getDirectoryHandle(segment);
			}

			const entries: BrowserReadEntry[] = [];
			for await (const entry of dir.values()) {
				entries.push({
					name: entry.name,
					kind: entry.kind,
				});
			}
			return entries;
		},

		async readText(segments: readonly string[]): Promise<string> {
			if (segments.length === 0) {
				throw new Error("readText called with empty segments");
			}
			const root = await getRoot();
			let dir = await root.getDirectoryHandle(WEB_ADK_OPFS_DIR);
			for (let i = 0; i < segments.length - 1; i++) {
				dir = await dir.getDirectoryHandle(segments[i]);
			}

			const lastSegment = segments[segments.length - 1];
			const fileHandle = await dir.getFileHandle(lastSegment);
			const file = await fileHandle.getFile();
			return await file.text();
		},
	};
}
