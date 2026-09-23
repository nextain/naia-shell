import { type Page, expect, test } from "@playwright/test";
import {
	SEED_ADK_PATH,
	TAURI_BASE_MOCK_FALLBACK,
} from "./helpers/tauri-base-mock";

/**
 * #687 E2E: Agent open-file edit exception (Luke 2026-09-22 「쓰기 가능하게 해줘」).
 *
 * Tests the in-editor approval flow for skill_workspace_edit_open_file:
 * - Agent proposes edits only to currently open file
 * - In-editor diff review region appears with countdown timer
 * - Approving writes to disk and applies edit
 * - Rejecting leaves disk untouched
 * - Stale base disk content rejects write
 * - Sensitive paths are denied
 * - Both buttons remain visible in narrow viewport
 * - No writes occur until explicit user approval
 * Note: the tool is tier: 0, so the agent never sends approval_request;
 * the in-editor review is the only gate.
 */

const ROOT = "/tmp/mock-naia-adk-workspace";
const NEW_CORE_FLAG = "window.__NAIA_NEW_CORE__ = true;";

const MOCK_SCRIPT = `
(function () {
  window.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__ || {};
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = window.__TAURI_EVENT_PLUGIN_INTERNALS__ || {};
  window.__TAURI_INTERNALS__.metadata = {
    currentWindow: { label: "main" },
    currentWebview: { windowLabel: "main", label: "main" },
  };
  var callbacks = new Map(); var nextCbId = 1;
  window.__TAURI_INTERNALS__.transformCallback = function (fn, once) {
    var id = nextCbId++;
    callbacks.set(id, function (data) { if (once) callbacks.delete(id); return fn && fn(data); });
    return id;
  };
  window.__TAURI_INTERNALS__.unregisterCallback = function (id) { callbacks.delete(id); };
  window.__TAURI_INTERNALS__.runCallback = function (id, data) { var cb = callbacks.get(id); if (cb) cb(data); };
  var eventListeners = new Map();
  window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = function () {};
  function emitEvent(event, payload) {
    var hs = eventListeners.get(event) || [];
    for (var i = 0; i < hs.length; i++) window.__TAURI_INTERNALS__.runCallback(hs[i], { event: event, payload: payload });
  }
  window.__NAIA_E2E__ = { emitEvent: emitEvent };

  window.__E2E_FS__ = {
    "${ROOT}/notes.md": "line one\\nline two\\n",
    "${ROOT}/data-private/secret.md": "x",
  };
  window.__E2E_WRITES__ = [];
  window.__E2E_OUTBOUND__ = [];
  window.__E2E_SCRIPT__ = [];

  function simpleSha(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return "sha-" + str.length + "-" + Math.abs(hash);
  }

  var snapshot = {
    protocol: 19,
    version: "0.8.0",
    focused_workspace_id: "w1",
    focused_pane_id: "w1:p1",
    workspaces: [{ workspace_id: "w1", label: "Alpha", focused: true, pane_count: 1, tab_count: 1, worktree: { checkout_path: "${ROOT}", repo_name: "alpha" } }],
    agents: [{ workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1", agent: "codex", agent_status: "idle", cwd: "${ROOT}", foreground_cwd: "${ROOT}", focused: true, label: "Builder" }]
  };

  window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
    if (cmd === "plugin:event|listen") {
      if (!eventListeners.has(args.event)) eventListeners.set(args.event, []);
      eventListeners.get(args.event).push(args.handler);
      return args.handler;
    }
    if (cmd === "plugin:event|emit") { emitEvent(args.event, args.payload); return null; }
    if (cmd === "plugin:event|unlisten") return;

    if (cmd === "herdr_pty_create") return { pty_id: "pty-e2e", pid: 101 };
    if (cmd === "herdr_snapshot") return JSON.parse(JSON.stringify(snapshot));
    if (cmd === "workspace_set_root") return args.root || "${ROOT}";
    if (cmd === "workspace_detect_adk_root") return "${ROOT}";
    if (cmd === "workspace_list_dirs") return [];
    if (cmd === "workspace_register_open_file") return args.path;
    if (cmd === "workspace_resolve_file_location") return args.path;

    if (cmd === "workspace_file_size") {
      var content = window.__E2E_FS__[args.path];
      if (content === undefined) throw "no such file";
      return content.length;
    }
    if (cmd === "workspace_read_file") {
      var content = window.__E2E_FS__[args.path];
      if (content === undefined) throw "no such file";
      return content;
    }

    if (cmd === "workspace_agent_read_open_file") {
      if (args.path.indexOf("/data-private/") >= 0) {
        throw "denied: path is sensitive (denylisted)";
      }
      var content = window.__E2E_FS__[args.path];
      if (content === undefined) throw "no such file";
      return {
        path: args.path,
        content: content,
        sha256: simpleSha(content),
        size: content.length,
      };
    }

    if (cmd === "workspace_agent_write_open_file") {
      if (args.path.indexOf("/data-private/") >= 0) {
        throw "denied: path is sensitive (denylisted)";
      }
      var current = window.__E2E_FS__[args.path];
      if (current === undefined) throw "no such file";
      var currentSha = simpleSha(current);
      if (args.expectedSha256 && args.expectedSha256.toLowerCase() !== currentSha.toLowerCase()) {
        throw "stale: the file changed on disk after the preview";
      }
      window.__E2E_FS__[args.path] = args.content;
      window.__E2E_WRITES__.push({ path: args.path, content: args.content });
      return {
        path: args.path,
        content: args.content,
        sha256: simpleSha(args.content),
        size: args.content.length,
      };
    }

    if (cmd === "send_to_agent_command") {
      var payload = JSON.parse(args.message);
      window.__E2E_OUTBOUND__.push(payload);
      if (payload && payload.type === "chat_request") {
        var rid = payload.requestId;
        var turnScript = window.__E2E_SCRIPT__.shift() || [];
        var d = 100;
        for (var i = 0; i < turnScript.length; i++) {
          (function (chunk, delay) {
            setTimeout(function () {
              var c = Object.assign({}, chunk, { requestId: rid });
              emitEvent("agent_response", JSON.stringify(c));
            }, delay);
          })(turnScript[i], d);
          d += 150;
        }
      }
      return null;
    }

    if (cmd === "cancel_stream" || cmd === "send_approval_response") return null;
    return undefined; // Handled by TAURI_BASE_MOCK_FALLBACK
  };
})();
`;

function configScript(cfg: Record<string, unknown>): string {
	return `localStorage.setItem("naia-config", ${JSON.stringify(JSON.stringify(cfg))});`;
}

async function openWorkspaceApp(page: Page) {
	const tab = page.locator('button[data-app-id="workspace"]');
	await expect(tab).toBeVisible({ timeout: 10_000 });
	await tab.click();
	await expect(page.getByTestId("herdr-workspace")).toBeVisible();
}

async function sendChat(page: Page, text: string) {
	const input = page.locator(".chat-input");
	await expect(input).toBeEnabled({ timeout: 5_000 });
	await input.fill(text);
	await input.press("Enter");
}

async function getToolResult(page: Page, toolCallId: string) {
	return page.evaluate((id) => {
		const out =
			(window as unknown as { __E2E_OUTBOUND__?: Array<Record<string, unknown>> })
				.__E2E_OUTBOUND__ || [];
		const msg = out.find(
			(m) => m.type === "app_tool_result" && m.toolCallId === id,
		);
		if (!msg) return null;
		try {
			return JSON.parse(msg.result as string);
		} catch {
			return msg.result;
		}
	}, toolCallId);
}

test.describe("#687 Open File Edit E2E", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(NEW_CORE_FLAG);
		await page.addInitScript(MOCK_SCRIPT);
		await page.addInitScript({ content: TAURI_BASE_MOCK_FALLBACK });
		await page.addInitScript({ content: SEED_ADK_PATH });
		await page.addInitScript({
			content: configScript({
				provider: "gemini",
				model: "gemini-2.5-flash",
				apiKey: "e2e-mock-key",
				enableTools: true,
				locale: "ko",
				onboardingComplete: true,
			}),
		});
		await page.goto("/");
		await expect(page.locator(".chat-app")).toBeVisible({ timeout: 10_000 });
	});

	test("approve: click approve writes content, returns applied status, and dismisses review", async ({
		page,
	}) => {
		await openWorkspaceApp(page);
		await page.evaluate(
			({ root }) => {
				(window as any).__E2E_SCRIPT__ = [
					[
						{
							type: "app_tool_call",
							toolCallId: "tc-open-1",
							toolName: "skill_workspace_open_file",
							args: { path: `${root}/notes.md` },
						},
						{ type: "finish" },
					],
					[
						{
							type: "app_tool_call",
							toolCallId: "tc-edit-1",
							toolName: "skill_workspace_edit_open_file",
							args: {
								path: `${root}/notes.md`,
								oldText: "line two",
								newText: "line 2",
							},
						},
						{ type: "finish" },
					],
				];
			},
			{ root: ROOT },
		);

		await sendChat(page, "open notes");
		await expect(page.getByTestId("workspace-viewer")).toContainText(
			"line one",
			{ timeout: 10_000 },
		);

		await sendChat(page, "edit notes");
		const review = page.getByTestId("open-file-edit-review");
		await expect(review).toBeVisible();

		const countdown = page.getByTestId("open-file-edit-countdown");
		await expect(countdown).toBeVisible();
		await expect(countdown).toContainText(/\d+/);

		const diff = page.getByTestId("open-file-edit-diff");
		await expect(diff).toContainText("- line two");
		await expect(diff).toContainText("+ line 2");

		const approveBtn = page.getByTestId("open-file-edit-approve");
		await approveBtn.click();

		await expect(review).not.toBeVisible();
		await expect(page.getByTestId("workspace-viewer")).toContainText("line 2");

		await expect
			.poll(async () => {
				const writes = await page.evaluate(
					() => (window as any).__E2E_WRITES__,
				);
				return writes?.length;
			})
			.toBe(1);

		const writes = await page.evaluate(
			() => (window as any).__E2E_WRITES__,
		);
		expect(writes[0].content).toBe("line one\nline 2\n");

		await expect
			.poll(async () => getToolResult(page, "tc-edit-1"))
			.not.toBeNull();
		const result = await getToolResult(page, "tc-edit-1");
		expect(result.status).toBe("applied");
	});

	test("reject: click reject leaves file unchanged and returns rejected status", async ({
		page,
	}) => {
		await openWorkspaceApp(page);
		await page.evaluate(
			({ root }) => {
				(window as any).__E2E_SCRIPT__ = [
					[
						{
							type: "app_tool_call",
							toolCallId: "tc-open-2",
							toolName: "skill_workspace_open_file",
							args: { path: `${root}/notes.md` },
						},
						{ type: "finish" },
					],
					[
						{
							type: "app_tool_call",
							toolCallId: "tc-edit-2",
							toolName: "skill_workspace_edit_open_file",
							args: {
								path: `${root}/notes.md`,
								oldText: "line two",
								newText: "line 2",
							},
						},
						{ type: "finish" },
					],
				];
			},
			{ root: ROOT },
		);

		await sendChat(page, "open notes");
		await expect(page.getByTestId("workspace-viewer")).toContainText(
			"line one",
			{ timeout: 10_000 },
		);

		await sendChat(page, "edit notes");
		const review = page.getByTestId("open-file-edit-review");
		await expect(review).toBeVisible();

		const rejectBtn = page.getByTestId("open-file-edit-reject");
		await rejectBtn.click();

		await expect(review).not.toBeVisible();

		const writes = await page.evaluate(
			() => (window as any).__E2E_WRITES__,
		);
		expect(writes.length).toBe(0);

		await expect
			.poll(async () => getToolResult(page, "tc-edit-2"))
			.not.toBeNull();
		const result = await getToolResult(page, "tc-edit-2");
		expect(result.status).toBe("rejected");
	});

	test("stale base: modified file on disk rejects write with stale status", async ({
		page,
	}) => {
		await openWorkspaceApp(page);
		await page.evaluate(
			({ root }) => {
				(window as any).__E2E_SCRIPT__ = [
					[
						{
							type: "app_tool_call",
							toolCallId: "tc-open-3",
							toolName: "skill_workspace_open_file",
							args: { path: `${root}/notes.md` },
						},
						{ type: "finish" },
					],
					[
						{
							type: "app_tool_call",
							toolCallId: "tc-edit-3",
							toolName: "skill_workspace_edit_open_file",
							args: {
								path: `${root}/notes.md`,
								oldText: "line two",
								newText: "line 2",
							},
						},
						{ type: "finish" },
					],
				];
			},
			{ root: ROOT },
		);

		await sendChat(page, "open notes");
		await expect(page.getByTestId("workspace-viewer")).toContainText(
			"line one",
			{ timeout: 10_000 },
		);

		await sendChat(page, "edit notes");
		const review = page.getByTestId("open-file-edit-review");
		await expect(review).toBeVisible();

		// Mutate disk in memory FS before approving
		await page.evaluate(
			({ root }) => {
				(window as any).__E2E_FS__[`${root}/notes.md`] =
					"modified on disk\n";
			},
			{ root: ROOT },
		);

		const approveBtn = page.getByTestId("open-file-edit-approve");
		await approveBtn.click();

		await expect
			.poll(async () => getToolResult(page, "tc-edit-3"))
			.not.toBeNull();
		const result = await getToolResult(page, "tc-edit-3");
		expect(result.status).toBe("stale");

		const writes = await page.evaluate(
			() => (window as any).__E2E_WRITES__,
		);
		expect(writes.length).toBe(0);
	});

	test("sensitive path: opening/editing sensitive path returns denied status without review", async ({
		page,
	}) => {
		await openWorkspaceApp(page);
		await page.evaluate(
			({ root }) => {
				(window as any).__E2E_SCRIPT__ = [
					[
						{
							type: "app_tool_call",
							toolCallId: "tc-open-4",
							toolName: "skill_workspace_open_file",
							args: { path: `${root}/data-private/secret.md` },
						},
						{ type: "finish" },
					],
					[
						{
							type: "app_tool_call",
							toolCallId: "tc-edit-4",
							toolName: "skill_workspace_edit_open_file",
							args: {
								path: `${root}/data-private/secret.md`,
								content: "overwrite attempt",
							},
						},
						{ type: "finish" },
					],
				];
			},
			{ root: ROOT },
		);

		await sendChat(page, "open secret");
		await sendChat(page, "edit secret");

		await expect
			.poll(async () => getToolResult(page, "tc-edit-4"))
			.not.toBeNull();
		const result = await getToolResult(page, "tc-edit-4");
		expect(result.status).toBe("denied");

		await expect(page.getByTestId("open-file-edit-review")).not.toBeVisible();
	});

	test("narrow width: review panel, countdown and both buttons stay inside the viewer at 900px", async ({
		page,
	}) => {
		await openWorkspaceApp(page);
		await page.setViewportSize({ width: 900, height: 700 });
		await page.evaluate(
			({ root }) => {
				(window as any).__E2E_SCRIPT__ = [
					[
						{
							type: "app_tool_call",
							toolCallId: "tc-open-5",
							toolName: "skill_workspace_open_file",
							args: { path: `${root}/notes.md` },
						},
						{ type: "finish" },
					],
					[
						{
							type: "app_tool_call",
							toolCallId: "tc-edit-5",
							toolName: "skill_workspace_edit_open_file",
							args: {
								path: `${root}/notes.md`,
								oldText: "line two",
								newText: "line 2",
							},
						},
						{ type: "finish" },
					],
				];
			},
			{ root: ROOT },
		);

		await sendChat(page, "open notes");
		await expect(page.getByTestId("workspace-viewer")).toContainText(
			"line one",
			{ timeout: 10_000 },
		);

		await sendChat(page, "edit notes");
		const review = page.getByTestId("open-file-edit-review");
		await expect(review).toBeVisible();

		const countdown = page.getByTestId("open-file-edit-countdown");
		await expect(countdown).toBeVisible();

		const approveBtn = page.getByTestId("open-file-edit-approve");
		const rejectBtn = page.getByTestId("open-file-edit-reject");
		await expect(approveBtn).toBeVisible();
		await expect(rejectBtn).toBeVisible();

		const viewerBox = await page.getByTestId("workspace-viewer").boundingBox();
		expect(viewerBox).not.toBeNull();
		expect(viewerBox!.width).toBeGreaterThanOrEqual(200);

		const reviewBox = await review.boundingBox();
		const countdownBox = await countdown.boundingBox();
		const approveBox = await approveBtn.boundingBox();
		const rejectBox = await rejectBtn.boundingBox();

		expect(reviewBox).not.toBeNull();
		expect(countdownBox).not.toBeNull();
		expect(approveBox).not.toBeNull();
		expect(rejectBox).not.toBeNull();

		for (const box of [reviewBox!, countdownBox!, approveBox!, rejectBox!]) {
			expect(box.x).toBeGreaterThanOrEqual(viewerBox!.x - 1);
			expect(box.x + box.width).toBeLessThanOrEqual(
				viewerBox!.x + viewerBox!.width + 1,
			);
		}

		await rejectBtn.click();
		await expect(review).not.toBeVisible();
	});

	test("no writes occur while review is pending until approve is clicked", async ({
		page,
	}) => {
		await openWorkspaceApp(page);
		await page.evaluate(
			({ root }) => {
				(window as any).__E2E_SCRIPT__ = [
					[
						{
							type: "app_tool_call",
							toolCallId: "tc-open-6",
							toolName: "skill_workspace_open_file",
							args: { path: `${root}/notes.md` },
						},
						{ type: "finish" },
					],
					[
						{
							type: "app_tool_call",
							toolCallId: "tc-edit-6",
							toolName: "skill_workspace_edit_open_file",
							args: {
								path: `${root}/notes.md`,
								oldText: "line two",
								newText: "line 2",
							},
						},
						{ type: "finish" },
					],
				];
			},
			{ root: ROOT },
		);

		await sendChat(page, "open notes");
		await expect(page.getByTestId("workspace-viewer")).toContainText(
			"line one",
			{ timeout: 10_000 },
		);

		await sendChat(page, "edit notes");
		const review = page.getByTestId("open-file-edit-review");
		await expect(review).toBeVisible();

		const writesBefore = await page.evaluate(
			() => (window as any).__E2E_WRITES__.length,
		);
		expect(writesBefore).toBe(0);

		const approveBtn = page.getByTestId("open-file-edit-approve");
		await approveBtn.click();

		await expect
			.poll(async () => {
				return page.evaluate(() => (window as any).__E2E_WRITES__.length);
			})
			.toBe(1);
	});
});
