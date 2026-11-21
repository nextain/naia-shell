import { isKioskDemo } from "../kiosk-demo/flag";
import { WEB_ADK_PATH } from "./web-adk-path";

/**
 * 시연판 ADK 작업 공간의 열람·편집 허용 경로.
 * 허용 목록 방식이다. 목록에 없는 경로(naia-settings, conversations, .bundle, .undo …)는 열 수도 없다.
 */
export const KIOSK_ADK_ROOT_ORDER = [
	"AGENTS.md",
	"rules",
	"memory",
	"knowledge",
	".agents",
	".users",
	"naia-adk-reference",
	"slides",
] as const;
const ROOT_ALLOWED = new Set<string>(KIOSK_ADK_ROOT_ORDER);
/** 점으로 시작해도 보이는 최상위 폴더와 그 아래 허용 폴더. */
const DOT_ROOT_CHILDREN: Record<string, readonly string[]> = {
	".agents": ["context"],
	".users": [],
};

export const WEB_ADK_EDIT_MAX_BYTES = 256 * 1024;
const EDITABLE_EXT = /\.(md|json|ya?ml|txt|template)$/i;

/**
 * 실제 상위 디렉터리 구간(`..`)이 있는가. 파일명 안의 점(`photo..png`)은
 * 정상 이름이므로, `/`·`\` 로 나눈 조각 단위로만 판정한다. 문자열 포함
 * 검사(`includes("..")`)는 정상 파일을 오탐한다.
 */
export function hasParentDirectorySegment(path: string): boolean {
	return path.split(/[/\\]/).some((part) => part === "..");
}

/** OPFS에 항목이 없을 때의 DOM 오류인가. */
export function isNotFoundError(error: unknown): boolean {
	return (
		error instanceof DOMException &&
		(error.name === "NotFoundError" || error.name === "TypeMismatchError")
	);
}

/** 경로 이탈·빈 조각·역슬래시·널 문자가 있으면 null. */
export function splitWebAdkPath(path: string): string[] | null {
	if (!path.startsWith(`${WEB_ADK_PATH}/`)) return null;
	const parts = path.slice(WEB_ADK_PATH.length + 1).split("/");
	if (
		parts.some(
			(part) =>
				!part ||
				part === "." ||
				part === ".." ||
				part.includes("\\") ||
				part.includes("\0"),
		)
	)
		return null;
	return parts;
}

export function isKioskReadableParts(parts: readonly string[]): boolean {
	const [root, second] = parts;
	if (!root || !ROOT_ALLOWED.has(root)) return false;
	if (root === "AGENTS.md") return parts.length === 1;
	const dotChildren = DOT_ROOT_CHILDREN[root];
	if (dotChildren) {
		if (parts.length === 1) return true;
		if (root === ".agents" && !dotChildren.includes(second)) return false;
	}
	// 안쪽의 점 파일(.translate-state 등)은 열지 않는다.
	return parts.slice(1).every((part) => !part.startsWith("."));
}

export function isKioskEditableParts(parts: readonly string[]): boolean {
	if (!isKioskReadableParts(parts)) return false;
	const [root, second] = parts;
	const last = parts[parts.length - 1];
	if (!EDITABLE_EXT.test(last)) return false;
	if (root === "AGENTS.md") return parts.length === 1;
	if (root === "rules") return parts.length === 2 && /\.md$/i.test(last);
	if (root === "knowledge") {
		return parts.length === 2 && /\.md$/i.test(last);
	}
	if (root === ".agents") return second === "context" && parts.length === 3;
	if (root === ".users" || root === "naia-adk-reference") return parts.length >= 2;
	return false;
}

export function isKioskEditableWebAdkPath(path: string): boolean {
	if (!isKioskDemo()) return false;
	const parts = splitWebAdkPath(path);
	return parts !== null && isKioskEditableParts(parts);
}

/**
 * 사용자 자산 목록 조회에서 빈 목록으로 접을 수 있는 오류인가. 폴더가
 * 없을 때(NotFound)와 저장소 API 자체가 없을 때(TypeError)만 빈 목록으로
 * 처리한다. 권한·용량 등 나머지 오류는 호출자가 목록·선택을 보존하고
 * 원인을 표시할 수 있도록 그대로 전달한다.
 */
export function isBenignWebSettingsListError(error: unknown): boolean {
	if (
		error instanceof DOMException &&
		(error.name === "NotFoundError" || error.name === "TypeMismatchError")
	) {
		return true;
	}
	return (
		typeof navigator === "undefined" ||
		typeof navigator.storage?.getDirectory !== "function"
	);
}

/** 탐색기에 보이는 항목. parentPath 는 opfs://naia-adk[/...]. */
export function isKioskVisibleEntry(name: string, parentPath: string): boolean {
	if (!name) return false;
	if (parentPath === WEB_ADK_PATH) return ROOT_ALLOWED.has(name);
	const parent = splitWebAdkPath(`${parentPath}/${name}`);
	return parent !== null && isKioskReadableParts(parent);
}
