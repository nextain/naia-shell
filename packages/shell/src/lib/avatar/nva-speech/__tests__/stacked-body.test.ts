// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NvaManifest } from "../../../nva";
import {
	CanonicalSpeechStage,
	type StackedBodyDecoder,
	isStackedBodyFrame,
} from "../canonical-speech-stage";

function manifest(): NvaManifest {
	return {
		canvas: { width: 720, height: 1280, fps: 25 },
		animations: {
			idle: { clip: "clips/idle.webm", loop: true },
			talking: { clip: "clips/talking-ko.webm", loop: true, can_talk: true },
		},
	} as unknown as NvaManifest;
}

function frame(width: number, height: number): HTMLVideoElement {
	const video = document.createElement("video");
	Object.defineProperty(video, "videoWidth", { value: width });
	Object.defineProperty(video, "videoHeight", { value: height });
	return video;
}

function setup(decoder?: StackedBodyDecoder) {
	const ctx = {
		drawImage: vi.fn(),
		clearRect: vi.fn(),
		globalAlpha: 1,
	};
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
		ctx as never,
	);
	const host = document.createElement("video");
	document.createElement("div").appendChild(host);
	let options: { canvas: HTMLCanvasElement } | null = null;
	const stage = new CanonicalSpeechStage({
		manifest: manifest(),
		host,
		loadAsset: async (path) => new Blob([path]),
		createStackedAlpha: decoder ? () => decoder : undefined,
		createPlayer: (o) => {
			options = o as { canvas: HTMLCanvasElement };
			return {
				state: "ready",
				loadAudioClock: vi.fn(),
				loadExternal: vi.fn(),
				playAudioClock: vi.fn(),
				playExternal: vi.fn(),
				updateExternalPlan: vi.fn(),
				stop: vi.fn(),
				dispose: vi.fn(),
			} as never;
		},
	});
	if (!options) throw new Error("player not created");
	const playerCanvas = (options as { canvas: HTMLCanvasElement }).canvas;
	playerCanvas.width = 720;
	playerCanvas.height = 1280;
	const playerCtx = playerCanvas.getContext("2d") as CanvasRenderingContext2D;
	return { stage, ctx, playerCanvas, playerCtx };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isStackedBodyFrame", () => {
	it("detects a color/alpha stacked frame drawn over the whole canvas", () => {
		expect(isStackedBodyFrame(frame(720, 2560), 720, 1280)).toBe(true);
	});
	it("leaves ordinary and not-yet-decoded frames alone", () => {
		expect(isStackedBodyFrame(frame(720, 1280), 720, 1280)).toBe(false);
		expect(isStackedBodyFrame(frame(0, 0), 720, 1280)).toBe(false);
		expect(isStackedBodyFrame(frame(256, 256), 200, 200)).toBe(false);
	});
});

describe("speech stage body drawing", () => {
	it("hands the player the stage canvas size", () => {
		const { stage, playerCanvas } = setup();
		expect(stage.canvas.width).toBe(720);
		expect(stage.canvas.height).toBe(1280);
		expect(playerCanvas.width).toBe(720);
	});

	it("unpacks a stacked body frame through the alpha decoder", () => {
		const decoded = document.createElement("canvas");
		const decoder = { canvas: decoded, draw: vi.fn(() => true), dispose: vi.fn() };
		const { stage, ctx, playerCtx } = setup(decoder);
		const body = frame(720, 2560);
		playerCtx.drawImage(body, 0, 0, 720, 1280);
		expect(decoder.draw).toHaveBeenCalledWith(body);
		expect(ctx.drawImage).toHaveBeenCalledWith(decoded, 0, 0, 720, 1280);
		expect(ctx.drawImage).not.toHaveBeenCalledWith(body, 0, 0, 720, 1280);
		stage.dispose();
		expect(decoder.dispose).toHaveBeenCalled();
	});

	it("passes ordinary frames and other context calls straight through", () => {
		const decoder = { canvas: document.createElement("canvas"), draw: vi.fn(() => true), dispose: vi.fn() };
		const { ctx, playerCtx } = setup(decoder);
		const body = frame(720, 1280);
		playerCtx.drawImage(body, 0, 0, 720, 1280);
		playerCtx.drawImage(body, 10, 20, 30, 40, 1, 2, 3, 4);
		playerCtx.clearRect(0, 0, 720, 1280);
		playerCtx.globalAlpha = 0.5;
		expect(decoder.draw).not.toHaveBeenCalled();
		expect(ctx.drawImage).toHaveBeenCalledWith(body, 0, 0, 720, 1280);
		expect(ctx.drawImage).toHaveBeenCalledWith(body, 10, 20, 30, 40, 1, 2, 3, 4);
		expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 720, 1280);
		expect(ctx.globalAlpha).toBe(0.5);
	});

	it("draws only the color half when the decoder fails", () => {
		const decoder = { canvas: document.createElement("canvas"), draw: vi.fn(() => false), dispose: vi.fn() };
		const { ctx, playerCtx } = setup(decoder);
		const body = frame(720, 2560);
		playerCtx.drawImage(body, 0, 0, 720, 1280);
		playerCtx.drawImage(body, 0, 0, 720, 1280);
		expect(decoder.draw).toHaveBeenCalledTimes(1);
		expect(decoder.dispose).toHaveBeenCalled();
		expect(ctx.drawImage).toHaveBeenCalledWith(body, 0, 0, 720, 1280, 0, 0, 720, 1280);
		expect(ctx.drawImage).toHaveBeenCalledTimes(2);
	});
});
