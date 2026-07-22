import { invoke } from "@tauri-apps/api/core";

export const JEONJU_COURSE_TARGET_VERSION = 1 as const;
export const JEONJU_COURSE_ALLOWED_FILES = ["index.html", "hero.svg"] as const;

export interface JeonjuCourseTarget {
	version: typeof JEONJU_COURSE_TARGET_VERSION;
	workspacePath: string;
	allowedFiles: readonly (typeof JEONJU_COURSE_ALLOWED_FILES)[number][];
}

export class CourseTargetNotReadyError extends Error {
	constructor() {
		super("The selected Discord course target is not ready.");
		this.name = "CourseTargetNotReadyError";
	}
}

export class CourseTargetInvalidError extends Error {
	constructor() {
		super("The saved Discord course target is invalid.");
		this.name = "CourseTargetInvalidError";
	}
}

function parseTarget(value: unknown): JeonjuCourseTarget {
	if (!value || typeof value !== "object") throw new CourseTargetInvalidError();
	const candidate = value as Record<string, unknown>;
	const expectedFiles = [...JEONJU_COURSE_ALLOWED_FILES];
	if (
		candidate.version !== JEONJU_COURSE_TARGET_VERSION ||
		typeof candidate.workspacePath !== "string" ||
		candidate.workspacePath.trim().length === 0 ||
		!Array.isArray(candidate.allowedFiles) ||
		candidate.allowedFiles.length !== expectedFiles.length ||
		candidate.allowedFiles.some((file, index) => file !== expectedFiles[index]) ||
		Object.keys(candidate).length !== 3
	) {
		throw new CourseTargetInvalidError();
	}
	return {
		version: JEONJU_COURSE_TARGET_VERSION,
		workspacePath: candidate.workspacePath,
		allowedFiles: JEONJU_COURSE_ALLOWED_FILES,
	};
}

function mapTargetError(error: unknown): never {
	const message = String(error);
	if (message.includes("course_target_not_ready")) {
		throw new CourseTargetNotReadyError();
	}
	throw new CourseTargetInvalidError();
}

/** Reads the strict target saved under the active ADK control root. */
export async function readJeonjuCourseTarget(
	adkPath: string,
): Promise<JeonjuCourseTarget | null> {
	try {
		const json = await invoke<string>("read_jeonju_course_target", { adkPath });
		return json ? parseTarget(JSON.parse(json)) : null;
	} catch (error) {
		return mapTargetError(error);
	}
}

/**
 * The caller can provide only the Git root. Rust persists the version and
 * fixed file boundary, which keeps this path separate from chat/Discord data.
 */
export async function saveJeonjuCourseTarget(
	adkPath: string,
	workspacePath: string,
): Promise<JeonjuCourseTarget> {
	try {
		const json = await invoke<string>("write_jeonju_course_target", {
			adkPath,
			workspacePath,
		});
		return parseTarget(JSON.parse(json));
	} catch (error) {
		return mapTargetError(error);
	}
}
