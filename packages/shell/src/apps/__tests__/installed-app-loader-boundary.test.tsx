// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { loadInstalledApps } from "../../lib/app-loader";
import { appRegistry, type NaiaContextBridge } from "../../lib/app-registry";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

afterEach(() => {
  cleanup();
  appRegistry.unregister("boundary-test");
  vi.clearAllMocks();
});

describe("installed app loader bridge boundaries", () => {
  it("registers only the filtered tools on the rendered iframe bridge", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => command === "app_list_installed" ? [{
      id: "boundary-test", name: "Boundary", htmlEntry: "/apps/boundary/index.html",
      store_signature_verified: true,
      tools: [{ name: "skill_memory_save", description: "reserved" }, { name: "skill_boundary_allowed", description: "allowed" }],
    }] : true);
    await loadInstalledApps();
    const Center = appRegistry.get("boundary-test")!.center;
    const onToolCall = vi.fn((_name: string, _handler: unknown) => () => {});
    render(<Center naia={{ onToolCall } as unknown as NaiaContextBridge} />);
    expect(onToolCall.mock.calls.map((call) => call[0])).toEqual(["skill_boundary_allowed"]);
  });

  it("passes clipboard permission from the manifest and removes it after revocation", async () => {
    let permissions = ["clipboard.write"];
    vi.mocked(invoke).mockImplementation(async (command) => command === "app_list_installed" ? [{
      id: "boundary-test", name: "Boundary", htmlEntry: "/apps/boundary/index.html", permissions,
    }] : true);
    await loadInstalledApps();
    const Allowed = appRegistry.get("boundary-test")!.center;
    const view = render(<Allowed naia={{} as NaiaContextBridge} />);
    expect(screen.getByTitle("App").getAttribute("allow")).toBe("clipboard-write");
    permissions = [];
    await loadInstalledApps();
    const Denied = appRegistry.get("boundary-test")!.center;
    view.rerender(<Denied naia={{} as NaiaContextBridge} />);
    expect(screen.getByTitle("App").hasAttribute("allow")).toBe(false);
  });

  it("refreshes the app bridge when a permission is revoked", async () => {
    let permissions = ["model.ask"];
    vi.mocked(invoke).mockImplementation(async (command) => command === "app_list_installed" ? [{
      id: "boundary-test", name: "Boundary", htmlEntry: "/apps/boundary/index.html", permissions,
    }] : true);
    await loadInstalledApps();
    const before = appRegistry.get("boundary-test")!.center;
    permissions = [];
    await loadInstalledApps();
    const Center = appRegistry.get("boundary-test")!.center;
    expect(Center).not.toBe(before);
    render(<Center naia={{} as NaiaContextBridge} />);
    const frame = screen.getByTitle("App") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: "http://asset.localhost", data: { type: "naia-app:ask", appId: "boundary-test", id: "req", prompt: "hello" } }));
    expect(post).toHaveBeenCalledWith({ type: "naia-app:response", id: "req", text: "", error: "permission_denied" }, "http://asset.localhost");
  });
});
