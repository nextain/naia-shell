// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NaiaContextBridge } from "../../lib/app-registry";
import { installSlidesHostBridge } from "../../lib/slides-host-bridge";
import { createGenericInstalledApp } from "../generic-installed/GenericInstalledApp";

vi.mock("../../lib/slides-host-bridge", () => ({
	installSlidesHostBridge: vi.fn(() => vi.fn()),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
	convertFileSrc: (path: string) =>
		`asset://localhost/${encodeURIComponent(path)}`,
}));
afterEach(cleanup);

describe("installed app permission boundary", () => {
 it("rejects an iframe ask without permission and returns the error to that frame", () => {
  const App = createGenericInstalledApp("/apps/example/index.html", [], "example.app", []);
  render(<App naia={{} as NaiaContextBridge} />);
  const frame = screen.getByTitle("App") as HTMLIFrameElement;
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  const ask = vi.fn(); window.addEventListener("naia:installed-app:ask", ask);
  window.dispatchEvent(new MessageEvent("message", {source: frame.contentWindow, origin: "http://asset.localhost", data: {type: "naia-app:ask", appId: "example.app", id: "req", prompt: "hello"}}));
  expect(ask).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledWith({type: "naia-app:response", id: "req", text: "", error: "permission_denied"}, "http://asset.localhost");
  window.removeEventListener("naia:installed-app:ask", ask);
 });
});

describe("installed Slides fullscreen delegation", () => {
	it("binds the host bridge to the exact converted frame URL", async () => {
		const entry = "C:/apps/land.naia.slides/index.html";
		const App = createGenericInstalledApp(entry);
		render(<App naia={{} as NaiaContextBridge} />);

		await waitFor(() =>
			expect(installSlidesHostBridge).toHaveBeenCalledWith(
				expect.any(HTMLIFrameElement),
				entry,
				{
					expectedFrameSrc: `http://asset.localhost/${encodeURIComponent(entry)}`,
				},
			),
		);
		expect(screen.getByTitle("App")).toHaveAttribute(
			"src",
			`http://asset.localhost/${encodeURIComponent(entry)}`,
		);
	});

	it.each([
		"C:/apps/land.naia.slides/index.html",
		"C:\\apps\\land.naia.slides\\index.html",
	])("allows only the Slides entry %s", (entry) => {
		const App = createGenericInstalledApp(entry);
		render(<App naia={{} as NaiaContextBridge} />);
		expect(screen.getByTitle("App")).toHaveAttribute("allowfullscreen");
		expect(screen.getByTitle("App")).toHaveAttribute(
			"sandbox",
			"allow-scripts allow-same-origin allow-downloads allow-modals",
		);
	});
	it.each([
		"C:/apps/another/index.html",
		"C:/apps/land.naia.slides-copy/index.html",
		"C:/apps/land.naia.slides/other.html",
		"https://attacker.invalid/land.naia.slides/index.html",
	])("does not delegate for %s", (entry) => {
		const App = createGenericInstalledApp(entry);
		render(<App naia={{} as NaiaContextBridge} />);
		expect(screen.getByTitle("App")).not.toHaveAttribute("allowfullscreen");
		expect(screen.getByTitle("App")).toHaveAttribute(
			"sandbox",
			"allow-scripts allow-same-origin",
		);
	});
});
