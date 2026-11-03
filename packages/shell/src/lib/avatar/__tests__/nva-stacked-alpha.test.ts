// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
	isStackedAlphaClipUrl,
	shouldUseStackedAlpha,
} from "../nva-stacked-alpha";
import { NvaStackedAlphaGL } from "../nva-stacked-alpha-gl";

const MAC_SAFARI_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const IPHONE_CRIOS_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.108 Mobile/15E148 Safari/604.1";
const IPHONE_FXIOS_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15";
const IPHONE_EDGIOS_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/126.2592.78 Mobile/15E148 Safari/605.1.15";
const LINUX_WEBKIT_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const DESKTOP_CHROME_UA =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DESKTOP_EDGE_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0";
const ANDROID_CHROME_UA =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36";

describe("shouldUseStackedAlpha", () => {
	it("returns true for Mac Safari, iOS browsers (CriOS/FxiOS/EdgiOS), and Linux WebKit", () => {
		expect(shouldUseStackedAlpha({ search: "", userAgent: MAC_SAFARI_UA })).toBe(
			true,
		);
		expect(
			shouldUseStackedAlpha({ search: "", userAgent: IPHONE_CRIOS_UA }),
		).toBe(true);
		expect(
			shouldUseStackedAlpha({ search: "", userAgent: IPHONE_FXIOS_UA }),
		).toBe(true);
		expect(
			shouldUseStackedAlpha({ search: "", userAgent: IPHONE_EDGIOS_UA }),
		).toBe(true);
		expect(
			shouldUseStackedAlpha({ search: "", userAgent: LINUX_WEBKIT_UA }),
		).toBe(true);
	});

	it("returns false for desktop Chrome, Edge, and Android Chrome", () => {
		expect(
			shouldUseStackedAlpha({ search: "", userAgent: DESKTOP_CHROME_UA }),
		).toBe(false);
		expect(
			shouldUseStackedAlpha({ search: "", userAgent: DESKTOP_EDGE_UA }),
		).toBe(false);
		expect(
			shouldUseStackedAlpha({ search: "", userAgent: ANDROID_CHROME_UA }),
		).toBe(false);
	});

	it("allows ?nva_alpha=webm and ?nva_alpha=stacked query overrides with highest priority", () => {
		expect(
			shouldUseStackedAlpha({
				search: "?nva_alpha=webm",
				userAgent: MAC_SAFARI_UA,
			}),
		).toBe(false);
		expect(
			shouldUseStackedAlpha({
				search: "?nva_alpha=stacked",
				userAgent: DESKTOP_CHROME_UA,
			}),
		).toBe(true);
	});
});

describe("isStackedAlphaClipUrl", () => {
	it("matches .stacked.mp4 clip URLs", () => {
		expect(isStackedAlphaClipUrl("/nva/naia/clips/idle.stacked.mp4")).toBe(
			true,
		);
		expect(
			isStackedAlphaClipUrl("/nva/naia/clips/idle.stacked.mp4?v=1#t"),
		).toBe(true);
		expect(isStackedAlphaClipUrl("/nva/naia/clips/idle.webm")).toBe(false);
		expect(isStackedAlphaClipUrl("/nva/naia/clips/idle.mp4")).toBe(false);
	});
});

describe("NvaStackedAlphaGL", () => {
	function createFakeGl() {
		const gl = {
			VERTEX_SHADER: 0x8b31,
			FRAGMENT_SHADER: 0x8b30,
			COMPILE_STATUS: 0x8b81,
			LINK_STATUS: 0x8b82,
			ARRAY_BUFFER: 0x8892,
			STATIC_DRAW: 0x88e4,
			FLOAT: 0x1406,
			TEXTURE_2D: 0x0de1,
			TEXTURE_WRAP_S: 0x2802,
			TEXTURE_WRAP_T: 0x2803,
			TEXTURE_MIN_FILTER: 0x2801,
			TEXTURE_MAG_FILTER: 0x2800,
			CLAMP_TO_EDGE: 0x812f,
			LINEAR: 0x2601,
			RGBA: 0x1908,
			UNSIGNED_BYTE: 0x1401,
			TRIANGLE_STRIP: 0x0005,
			createShader: vi.fn(() => ({})),
			shaderSource: vi.fn(),
			compileShader: vi.fn(),
			getShaderParameter: vi.fn(() => true),
			getShaderInfoLog: vi.fn(() => ""),
			deleteShader: vi.fn(),
			createProgram: vi.fn(() => ({})),
			attachShader: vi.fn(),
			linkProgram: vi.fn(),
			getProgramParameter: vi.fn(() => true),
			getProgramInfoLog: vi.fn(() => ""),
			deleteProgram: vi.fn(),
			useProgram: vi.fn(),
			createBuffer: vi.fn(() => ({})),
			bindBuffer: vi.fn(),
			bufferData: vi.fn(),
			getAttribLocation: vi.fn(() => 0),
			enableVertexAttribArray: vi.fn(),
			vertexAttribPointer: vi.fn(),
			createTexture: vi.fn(() => ({})),
			bindTexture: vi.fn(),
			texParameteri: vi.fn(),
			getUniformLocation: vi.fn(() => ({})),
			uniform1i: vi.fn(),
			uniform2f: vi.fn(),
			uniform1f: vi.fn(),
			viewport: vi.fn(),
			texImage2D: vi.fn(),
			drawArrays: vi.fn(),
			loseContext: vi.fn(),
			getExtension: vi.fn((name: string) =>
				name === "WEBGL_lose_context" ? { loseContext: gl.loseContext } : null,
			),
		};
		return gl;
	}

	it("resizes its offscreen canvas to half videoHeight and updates uHalfTexel on draw", () => {
		const gl = createFakeGl();
		const canvas = document.createElement("canvas");
		vi.spyOn(canvas, "getContext").mockImplementation(((type: string) =>
			type === "webgl" ? gl : null) as unknown as typeof canvas.getContext);
		const renderer = new NvaStackedAlphaGL(canvas);
		const video = {
			videoWidth: 720,
			videoHeight: 2560,
			readyState: 4,
		} as unknown as HTMLVideoElement;
		expect(renderer.draw(video)).toBe(true);
		expect(canvas.width).toBe(720);
		expect(canvas.height).toBe(1280);
		expect(gl.viewport).toHaveBeenCalledWith(0, 0, 720, 1280);
		expect(gl.uniform1f).toHaveBeenCalledWith(expect.anything(), 0.5 / 2560);
		renderer.dispose();
		expect(gl.loseContext).toHaveBeenCalled();
	});
});
