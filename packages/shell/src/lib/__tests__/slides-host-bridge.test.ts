// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SLIDES_HOST,
	SLIDES_HOST_ACTIONS,
	type SlidesHostState,
} from "../slides-host";
import { installSlidesHostBridge } from "../slides-host-bridge";

vi.mock("../logger", () => ({ Logger: { warn: vi.fn() } }));

const ENTRY = "C:/apps/land.naia.slides/index.html";
const FRAME_SRC =
	"http://asset.localhost/C%3A%2Fapps%2Fland.naia.slides%2Findex.html";
const ORIGIN = "http://asset.localhost";

let dispose: () => void = () => {};

function setup(
	overrides: {
		state?: SlidesHostState;
		start?: () => Promise<void>;
		stop?: () => Promise<string>;
	} = {},
) {
	const frame = document.createElement("iframe");
	frame.src = FRAME_SRC;
	document.body.append(frame);
	const reply = vi.spyOn(frame.contentWindow!, "postMessage");
	let state = overrides.state ?? {
		locale: "en",
		theme: { "--bg-primary": "#faf8f2" },
	};
	dispose = installSlidesHostBridge(frame, ENTRY, {
		expectedFrameSrc: FRAME_SRC,
		getState: () => state,
		startRecording: overrides.start,
		stopRecording: overrides.stop,
	});
	frame.dispatchEvent(new Event("load"));
	let capability: string | undefined;
	const send = (
		action: string,
		id = "request-1",
		init: MessageEventInit = {},
	) => {
		const dispatched = window.dispatchEvent(
			new MessageEvent("message", {
				source: frame.contentWindow,
				origin: ORIGIN,
				data: {
					type: SLIDES_HOST,
					action,
					id,
					...(action !== SLIDES_HOST_ACTIONS.hello && capability
						? { capability }
						: {}),
				},
				...init,
			}),
		);
		if (action === SLIDES_HOST_ACTIONS.hello) {
			const message = reply.mock.calls.at(-1)?.[0] as
				| { capability?: unknown }
				| undefined;
			if (typeof message?.capability === "string")
				capability = message.capability;
		}
		return dispatched;
	};
	return {
		frame,
		reply,
		send,
		dispose,
		setState(next: SlidesHostState) {
			state = next;
		},
	};
}

afterEach(() => {
	dispose();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("installed Slides host bridge", () => {
	it("requires the exact convertFileSrc URL and exact frame/origin source", () => {
		const frame = document.createElement("iframe");
		frame.src = FRAME_SRC;
		document.body.append(frame);
		const reply = vi.spyOn(frame.contentWindow!, "postMessage");
		const noBridge = installSlidesHostBridge(frame, ENTRY, {
			expectedFrameSrc: `${FRAME_SRC}?different-entry`,
		});
		window.dispatchEvent(
			new MessageEvent("message", {
				source: frame.contentWindow,
				origin: ORIGIN,
				data: {
					type: SLIDES_HOST,
					action: SLIDES_HOST_ACTIONS.hello,
					id: "hello",
				},
			}),
		);
		expect(reply).not.toHaveBeenCalled();
		noBridge();
	});

	it("drops messages after same-origin navigation changes the exact frame URL", () => {
		const host = setup();
		host.send(SLIDES_HOST_ACTIONS.hello, "first-document");
		host.reply.mockClear();
		// A document navigation can preserve both iframe.src and WindowProxy.
		expect(host.frame.src).toBe(FRAME_SRC);
		host.frame.dispatchEvent(new Event("load"));
		host.send(SLIDES_HOST_ACTIONS.hello, "after-navigation");
		window.dispatchEvent(new Event("naia:locale-change"));
		expect(host.reply).not.toHaveBeenCalled();
	});

	it("does not handshake before the first document load", () => {
		const frame = document.createElement("iframe");
		frame.src = FRAME_SRC;
		document.body.append(frame);
		const reply = vi.spyOn(frame.contentWindow!, "postMessage");
		const revoke = installSlidesHostBridge(frame, ENTRY, {
			expectedFrameSrc: FRAME_SRC,
		});
		window.dispatchEvent(
			new MessageEvent("message", {
				source: frame.contentWindow,
				origin: ORIGIN,
				data: {
					type: SLIDES_HOST,
					action: SLIDES_HOST_ACTIONS.hello,
					id: "before-load",
				},
			}),
		);
		expect(reply).not.toHaveBeenCalled();
		frame.dispatchEvent(new Event("load"));
		window.dispatchEvent(
			new MessageEvent("message", {
				source: frame.contentWindow,
				origin: ORIGIN,
				data: {
					type: SLIDES_HOST,
					action: SLIDES_HOST_ACTIONS.hello,
					id: "after-load",
				},
			}),
		);
		expect(reply).toHaveBeenCalledWith(
			expect.objectContaining({
				action: SLIDES_HOST_ACTIONS.init,
				id: "after-load",
			}),
			ORIGIN,
		);
		revoke();
	});

	it("syncs locale and theme without a deck remount", () => {
		const host = setup();
		host.reply.mockClear();
		host.send(SLIDES_HOST_ACTIONS.hello, "hello-1");
		expect(host.reply).toHaveBeenCalledWith(
			expect.objectContaining({
				type: SLIDES_HOST,
				action: SLIDES_HOST_ACTIONS.init,
				id: "hello-1",
				locale: "en",
			}),
			ORIGIN,
		);

		host.reply.mockClear();
		host.setState({ locale: "ko", theme: { "--accent-color": "#1765a1" } });
		window.dispatchEvent(new Event("naia:locale-change"));
		expect(host.reply).toHaveBeenCalledWith(
			expect.objectContaining({
				type: SLIDES_HOST,
				action: SLIDES_HOST_ACTIONS.sync,
				locale: "ko",
				theme: { "--accent-color": "#1765a1" },
			}),
			ORIGIN,
		);
	});

	it("serializes one recording and rejects duplicates", async () => {
		const start = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const stop = vi
			.fn<() => Promise<string>>()
			.mockResolvedValue("recordings/fixture.webm");
		const host = setup({ start, stop });
		host.reply.mockClear();
		host.send(SLIDES_HOST_ACTIONS.hello, "hello-start");
		host.send(SLIDES_HOST_ACTIONS.recordingStart, "start-1");
		await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith());
		await vi.waitFor(() =>
			expect(host.reply).toHaveBeenCalledWith(
				expect.objectContaining({
					action: SLIDES_HOST_ACTIONS.recordingResult,
					id: "start-1",
					ok: true,
				}),
				ORIGIN,
			),
		);
		expect(host.reply.mock.calls.at(-1)?.[0]).not.toHaveProperty("capability");

		host.send(SLIDES_HOST_ACTIONS.recordingStart, "start-2");
		expect(host.reply).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "start-2",
				ok: false,
				error: "recording_already_active",
			}),
			ORIGIN,
		);
		host.send(SLIDES_HOST_ACTIONS.recordingStop, "stop-1");
		await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith());
		await vi.waitFor(() =>
			expect(host.reply).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "stop-1",
					ok: true,
				}),
				ORIGIN,
			),
		);
		expect(host.reply.mock.calls.at(-1)?.[0]).not.toHaveProperty("capability");
	});

	it("stops a recording whose start resolves after iframe disposal", async () => {
		let resolveStart!: () => void;
		const start = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveStart = resolve;
				}),
		);
		const stop = vi
			.fn<() => Promise<string>>()
			.mockResolvedValue("recordings/fixture.webm");
		const host = setup({ start, stop });
		host.send(SLIDES_HOST_ACTIONS.hello, "hello-start");
		host.send(SLIDES_HOST_ACTIONS.recordingStart);
		await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith());
		host.dispose();
		resolveStart();
		await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith());
	});

	it("does not issue a second stop when disposal follows a completed stop", async () => {
		const start = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const stop = vi
			.fn<() => Promise<string>>()
			.mockResolvedValue("recordings/fixture.webm");
		const host = setup({ start, stop });
		host.send(SLIDES_HOST_ACTIONS.hello, "hello-start");
		host.send(SLIDES_HOST_ACTIONS.recordingStart);
		await vi.waitFor(() =>
			expect(host.reply).toHaveBeenCalledWith(
				expect.objectContaining({
					action: SLIDES_HOST_ACTIONS.recordingResult,
					ok: true,
				}),
				ORIGIN,
			),
		);
		host.send(SLIDES_HOST_ACTIONS.recordingStop, "stop-once");
		await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith());
		await vi.waitFor(() =>
			expect(host.reply).toHaveBeenCalledWith(
				expect.objectContaining({ id: "stop-once", ok: true }),
				ORIGIN,
			),
		);
		host.dispose();
		await Promise.resolve();
		expect(stop).toHaveBeenCalledExactlyOnceWith();
	});

	it("lets a replacement bridge recover a stop that failed during disposal", async () => {
		const start = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		let stopCalls = 0;
		const stop = vi.fn<() => Promise<string>>().mockImplementation(async () => {
			stopCalls += 1;
			if (stopCalls === 1) throw new Error("temporary stop failure");
			return "recordings/fixture.webm";
		});
		const first = setup({ start, stop });
		first.send(SLIDES_HOST_ACTIONS.hello, "first-bridge");
		first.send(SLIDES_HOST_ACTIONS.recordingStart, "start-recover");
		await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith());
		first.dispose();
		await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));

		const replacement = setup();
		replacement.send(SLIDES_HOST_ACTIONS.hello, "replacement-bridge");
		replacement.send(SLIDES_HOST_ACTIONS.recordingStop, "recover-stop");
		await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
		await vi.waitFor(() =>
			expect(replacement.reply).toHaveBeenCalledWith(
				expect.objectContaining({ id: "recover-stop", ok: true }),
				ORIGIN,
			),
		);
	});
});
