// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	NaiaContextBridge,
	PanelContext,
	ToolHandler,
} from "../../lib/panel-registry";
import { panelRegistry } from "../../lib/panel-registry";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/logger", () => ({
	Logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// ─── Mock NaiaContextBridge ──────────────────────────────────────────────────

class MockBridge implements NaiaContextBridge {
	public contexts: PanelContext[] = [];
	private handlers = new Map<string, ToolHandler>();

	pushContext(ctx: PanelContext): void {
		this.contexts.push(ctx);
	}

	onToolCall(toolName: string, handler: ToolHandler): () => void {
		this.handlers.set(toolName, handler);
		return () => {
			this.handlers.delete(toolName);
		};
	}

	async callTool(
		toolName: string,
		args: Record<string, unknown>,
	): Promise<string> {
		const handler = this.handlers.get(toolName);
		if (!handler) return `No handler: ${toolName}`;
		const result = await handler(args);
		return result ?? "ok";
	}

	hasHandler(toolName: string): boolean {
		return this.handlers.has(toolName);
	}

	logBehavior(_event: string, _data?: Record<string, unknown>): Promise<void> {
		return Promise.resolve();
	}
	queryBehavior(): Promise<import("../../lib/panel-registry").BehaviorEntry[]> {
		return Promise.resolve([]);
	}
	getSecret(_key: string): Promise<string | null> {
		return Promise.resolve(null);
	}
	setSecret(_key: string, _value: string): Promise<void> {
		return Promise.resolve();
	}
	readFile(_path: string): Promise<string> {
		return Promise.resolve("");
	}
	runShell(
		_cmd: string,
		_args?: string[],
	): Promise<import("../../lib/panel-registry").ShellResult> {
		return Promise.resolve({ stdout: "", stderr: "", code: 0 });
	}
}

// ─── Tests: Panel Registry CRUD ──────────────────────────────────────────────

describe("Panel Registry", () => {
	let originalPanels: ReturnType<typeof panelRegistry.list>;

	beforeEach(() => {
		// Snapshot current panels to restore later
		originalPanels = panelRegistry.list();
	});

	afterEach(() => {
		// Restore registry state
		for (const p of panelRegistry.list()) {
			if (!originalPanels.find((o) => o.id === p.id)) {
				panelRegistry.unregister(p.id);
			}
		}
	});

	it("registers a panel and lists it", () => {
		const FakeCenterPanel = () => <div />;
		panelRegistry.register({
			id: "test-panel",
			name: "Test Panel",
			center: FakeCenterPanel,
		});

		const found = panelRegistry.list().find((p) => p.id === "test-panel");
		expect(found).toBeDefined();
		expect(found?.name).toBe("Test Panel");
	});

	it("unregisters a panel and removes it from list", () => {
		const FakeCenterPanel = () => <div />;
		panelRegistry.register({
			id: "test-panel-2",
			name: "Test Panel 2",
			center: FakeCenterPanel,
		});

		panelRegistry.unregister("test-panel-2");
		const found = panelRegistry.list().find((p) => p.id === "test-panel-2");
		expect(found).toBeUndefined();
	});

	it("builtIn flag is preserved on registered panel", () => {
		const FakeCenterPanel = () => <div />;
		panelRegistry.register({
			id: "builtin-panel",
			name: "Built-in",
			builtIn: true,
			center: FakeCenterPanel,
		});

		const found = panelRegistry.list().find((p) => p.id === "builtin-panel");
		expect(found?.builtIn).toBe(true);
		panelRegistry.unregister("builtin-panel");
	});

	it("non-builtIn panel has no builtIn flag", () => {
		const FakeCenterPanel = () => <div />;
		panelRegistry.register({
			id: "installed-panel",
			name: "Installed",
			center: FakeCenterPanel,
		});

		const found = panelRegistry.list().find((p) => p.id === "installed-panel");
		expect(found?.builtIn).toBeFalsy();
		panelRegistry.unregister("installed-panel");
	});
});

// ─── Tests: Panel Registry API (updateApi / getApi) ──────────────────────────

describe("Panel Registry — API", () => {
	const FakeCenterPanel = () => <div />;

	beforeEach(() => {
		panelRegistry.register({
			id: "api-test-panel",
			name: "API Test",
			center: FakeCenterPanel,
		});
	});

	afterEach(() => {
		panelRegistry.unregister("api-test-panel");
	});

	it("getApi returns undefined before updateApi is called", () => {
		expect(panelRegistry.getApi("api-test-panel")).toBeUndefined();
	});

	it("updateApi + getApi round-trip returns the registered api object", () => {
		const api = { doSomething: () => "result" };
		panelRegistry.updateApi("api-test-panel", api);
		expect(panelRegistry.getApi("api-test-panel")).toBe(api);
	});

	it("updateApi(id, undefined) clears the api — getApi returns undefined", () => {
		panelRegistry.updateApi("api-test-panel", { fn: () => {} });
		panelRegistry.updateApi("api-test-panel", undefined);
		expect(panelRegistry.getApi("api-test-panel")).toBeUndefined();
	});

	it("getApi for unregistered panel returns undefined gracefully", () => {
		expect(panelRegistry.getApi("nonexistent-panel")).toBeUndefined();
	});

	it("updateApi for unregistered panel is a silent no-op", () => {
		// Should not throw
		expect(() =>
			panelRegistry.updateApi("nonexistent-panel", { fn: () => {} }),
		).not.toThrow();
	});
});

// ─── Tests: SampleNote Panel Tools ───────────────────────────────────────────

describe("SampleNote Panel — tool interaction", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("registers skill_note_read and skill_note_write on mount", async () => {
		const { SampleNoteCenterPanel } = await import(
			"../sample-note/SampleNoteCenterPanel"
		);
		const bridge = new MockBridge();

		render(<SampleNoteCenterPanel naia={bridge} />);

		await waitFor(() => {
			expect(bridge.hasHandler("skill_note_read")).toBe(true);
			expect(bridge.hasHandler("skill_note_write")).toBe(true);
		});
	});

	it("skill_note_read returns empty placeholder by default", async () => {
		const { SampleNoteCenterPanel } = await import(
			"../sample-note/SampleNoteCenterPanel"
		);
		const bridge = new MockBridge();

		render(<SampleNoteCenterPanel naia={bridge} />);

		await waitFor(() => {
			expect(bridge.hasHandler("skill_note_read")).toBe(true);
		});

		const result = await bridge.callTool("skill_note_read", {});
		expect(result).toBe("(empty)");
	});

	it("skill_note_write updates note content", async () => {
		const { SampleNoteCenterPanel } = await import(
			"../sample-note/SampleNoteCenterPanel"
		);
		const bridge = new MockBridge();

		render(<SampleNoteCenterPanel naia={bridge} />);

		await waitFor(() => {
			expect(bridge.hasHandler("skill_note_write")).toBe(true);
		});

		const result = await bridge.callTool("skill_note_write", {
			content: "Hello from Naia!",
		});
		expect(result).toBe("Note updated");

		// Read back
		const readResult = await bridge.callTool("skill_note_read", {});
		expect(readResult).toBe("Hello from Naia!");
	});

	it("skill_note_write pushes context to bridge", async () => {
		const { SampleNoteCenterPanel } = await import(
			"../sample-note/SampleNoteCenterPanel"
		);
		const bridge = new MockBridge();

		render(<SampleNoteCenterPanel naia={bridge} />);

		await waitFor(() => {
			expect(bridge.hasHandler("skill_note_write")).toBe(true);
		});

		await bridge.callTool("skill_note_write", { content: "Context test" });

		const noteContexts = bridge.contexts.filter(
			(c) => c.type === "sample-note",
		);
		expect(noteContexts.length).toBeGreaterThan(0);
		const latest = noteContexts[noteContexts.length - 1];
		expect(latest.data.content).toBe("Context test");
	});

	it("textarea edit also updates content and pushes context", async () => {
		const { SampleNoteCenterPanel } = await import(
			"../sample-note/SampleNoteCenterPanel"
		);
		const bridge = new MockBridge();

		render(<SampleNoteCenterPanel naia={bridge} />);

		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "Typed by user" } });

		await waitFor(() => {
			const noteContexts = bridge.contexts.filter(
				(c) => c.type === "sample-note",
			);
			const latest = noteContexts[noteContexts.length - 1];
			expect(latest?.data.content).toBe("Typed by user");
		});
	});
});
