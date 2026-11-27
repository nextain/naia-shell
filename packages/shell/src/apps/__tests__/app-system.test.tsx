// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AppContext,
	NaiaContextBridge,
	ToolHandler,
} from "../../lib/app-registry";
import { appRegistry, shouldMountKeepAliveApp } from "../../lib/app-registry";

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

vi.mock("../../components/BgmPlayer", () => ({ BgmPlayer: () => null }));

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

// ─── Tests: App Registry CRUD ──────────────────────────────────────────────

describe("App Registry", () => {
	let originalApps: ReturnType<typeof appRegistry.list>;

	beforeEach(() => {
		// Snapshot current apps to restore later
		originalApps = appRegistry.list();
	});

	afterEach(() => {
		// Restore registry state
		for (const p of appRegistry.list()) {
			if (!originalApps.find((o) => o.id === p.id)) {
				appRegistry.unregister(p.id);
			}
		}
	});

	it("registers a app and lists it", () => {
		const FakeCenterArea = () => <div />;
		appRegistry.register({
			id: "test-app",
			name: "Test App",
			center: FakeCenterArea,
		});

		const found = appRegistry.list().find((p) => p.id === "test-app");
		expect(found).toBeDefined();
		expect(found?.name).toBe("Test App");
	});

	it("unregisters a app and removes it from list", () => {
		const FakeCenterArea = () => <div />;
		appRegistry.register({
			id: "test-app-2",
			name: "Test App 2",
			center: FakeCenterArea,
		});

		appRegistry.unregister("test-app-2");
		const found = appRegistry.list().find((p) => p.id === "test-app-2");
		expect(found).toBeUndefined();
	});

	it("builtIn flag is preserved on registered app", () => {
		const FakeCenterArea = () => <div />;
		appRegistry.register({
			id: "builtin-app",
			name: "Built-in",
			builtIn: true,
			center: FakeCenterArea,
		});

		const found = appRegistry.list().find((p) => p.id === "builtin-app");
		expect(found?.builtIn).toBe(true);
		appRegistry.unregister("builtin-app");
	});

	it("non-builtIn app has no builtIn flag", () => {
		const FakeCenterArea = () => <div />;
		appRegistry.register({
			id: "installed-app",
			name: "Installed",
			center: FakeCenterArea,
		});

		const found = appRegistry.list().find((p) => p.id === "installed-app");
		expect(found?.builtIn).toBeFalsy();
		appRegistry.unregister("installed-app");
	});

	it("defers a keep-alive app only until its first activation", () => {
		const descriptor = {
			id: "deferred-app",
			name: "Deferred",
			keepAlive: true,
			deferMountUntilActive: true,
			center: () => <div />,
		};
		const activated = new Set<string>();

		expect(shouldMountKeepAliveApp(descriptor, activated)).toBe(false);
		activated.add(descriptor.id);
		expect(shouldMountKeepAliveApp(descriptor, activated)).toBe(true);
		activated.add("another-app");
		expect(shouldMountKeepAliveApp(descriptor, activated)).toBe(true);
		expect(
			shouldMountKeepAliveApp(descriptor, activated, new Set([descriptor.id])),
		).toBe(false);
	});
});

// ─── Tests: App Registry API (updateApi / getApi) ──────────────────────────

describe("App Registry — API", () => {
	const FakeCenterArea = () => <div />;

	beforeEach(() => {
		appRegistry.register({
			id: "api-test-app",
			name: "API Test",
			center: FakeCenterArea,
		});
	});

	afterEach(() => {
		appRegistry.unregister("api-test-app");
	});

	it("getApi returns undefined before updateApi is called", () => {
		expect(appRegistry.getApi("api-test-app")).toBeUndefined();
	});

	it("updateApi + getApi round-trip returns the registered api object", () => {
		const api = { doSomething: () => "result" };
		appRegistry.updateApi("api-test-app", api);
		expect(appRegistry.getApi("api-test-app")).toBe(api);
	});

	it("updateApi(id, undefined) clears the api — getApi returns undefined", () => {
		appRegistry.updateApi("api-test-app", { fn: () => {} });
		appRegistry.updateApi("api-test-app", undefined);
		expect(appRegistry.getApi("api-test-app")).toBeUndefined();
	});

	it("getApi for unregistered app returns undefined gracefully", () => {
		expect(appRegistry.getApi("nonexistent-app")).toBeUndefined();
	});

	it("updateApi for unregistered app is a silent no-op", () => {
		// Should not throw
		expect(() =>
			appRegistry.updateApi("nonexistent-app", { fn: () => {} }),
		).not.toThrow();
	});
});

// ─── Tests: SampleNote App Tools ───────────────────────────────────────────

describe("SampleNote App — tool interaction", () => {
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

describe("built-in app names", () => {
	it("renders Korean, English and Japanese app titles in the app bar", async () => {
		const { AppBar } = await import("../../components/AppBar");
		const { getLocale, setLocale } = await import("../../lib/i18n");
		const { syncKioskSlidesAppRegistration } = await import("../slides");
		await import("../browser");
		await import("../workspace");
		await import("../settings");
		const previousLocale = getLocale();
		const slidesId = "land.naia.slides";
		const previousSlides = appRegistry.get(slidesId);
		vi.stubEnv("MODE", "web");
		vi.stubEnv("VITE_NAIA_KIOSK_DEMO", "1");
		try {
			syncKioskSlidesAppRegistration();
		} finally {
			vi.unstubAllEnvs();
		}

		try {
			await setLocale("ko");
			const { container } = render(<AppBar />);
			const ids = ["workspace", "browser", "settings", slidesId];
			const buttons = ids.map((id) =>
				container.querySelector<HTMLButtonElement>(
					id === "settings" ? ".app-bar-settings" : `button[data-app-id="${id}"]`,
				),
			);
			const namesByLocale = [
				["ko", ["작업공간", "브라우저", "설정", "슬라이드"]],
				["en", ["Workspace", "Browser", "Settings", "Slides"]],
				["ja", ["ワークスペース", "ブラウザ", "設定", "スライド"]],
			] as const;

			for (const [locale, expected] of namesByLocale) {
				await act(async () => {
					await setLocale(locale);
					window.dispatchEvent(new CustomEvent("naia:locale-change", { detail: locale }));
				});
				expect(buttons.map((button) => button?.title), locale).toEqual(expected);
				expect(ids.map((id) => appRegistry.get(id)?.name), locale).toEqual(expected);
			}
		} finally {
			cleanup();
			if (!previousSlides) appRegistry.unregister(slidesId);
			await setLocale(previousLocale);
		}
	});
});
