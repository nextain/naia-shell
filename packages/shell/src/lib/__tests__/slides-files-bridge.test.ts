// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { installSlidesFilesBridge } from "../slides-files-bridge";
import { SLIDES_FILES } from "../slides-files";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../logger", () => ({ Logger: { debug: vi.fn(), warn: vi.fn() } }));
let dispose: () => void = () => {};
beforeEach(() => {
	vi.mocked(invoke).mockReset();
	vi.mocked(listen).mockReset();
});
afterEach(() => {
	dispose();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});
function setup(
	entry = "C:/apps/land.naia.slides/index.html",
	load = true,
) {
	const frame = document.createElement("iframe");
	frame.src = "http://asset.localhost/C%3A/apps/land.naia.slides/index.html";
	document.body.append(frame);
	const reply = vi.fn();
	let activePort: MessagePort | null = null;
	let capability: string | null = null;
	const createProbePort = () => {
		const channel = new MessageChannel();
		activePort = channel.port1;
		activePort.addEventListener("message", (event) => {
			reply(event.data, "http://asset.localhost");
			if (event.data?.action === "available")
				capability = event.data.capability;
		});
		activePort.start();
		return channel.port2;
	};
	dispose = installSlidesFilesBridge(frame, entry);
	if (load) frame.dispatchEvent(new Event("load"));
	const send = (action: string, overrides: MessageEventInit = {}) => {
		const overrideData =
			typeof overrides.data === "object" && overrides.data !== null
				? overrides.data
				: {};
		const data = {
			type: SLIDES_FILES,
			action,
			id: "request-1",
			...(action !== "probe" && capability ? { capability } : {}),
			...overrideData,
		};
		if (action === "probe" || overrides.source || overrides.origin) {
			const port = action === "probe" ? createProbePort() : undefined;
			window.dispatchEvent(
				new MessageEvent("message", {
					...overrides,
					source: overrides.source ?? frame.contentWindow,
					origin: overrides.origin ?? "http://asset.localhost",
					data,
					...(port ? { ports: [port] } : {}),
				}),
			);
			return;
		}
		activePort?.postMessage(data);
	};
	const waitForCapability = () =>
		vi.waitFor(() => expect(capability).toEqual(expect.any(String)));
	return { frame, reply, send, waitForCapability };
}
describe("installed Slides picker bridge", () => {
	it("waits for the first document load before issuing a capability", async () => {
		const { frame, send, reply, waitForCapability } = setup(
			"C:/apps/land.naia.slides/index.html",
			false,
		);
		send("probe");
		expect(reply).not.toHaveBeenCalled();
		frame.dispatchEvent(new Event("load"));
		send("probe");
		await waitForCapability();
		expect(reply).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "available",
				capability: expect.any(String),
			}),
			"http://asset.localhost",
		);
	});
	it("advertises capability without reading files", async () => {
		const { send, reply, waitForCapability } = setup();
		send("probe");
		await waitForCapability();
		expect(reply).toHaveBeenCalledWith(
			expect.objectContaining({
				type: SLIDES_FILES,
				id: "request-1",
				action: "available",
				capability: expect.any(String),
			}),
			"http://asset.localhost",
		);
		expect(invoke).not.toHaveBeenCalled();
	});
	it("ignores other apps, foreign windows and origins", () => {
		const other = setup("C:/apps/other.app/index.html");
		other.send("open");
		expect(invoke).not.toHaveBeenCalled();
		dispose();
		const current = setup();
		current.send("open", { source: window });
		current.send("open", { origin: "https://attacker.invalid" });
		expect(invoke).not.toHaveBeenCalled();
	});
	it("returns native cancellation to its requesting frame", async () => {
		vi.mocked(invoke).mockResolvedValue(null);
		const { send, reply, waitForCapability } = setup();
		send("probe");
		await waitForCapability();
		send("open");
		await vi.waitFor(() =>
			expect(reply).toHaveBeenCalledWith(
				expect.objectContaining({ action: "result", selection: null }),
				"http://asset.localhost",
			),
		);
		expect(invoke).toHaveBeenCalledExactlyOnceWith(
			"slides_open_document",
			expect.objectContaining({ requestId: "request-1" }),
		);
	});
	it("forwards cancellation to the active native request", async () => {
		let resolve!: (value: unknown) => void;
		vi.mocked(invoke).mockImplementation(
			(command) =>
				command === "slides_open_document"
					? new Promise((r) => {
							resolve = r;
						})
					: Promise.resolve(),
		);
		const { send, waitForCapability } = setup();
		send("probe");
		await waitForCapability();
		send("open");
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"slides_open_document",
				expect.objectContaining({ requestId: "request-1" }),
			),
		);
		send("cancel");
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith("slides_cancel_open", {
				requestId: "request-1",
			}),
		);
		resolve(null);
	});
	it("refuses duplicate dialogs and drops results after disposal", async () => {
		let resolve!: (value: unknown) => void;
		vi.mocked(invoke).mockImplementation((command) =>
			command === "slides_open_document"
				? new Promise((r) => {
						resolve = r;
				  })
				: Promise.resolve(),
		);
		const { send, reply, waitForCapability } = setup();
		send("probe");
		await waitForCapability();
		send("open");
		send("open");
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
				"slides_open_document",
				expect.objectContaining({ requestId: "request-1" }),
			),
		);
		await vi.waitFor(() =>
			expect(reply).toHaveBeenCalledWith(
				expect.objectContaining({ error: "picker_busy" }),
				"http://asset.localhost",
			),
		);
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(reply).toHaveBeenCalledTimes(2);
		dispose();
		resolve(null);
		await Promise.resolve();
		expect(reply).toHaveBeenCalledTimes(2);
	});
	it("permanently revokes a replacement document and drops its late result", async () => {
		let resolve!: (value: unknown) => void;
		vi.mocked(invoke).mockImplementation((command) => {
			if (command === "slides_open_document") {
				return new Promise((r) => {
					resolve = r;
				});
			}
			return Promise.resolve();
		});
		const { frame, send, reply, waitForCapability } = setup();
		send("probe");
		await waitForCapability();
		const oldCapability = (reply.mock.lastCall?.[0] as { capability: string })
			.capability;
		send("open");
		await vi.waitFor(() =>
			expect(invoke).toHaveBeenCalledWith(
			"slides_open_document",
			expect.objectContaining({ requestId: "request-1" }),
		),
		);
		frame.dispatchEvent(new Event("load"));
		expect(invoke).toHaveBeenCalledWith("slides_cancel_open", {
			requestId: "request-1",
		});
		resolve(null);
		await Promise.resolve();
		expect(reply).not.toHaveBeenCalledWith(
			expect.objectContaining({ action: "result" }),
			expect.anything(),
		);
		const callsAfterLoad = reply.mock.calls.length;
		send("open", { data: { capability: oldCapability } });
		expect(invoke).toHaveBeenCalledTimes(2);
		expect(reply).toHaveBeenCalledTimes(callsAfterLoad);
		send("probe", { data: { id: "request-2" } });
		expect(reply).toHaveBeenCalledTimes(callsAfterLoad);
	});
	it("unlistens when disposal races native progress setup", async () => {
		let finishListen!: (stop: () => void) => void;
		const stop = vi.fn();
		vi.mocked(invoke).mockResolvedValue(null);
		vi.mocked(listen).mockReturnValue(
			new Promise((resolve) => {
				finishListen = () => resolve(stop);
			}) as ReturnType<typeof listen>,
		);
		Object.defineProperty(window, "__TAURI_INTERNALS__", {
			value: {},
			configurable: true,
		});
		const { send, waitForCapability } = setup();
		send("probe");
		await waitForCapability();
		send("open");
		await vi.waitFor(() => expect(listen).toHaveBeenCalled());
		dispose();
		finishListen(stop);
		await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
		expect(invoke).toHaveBeenCalledWith("slides_cancel_open", {
			requestId: "request-1",
		});
		expect(invoke).not.toHaveBeenCalledWith(
			"slides_open_document",
			expect.anything(),
		);
	});
	it("accepts only the first probe for each loaded document", async () => {
		const { send, reply, waitForCapability } = setup();
		send("probe");
		await waitForCapability();
		const count = reply.mock.calls.length;
		send("probe", { data: { id: "request-2" } });
		expect(reply).toHaveBeenCalledTimes(count);
	});
});
