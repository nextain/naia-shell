// @vitest-environment jsdom
/**
 * 워크스페이스 앱이 레지스트리에 무엇으로 등록되는지, 그리고 도구 목록에
 * 어떤 계약이 적혀 있는지.
 *
 * 이 케이스들은 2026-09-05 에 `apps/__tests__/workspace-area.test.tsx` 에서
 * 옮겨 왔다. 그 파일은 지운 `WorkspaceCenterArea` 를 그리느라 함께 지워야
 * 했지만, 여기서 재는 것은 살아 있는 `apps/workspace/index.tsx` 다 —
 * 등록 자체와 도구 서술자는 Herdr 통합 뒤에도 그대로다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_FACING_TOOL_KEEP_LIST } from "../../../lib/model-facing-tools";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async () => null),
}));

describe("Workspace app registry", () => {
	beforeEach(async () => {
		// index 를 불러야 등록이 일어난다.
		await import("../index");
	});

	it("registers workspace app as builtIn", async () => {
		const { appRegistry } = await import("../../../lib/app-registry");
		const app = appRegistry.get("workspace");

		expect(app).toBeDefined();
		expect(app?.builtIn).toBe(true);
		expect(app?.id).toBe("workspace");
	});

	it("workspace app exposes only keep-list tools (#611 + #687 exception)", async () => {
		const { WORKSPACE_TOOLS } = await import("../index");
		const keep = new Set(
			MODEL_FACING_TOOL_KEEP_LIST.filter((name) =>
				name.startsWith("skill_workspace_"),
			),
		);
		expect(WORKSPACE_TOOLS.map((t) => t.name).sort()).toEqual(
			[...keep].sort(),
		);
		for (const removed of [
			"skill_workspace_execute",
			"skill_workspace_focus_session",
			"skill_workspace_new_session",
			"skill_workspace_send_to_session",
			"skill_workspace_classify_dirs",
		]) {
			expect(WORKSPACE_TOOLS.some((t) => t.name === removed)).toBe(false);
		}
		const editTool = WORKSPACE_TOOLS.find(
			(t) => t.name === "skill_workspace_edit_open_file",
		);
		expect(editTool).toBeDefined();
		expect(editTool?.tier).toBe(0);
	});

	it("workspace app has skill_workspace_get_sessions tool", async () => {
		const { appRegistry } = await import("../../../lib/app-registry");
		const tool = appRegistry
			.get("workspace")
			?.tools?.find((t) => t.name === "skill_workspace_get_sessions");

		expect(tool).toBeDefined();
		expect(tool?.tier).toBe(0);
	});

	it("workspace app has skill_workspace_open_file tool", async () => {
		const { appRegistry } = await import("../../../lib/app-registry");
		const tool = appRegistry
			.get("workspace")
			?.tools?.find((t) => t.name === "skill_workspace_open_file");

		expect(tool).toBeDefined();
		expect(tool?.tier).toBe(1);
	});

	it("workspace app has onActivate and onDeactivate hooks", async () => {
		const { appRegistry } = await import("../../../lib/app-registry");
		const app = appRegistry.get("workspace");

		expect(typeof app?.onActivate).toBe("function");
		expect(typeof app?.onDeactivate).toBe("function");
	});
});
