import { describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
	CourseTargetInvalidError,
	CourseTargetNotReadyError,
	readJeonjuCourseTarget,
	saveJeonjuCourseTarget,
} from "../jeonju-course-target";

const target = {
	version: 1,
	workspacePath: "D:\\alpha-adk\\projects\\course-site",
	allowedFiles: ["index.html", "hero.svg"],
};

describe("Jeonju Discord course target bridge", () => {
	it("reads only the strict versioned target", async () => {
		invoke.mockResolvedValueOnce(JSON.stringify(target));

		await expect(readJeonjuCourseTarget("D:\\alpha-adk")).resolves.toEqual(target);
		expect(invoke).toHaveBeenCalledWith("read_jeonju_course_target", {
			adkPath: "D:\\alpha-adk",
		});
	});

	it("rejects an altered file boundary from persisted data", async () => {
		invoke.mockResolvedValueOnce(
			JSON.stringify({ ...target, allowedFiles: ["index.html", "secret.txt"] }),
		);

		await expect(readJeonjuCourseTarget("D:\\alpha-adk")).rejects.toBeInstanceOf(
			CourseTargetInvalidError,
		);
	});

	it("saves only the ADK root and selected Git root, never caller-supplied files", async () => {
		invoke.mockResolvedValueOnce(JSON.stringify(target));

		await expect(
			saveJeonjuCourseTarget(
				"D:\\alpha-adk",
				"D:\\alpha-adk\\projects\\course-site",
			),
		).resolves.toEqual(target);
		expect(invoke).toHaveBeenCalledWith("write_jeonju_course_target", {
			adkPath: "D:\\alpha-adk",
			workspacePath: "D:\\alpha-adk\\projects\\course-site",
		});
		expect(invoke.mock.calls[0]?.[1]).not.toHaveProperty("allowedFiles");
	});

	it("maps the narrow native readiness failure without revealing raw output", async () => {
		invoke.mockRejectedValueOnce("course_target_not_ready");

		await expect(
			saveJeonjuCourseTarget("D:\\alpha-adk", "D:\\outside"),
		).rejects.toBeInstanceOf(CourseTargetNotReadyError);
	});
});
