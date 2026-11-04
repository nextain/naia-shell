// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResilientVideo } from "../ResilientVideo";
vi.mock("../../lib/logger", () => ({ Logger: { warn: vi.fn() } }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("replaces a failed video with a still and leaves input usable without media teardown", async () => {
 vi.spyOn(HTMLMediaElement.prototype,"play").mockRejectedValue(new Error("appsink missing"));
 vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(() => {});
 const load = vi.spyOn(HTMLMediaElement.prototype,"load");
 const {container} = render(<><ResilientVideo src="broken.webm" autoPlay aria-label="Preview" /><input aria-label="Name" /></>);
 await act(async () => {});
 expect(container.querySelector("[data-media-fallback]")).toBeTruthy();
 expect(container.querySelector("video")?.getAttribute("src")).toBe("broken.webm");
 expect(load).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText("Name"),{target:{value:"Still typing"}});
 expect(screen.getByLabelText("Name")).toHaveValue("Still typing");
});
it("times out a silent decoder and clears its timer on unmount", async () => {
 vi.useFakeTimers();
 vi.spyOn(HTMLMediaElement.prototype,"play").mockImplementation(() => new Promise(() => {}));
 vi.spyOn(HTMLMediaElement.prototype,"pause").mockImplementation(() => {});
 const {container,unmount} = render(<ResilientVideo src="waiting.webm" autoPlay />);
 await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
 expect(container.querySelector("[data-media-fallback]")).toBeTruthy();
 unmount();
 expect(vi.getTimerCount()).toBe(0);
});
