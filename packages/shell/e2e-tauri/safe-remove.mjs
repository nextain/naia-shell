import {
	lstatSync,
	readdirSync,
	rmdirSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeOne(path) {
	let stat;
	try {
		stat = lstatSync(path);
	} catch (err) {
		if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
			return;
		}
		throw err;
	}

	if (stat.isSymbolicLink()) {
		try {
			unlinkSync(path);
		} catch (err) {
			if (err && (err.code === "EPERM" || err.code === "EISDIR")) {
				rmdirSync(path);
			} else {
				throw err;
			}
		}
		return;
	}

	if (stat.isDirectory()) {
		const entries = readdirSync(path);
		for (const entry of entries) {
			removeOne(join(path, entry));
		}
		rmdirSync(path);
		return;
	}

	unlinkSync(path);
}

/** Remove `root` recursively without ever descending into a symlink or junction.
 *  Links (including Windows junctions, which lstat reports as symbolic links) are
 *  unlinked themselves; their targets are never touched. */
export function removeTreeNoFollow(root, { retries = 20, delayMs = 250 } = {}) {
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			removeOne(root);
			return;
		} catch (err) {
			const isRetryable =
				err && (err.code === "EBUSY" || err.code === "EPERM" || err.code === "ENOTEMPTY");
			if (attempt < retries && isRetryable) {
				sleepSync(delayMs);
				continue;
			}
			throw err;
		}
	}
}
