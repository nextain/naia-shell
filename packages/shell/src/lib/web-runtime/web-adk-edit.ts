import { Logger } from "../logger";
import { isKioskDemo } from "../kiosk-demo/flag";
import { webAdkOpfsPath } from "./web-adk-path";
import {
	WEB_ADK_EDIT_MAX_BYTES,
	isKioskEditableParts,
	splitWebAdkPath,
} from "./web-adk-policy";
import { provisionWebAdk } from "./web-adk";
import { getWebFs } from "./web-fs";
import type { WebFs } from "./web-fs";

/** 방문자가 고친 내용을 OPFS 에 저장한다. 허용 목록 경로·크기 상한을 어기면 던진다. */
export async function writeKioskAdkFile(
	path: string,
	content: string,
	fs: WebFs = getWebFs(),
): Promise<void> {
	const parts = isKioskDemo() ? splitWebAdkPath(path) : null;
	if (!parts || !isKioskEditableParts(parts)) {
		throw new Error("web_workspace_write_not_allowed");
	}
	const bytes = new TextEncoder().encode(content);
	if (bytes.byteLength > WEB_ADK_EDIT_MAX_BYTES) {
		throw new Error("web_workspace_file_too_large");
	}
	await fs.writeBytes(webAdkOpfsPath(parts.join("/")), bytes);
}

/** 번들 JSON(공개 naia-adk 묶음)에서 이 파일만 원본으로 다시 쓴다. */
async function restoreFromBundle(
	fs: WebFs,
	relPaths: readonly string[],
): Promise<boolean> {
	const result = await provisionWebAdk({ fs, force: true, only: relPaths });
	return result.ok;
}

/** 되돌릴 수 있는 파일의 원본 글을 돌려준다. 없으면 null(번들 파일은 번들에서 받는다). */
export async function revertKioskAdkFile(
	path: string,
	fs: WebFs = getWebFs(),
): Promise<string> {
	const parts = isKioskDemo() ? splitWebAdkPath(path) : null;
	if (!parts || !isKioskEditableParts(parts)) {
		throw new Error("web_workspace_write_not_allowed");
	}
	const rel = parts.join("/");
	const { getKioskBundledOriginalText } = await import("../kiosk-demo/knowledge");
	const bundled = getKioskBundledOriginalText(rel);
	if (bundled !== null) {
		await fs.writeBytes(webAdkOpfsPath(rel), new TextEncoder().encode(bundled));
	} else if (!(await restoreFromBundle(fs, [rel]))) {
		throw new Error("web_workspace_revert_failed");
	}
	return (await fs.readText(webAdkOpfsPath(rel))) ?? "";
}

/** 시연판 번들 파일(.agents/context, .users, naia-adk-reference)이 없으면 채운다. */
export async function ensureKioskAdkBundle(fs: WebFs = getWebFs()): Promise<void> {
	if (!isKioskDemo()) return;
	if (await fs.exists(webAdkOpfsPath(".agents/context/agents-rules.json"))) return;
	const result = await provisionWebAdk({ fs });
	if (!result.ok) Logger.debug("WebAdk", "kiosk bundle fill failed");
}

/** 방문 초기화: 손님이 고친 ADK 파일을 모두 원본으로 되돌린다. 실패해도 초기화는 계속한다. */
export async function restoreKioskAdkOriginals(
	fs: WebFs = getWebFs(),
): Promise<void> {
	if (!isKioskDemo()) return;
	const { writeKioskBundledOriginals } = await import("../kiosk-demo/knowledge");
	await writeKioskBundledOriginals(fs);
	try {
		await provisionWebAdk({ fs, force: true });
	} catch {
		Logger.debug("WebAdk", "kiosk bundle restore failed");
	}
}
