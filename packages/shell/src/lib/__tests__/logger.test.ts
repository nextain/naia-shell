import { describe, expect, it, vi } from "vitest";
import { Logger } from "../logger";

describe("Logger", () => {
	it("formats debug messages with component name", () => {
		const spy = vi
			.spyOn(globalThis.console, "debug")
			.mockImplementation(() => {});
		Logger.debug("TestComp", "test message");
		expect(spy).toHaveBeenCalledOnce();
		const msg = spy.mock.calls[0][0];
		expect(msg).toContain("[DEBUG]");
		expect(msg).toContain("[TestComp]");
		expect(msg).toContain("test message");
		spy.mockRestore();
	});

	it("formats info messages with component name", () => {
		const spy = vi
			.spyOn(globalThis.console, "info")
			.mockImplementation(() => {});
		Logger.info("VRM", "model loaded");
		expect(spy).toHaveBeenCalledOnce();
		const msg = spy.mock.calls[0][0];
		expect(msg).toContain("[INFO]");
		expect(msg).toContain("[VRM]");
		spy.mockRestore();
	});

	it("formats warn messages", () => {
		const spy = vi
			.spyOn(globalThis.console, "warn")
			.mockImplementation(() => {});
		Logger.warn("Avatar", "fallback used");
		expect(spy).toHaveBeenCalledOnce();
		const msg = spy.mock.calls[0][0];
		expect(msg).toContain("[WARN]");
		spy.mockRestore();
	});

	it("formats error messages", () => {
		const spy = vi
			.spyOn(globalThis.console, "error")
			.mockImplementation(() => {});
		Logger.error("Canvas", "render failed");
		expect(spy).toHaveBeenCalledOnce();
		const msg = spy.mock.calls[0][0];
		expect(msg).toContain("[ERROR]");
		spy.mockRestore();
	});

	it("includes data as JSON when provided", () => {
		const spy = vi
			.spyOn(globalThis.console, "info")
			.mockImplementation(() => {});
		Logger.info("Test", "with data", { key: "value" });
		const msg = spy.mock.calls[0][0];
		expect(msg).toContain('{"key":"value"}');
		spy.mockRestore();
	});

	it("includes ISO timestamp", () => {
		const spy = vi
			.spyOn(globalThis.console, "info")
			.mockImplementation(() => {});
		Logger.info("Test", "timestamp check");
		const msg = spy.mock.calls[0][0];
		expect(msg).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
		spy.mockRestore();
	});
});
