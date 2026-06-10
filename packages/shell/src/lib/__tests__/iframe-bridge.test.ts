// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue("file-contents"),
}));

vi.mock("../behavior-log", () => ({
	logBehavior: vi.fn().mockResolvedValue(undefined),
	queryBehavior: vi.fn().mockResolvedValue([]),
}));

vi.mock("../secure-store", () => ({
	getSecretKey: vi.fn().mockResolvedValue("secret-value"),
	saveSecretKey: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../logger", () => ({
	Logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ALLOWED_ORIGIN = "http://asset.localhost";

/**
 * Send a fake postMessage to the bridge and capture what the bridge
 * sends back via source.postMessage(). Returns the response payload.
 */
async function sendBridgeMessage(
	msg: Record<string, unknown>,
	origin = ALLOWED_ORIGIN,
	source: Window = window,
): Promise<{ id: string; result?: unknown; error?: string }> {
	const spy = vi.spyOn(source, "postMessage");

	window.dispatchEvent(
		new MessageEvent("message", {
			data: msg,
			origin,
			source: source as unknown as MessageEventSource,
		}),
	);

	// handleMessage is async — wait for it to complete
	await new Promise((r) => setTimeout(r, 30));

	const call = spy.mock.calls.find(
		([data]) => (data as Record<string, unknown>)?.id === msg.id,
	);
	spy.mockRestore();

	if (!call) throw new Error(`Bridge did not respond to message ${msg.id}`);
	return call[0] as { id: string; result?: unknown; error?: string };
}

// ─── Tests: origin guard ──────────────────────────────────────────────────────

describe("iframe-bridge origin guard", () => {
	let stopBridge: () => void;

	beforeEach(async () => {
		vi.resetAllMocks();
		const { startIframeBridge } = await import("../iframe-bridge");
		stopBridge = startIframeBridge();
	});

	afterEach(() => {
		stopBridge?.();
		vi.resetModules();
	});

	it("ignores messages from disallowed origins", async () => {
		const { logBehavior } = await import("../behavior-log");
		const spy = vi.spyOn(window, "postMessage");

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "naia-bridge:logBehavior", id: "t1", event: "click" },
				origin: "http://evil.com",
				source: window as unknown as MessageEventSource,
			}),
		);
		await new Promise((r) => setTimeout(r, 30));

		expect(logBehavior).not.toHaveBeenCalled();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("ignores messages without naia-bridge: prefix", async () => {
		const { logBehavior } = await import("../behavior-log");
		const spy = vi.spyOn(window, "postMessage");

		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "some-other-msg", id: "t2" },
				origin: ALLOWED_ORIGIN,
				source: window as unknown as MessageEventSource,
			}),
		);
		await new Promise((r) => setTimeout(r, 30));

		expect(logBehavior).not.toHaveBeenCalled();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});

// ─── Tests: __unknown__ blocking ─────────────────────────────────────────────

describe("iframe-bridge __unknown__ panel blocking", () => {
	let stopBridge: () => void;

	beforeEach(async () => {
		vi.resetAllMocks();
		const { startIframeBridge } = await import("../iframe-bridge");
		stopBridge = startIframeBridge();
	});

	afterEach(() => {
		stopBridge?.();
		vi.resetModules();
	});

	it("blocks getSecret when panelId is __unknown__", async () => {
		const { getSecretKey } = await import("../secure-store");
		// No iframe in DOM → __unknown__
		const res = await sendBridgeMessage({
			type: "naia-bridge:getSecret",
			id: "t3",
			key: "myKey",
		});
		expect(getSecretKey).not.toHaveBeenCalled();
		expect(res.error).toContain("Panel identity could not be resolved");
	});

	it("blocks setSecret when panelId is __unknown__", async () => {
		const { saveSecretKey } = await import("../secure-store");
		const res = await sendBridgeMessage({
			type: "naia-bridge:setSecret",
			id: "t4",
			key: "k",
			value: "v",
		});
		expect(saveSecretKey).not.toHaveBeenCalled();
		expect(res.error).toContain("Panel identity could not be resolved");
	});

	it("blocks queryBehavior when panelId is __unknown__", async () => {
		const { queryBehavior } = await import("../behavior-log");
		const res = await sendBridgeMessage({
			type: "naia-bridge:queryBehavior",
			id: "t5",
		});
		expect(queryBehavior).not.toHaveBeenCalled();
		expect(res.error).toContain("Panel identity could not be resolved");
	});

	it("blocks logBehavior when panelId is __unknown__", async () => {
		const { logBehavior } = await import("../behavior-log");
		const res = await sendBridgeMessage({
			type: "naia-bridge:logBehavior",
			id: "t6",
			event: "click",
		});
		expect(logBehavior).not.toHaveBeenCalled();
		expect(res.error).toContain("Panel identity could not be resolved");
	});

	it("blocks readFile when panelId is __unknown__", async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		const res = await sendBridgeMessage({
			type: "naia-bridge:readFile",
			id: "t7",
			path: "/home/user/file.txt",
		});
		expect(invoke).not.toHaveBeenCalled();
		expect(res.error).toContain("Panel identity could not be resolved");
	});

	it("blocks runShell when panelId is __unknown__", async () => {
		const { invoke } = await import("@tauri-apps/api/core");
		const res = await sendBridgeMessage({
			type: "naia-bridge:runShell",
			id: "t8",
			cmd: "ls",
			args: [],
		});
		expect(invoke).not.toHaveBeenCalled();
		expect(res.error).toContain("Panel identity could not be resolved");
	});
});

// ─── Tests: input validation (with known panelId) ────────────────────────────

describe("iframe-bridge input validation", () => {
	let stopBridge: () => void;
	let iframe: HTMLIFrameElement;

	beforeEach(async () => {
		vi.resetAllMocks();
		// Register a fake iframe so panelIdFromSource resolves a panelId
		iframe = document.createElement("iframe");
		iframe.src =
			"http://asset.localhost/home/user/.naia/panels/my-panel/index.html";
		document.body.appendChild(iframe);

		const { startIframeBridge } = await import("../iframe-bridge");
		stopBridge = startIframeBridge();
	});

	afterEach(() => {
		stopBridge?.();
		document.body.removeChild(iframe);
		vi.resetModules();
	});

	it("getSecret rejects non-string key", async () => {
		const res = await sendBridgeMessage(
			{ type: "naia-bridge:getSecret", id: "t9", key: 123 },
			ALLOWED_ORIGIN,
			iframe.contentWindow ?? window,
		);
		expect(res.error).toContain("key must be a non-empty string");
	});

	it("setSecret rejects empty key", async () => {
		const res = await sendBridgeMessage(
			{ type: "naia-bridge:setSecret", id: "t10", key: "", value: "val" },
			ALLOWED_ORIGIN,
			iframe.contentWindow ?? window,
		);
		expect(res.error).toContain("key must be a non-empty string");
	});

	it("readFile rejects null path", async () => {
		const res = await sendBridgeMessage(
			{ type: "naia-bridge:readFile", id: "t11", path: null },
			ALLOWED_ORIGIN,
			iframe.contentWindow ?? window,
		);
		expect(res.error).toContain("path must be a non-empty string");
	});

	it("runShell rejects empty cmd", async () => {
		const res = await sendBridgeMessage(
			{ type: "naia-bridge:runShell", id: "t12", cmd: "", args: [] },
			ALLOWED_ORIGIN,
			iframe.contentWindow ?? window,
		);
		expect(res.error).toContain("cmd must be a non-empty string");
	});
});

// ─── Tests: panelId regex ────────────────────────────────────────────────────

describe("panelIdFromSource regex", () => {
	const re = /\/([^/]+)\/index\.html(?:[?#].*)?$/;

	it("extracts panelId from clean path", () => {
		expect(
			"http://asset.localhost/.naia/panels/my-panel/index.html".match(re)?.[1],
		).toBe("my-panel");
	});

	it("extracts panelId with query string", () => {
		expect(
			"http://asset.localhost/.naia/panels/my-panel/index.html?v=2".match(
				re,
			)?.[1],
		).toBe("my-panel");
	});

	it("extracts panelId with hash", () => {
		expect(
			"http://asset.localhost/.naia/panels/my-panel/index.html#section".match(
				re,
			)?.[1],
		).toBe("my-panel");
	});

	it("returns null for path without index.html", () => {
		expect(
			"http://asset.localhost/.naia/panels/my-panel/".match(re),
		).toBeNull();
	});
});
