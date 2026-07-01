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
	AppContext,
	ToolHandler,
} from "../../lib/app-registry";
import { appRegistry } from "../../lib/app-registry";

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
	public contexts: AppContext[] = [];
	private handlers = new Map<string, ToolHandler>();

	pushContext(ctx: AppContext): void {
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
	queryBehavior(): Promise<import("../../lib/app-registry").BehaviorEntry[]> {
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
	): Promise<import("../../lib/app-registry").ShellResult> {
		return Promise.resolve({ stdout: "", stderr: "", code: 0 });
	}
}

// ─── Tests: Panel Registry CRUD ──────────────────────────────────────────────

describe("Panel Registry", () => {
	let originalPanels: ReturnType<typeof appRegistry.list>;

	beforeEach(() => {
		// Snapshot current panels to restore later
		originalPanels = appRegistry.list();
	});

	afterEach(() => {
		// Restore registry state
		for (const p of appRegistry.list()) {
			if (!originalPanels.find((o) => o.id === p.id)) {
				appRegistry.unregister(p.id);
			}
		}
	});

	it("registers a panel and lists it", () => {
		const FakeCenterArea = () => <div />;
		appRegistry.register({
			id: "test-panel",
			name: "Test Panel",
			center: FakeCenterArea,
		});

		const found = appRegistry.list().find((p) => p.id === "test-panel");
		expect(found).toBeDefined();
		expect(found?.name).toBe("Test Panel");
	});

	it("unregisters a panel and removes it from list", () => {
		const FakeCenterArea = () => <div />;
		appRegistry.register({
			id: "test-panel-2",
			name: "Test Panel 2",
			center: FakeCenterArea,
		});

		appRegistry.unregister("test-panel-2");
		const found = appRegistry.list().find((p) => p.id === "test-panel-2");
		expect(found).toBeUndefined();
	});

	it("builtIn flag is preserved on registered panel", () => {
		const FakeCenterArea = () => <div />;
		appRegistry.register({
			id: "builtin-panel",
			name: "Built-in",
			builtIn: true,
			center: FakeCenterArea,
		});

		const found = appRegistry.list().find((p) => p.id === "builtin-panel");
		expect(found?.builtIn).toBe(true);
		appRegistry.unregister("builtin-panel");
	});

	it("non-builtIn panel has no builtIn flag", () => {
		const FakeCenterArea = () => <div />;
		appRegistry.register({
			id: "installed-panel",
			name: "Installed",
			center: FakeCenterArea,
		});

		const found = appRegistry.list().find((p) => p.id === "installed-panel");
		expect(found?.builtIn).toBeFalsy();
		appRegistry.unregister("installed-panel");
	});
});

// ─── Tests: Panel Registry API (updateApi / getApi) ──────────────────────────

describe("Panel Registry — API", () => {
	const FakeCenterArea = () => <div />;

	beforeEach(() => {
		appRegistry.register({
			id: "api-test-panel",
			name: "API Test",
			center: FakeCenterArea,
		});
	});

	afterEach(() => {
		appRegistry.unregister("api-test-panel");
	});

	it("getApi returns undefined before updateApi is called", () => {
		expect(appRegistry.getApi("api-test-panel")).toBeUndefined();
	});

	it("updateApi + getApi round-trip returns the registered api object", () => {
		const api = { doSomething: () => "result" };
		appRegistry.updateApi("api-test-panel", api);
		expect(appRegistry.getApi("api-test-panel")).toBe(api);
	});

	it("updateApi(id, undefined) clears the api — getApi returns undefined", () => {
		appRegistry.updateApi("api-test-panel", { fn: () => {} });
		appRegistry.updateApi("api-test-panel", undefined);
		expect(appRegistry.getApi("api-test-panel")).toBeUndefined();
	});

	it("getApi for unregistered panel returns undefined gracefully", () => {
		expect(appRegistry.getApi("nonexistent-panel")).toBeUndefined();
	});

	it("updateApi for unregistered panel is a silent no-op", () => {
		// Should not throw
		expect(() =>
			appRegistry.updateApi("nonexistent-panel", { fn: () => {} }),
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
		const { SampleNoteCenterArea } = await import(
			"../sample-note/SampleNoteCenterArea"
		);
		const bridge = new MockBridge();

		render(<SampleNoteCenterArea naia={bridge} />);

		await waitFor(() => {
			expect(bridge.hasHandler("skill_note_read")).toBe(true);
			expect(bridge.hasHandler("skill_note_write")).toBe(true);
		});
	});

	it("skill_note_read returns empty placeholder by default", async () => {
		const { SampleNoteCenterArea } = await import(
			"../sample-note/SampleNoteCenterArea"
		);
		const bridge = new MockBridge();

		render(<SampleNoteCenterArea naia={bridge} />);

		await waitFor(() => {
			expect(bridge.hasHandler("skill_note_read")).toBe(true);
		});

		const result = await bridge.callTool("skill_note_read", {});
		expect(result).toBe("(empty)");
	});

	it("skill_note_write updates note content", async () => {
		const { SampleNoteCenterArea } = await import(
			"../sample-note/SampleNoteCenterArea"
		);
		const bridge = new MockBridge();

		render(<SampleNoteCenterArea naia={bridge} />);

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
		const { SampleNoteCenterArea } = await import(
			"../sample-note/SampleNoteCenterArea"
		);
		const bridge = new MockBridge();

		render(<SampleNoteCenterArea naia={bridge} />);

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
		const { SampleNoteCenterArea } = await import(
			"../sample-note/SampleNoteCenterArea"
		);
		const bridge = new MockBridge();

		render(<SampleNoteCenterArea naia={bridge} />);

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
