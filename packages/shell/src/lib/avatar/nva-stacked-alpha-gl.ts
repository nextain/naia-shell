/**
 * Stacked color/alpha MP4 compositor for Safari transparency.
 *
 * The stacked clip packs two pictures in one frame: the top half is the color
 * image and the bottom half is the alpha (grayscale) image. This renderer
 * uploads one video frame as a texture and composites both halves with WebGL1
 * into its own offscreen `canvas`, so Safari (which cannot show VP9 alpha WebM
 * transparently) gets real transparency without any external package.
 *
 * Alpha handling: the browser converts YUV to RGB per the standard, which
 * already stretches the limited-range Y 16..235 of the bottom half to RGB
 * 0..255. The shader therefore uses the bottom half's G value as-is.
 * `alphaRange` only guards against device differences:
 * `alpha = clamp((g - lo) / (hi - lo), 0, 1)`, default (0, 1).
 */

export type StackedAlphaRange = readonly [number, number];

export interface StackedAlphaRendererOptions {
	/** Alpha remap range applied to the bottom-half G value. Default [0, 1] (no remap). */
	alphaRange?: StackedAlphaRange;
	/** Optional offscreen canvas override (primarily for tests). Defaults to a fresh offscreen canvas. */
	canvas?: HTMLCanvasElement;
}

const VERTEX_SHADER = [
	"attribute vec2 aPos;",
	"attribute vec2 aUv;",
	"varying vec2 vUv;",
	"void main() {",
	"  vUv = aUv;",
	"  gl_Position = vec4(aPos, 0.0, 1.0);",
	"}",
].join("\n");

const FRAGMENT_SHADER = [
	"precision mediump float;",
	"uniform sampler2D uTex;",
	"uniform vec2 uAlphaRange;",
	"uniform float uHalfTexel;",
	"varying vec2 vUv;",
	"void main() {",
	"  float row = clamp((1.0 - vUv.y) * 0.5, uHalfTexel, 0.5 - uHalfTexel);",
	"  vec3 color = texture2D(uTex, vec2(vUv.x, row)).rgb;",
	"  float alphaRow = clamp(0.5 + row, 0.5 + uHalfTexel, 1.0 - uHalfTexel);",
	"  float g = texture2D(uTex, vec2(vUv.x, alphaRow)).g;",
	"  float denom = max(uAlphaRange.y - uAlphaRange.x, 0.000001);",
	"  float alpha = clamp((g - uAlphaRange.x) / denom, 0.0, 1.0);",
	"  gl_FragColor = vec4(color * alpha, alpha);",
	"}",
].join("\n");

function compileShader(
	gl: WebGLRenderingContext,
	type: number,
	source: string,
): WebGLShader {
	const shader = gl.createShader(type);
	if (!shader) throw new Error("stacked-alpha: failed to create shader");
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(shader) || "unknown shader error";
		gl.deleteShader(shader);
		throw new Error(`stacked-alpha: shader compile failed: ${log}`);
	}
	return shader;
}

function linkProgram(
	gl: WebGLRenderingContext,
	vertex: WebGLShader,
	fragment: WebGLShader,
): WebGLProgram {
	const program = gl.createProgram();
	if (!program) throw new Error("stacked-alpha: failed to create program");
	gl.attachShader(program, vertex);
	gl.attachShader(program, fragment);
	gl.linkProgram(program);
	gl.deleteShader(vertex);
	gl.deleteShader(fragment);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		const log = gl.getProgramInfoLog(program) || "unknown link error";
		gl.deleteProgram(program);
		throw new Error(`stacked-alpha: program link failed: ${log}`);
	}
	return program;
}

function isCanvasLike(value: unknown): value is HTMLCanvasElement {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as HTMLCanvasElement).getContext === "function"
	);
}

/**
 * Draws stacked color/alpha video frames onto its own offscreen `canvas` with
 * premultiplied alpha output (`vec4(color * alpha, alpha)`, `premultipliedAlpha: true`),
 * matching the canvas default compositing. WebGL1 is enough; the texture uses
 * CLAMP_TO_EDGE + LINEAR so non-power-of-two video sizes work.
 */
export class NvaStackedAlphaGL {
	readonly canvas: HTMLCanvasElement;
	private readonly gl: WebGLRenderingContext;
	private readonly texture: WebGLTexture | null;
	private readonly alphaRangeLoc: WebGLUniformLocation | null;
	private readonly halfTexelLoc: WebGLUniformLocation | null;
	private videoWidth = 0;
	private videoHeight = 0;
	private contextLost = false;
	private disposed = false;
	private readonly handleContextLost: (event: Event) => void;

	constructor(
		canvasOrOptions?: HTMLCanvasElement | StackedAlphaRendererOptions,
		maybeOptions?: StackedAlphaRendererOptions,
	) {
		const options = isCanvasLike(canvasOrOptions)
			? maybeOptions
			: canvasOrOptions;
		const canvas = isCanvasLike(canvasOrOptions)
			? canvasOrOptions
			: (options?.canvas ?? document.createElement("canvas"));
		const gl =
			(canvas.getContext("webgl", {
				alpha: true,
				premultipliedAlpha: true,
				antialias: false,
				depth: false,
				stencil: false,
			}) as WebGLRenderingContext | null) ??
			(canvas.getContext(
				"experimental-webgl",
			) as WebGLRenderingContext | null);
		if (!gl) throw new Error("stacked-alpha: WebGL is not available");
		this.canvas = canvas;
		this.gl = gl;

		const program = linkProgram(
			gl,
			compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER),
			compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER),
		);
		gl.useProgram(program);

		// Full-screen quad: positions with matching UVs (v = 0 at the bottom).
		const buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(
			gl.ARRAY_BUFFER,
			new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]),
			gl.STATIC_DRAW,
		);
		const posLoc = gl.getAttribLocation(program, "aPos");
		const uvLoc = gl.getAttribLocation(program, "aUv");
		gl.enableVertexAttribArray(posLoc);
		gl.enableVertexAttribArray(uvLoc);
		gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
		gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		this.texture = texture;

		const texLoc = gl.getUniformLocation(program, "uTex");
		gl.uniform1i(texLoc, 0);
		this.alphaRangeLoc = gl.getUniformLocation(program, "uAlphaRange");
		const range = options?.alphaRange ?? [0, 1];
		gl.uniform2f(this.alphaRangeLoc, range[0], range[1]);
		this.halfTexelLoc = gl.getUniformLocation(program, "uHalfTexel");
		gl.uniform1f(this.halfTexelLoc, 0);

		this.handleContextLost = (event: Event) => {
			event.preventDefault();
			this.contextLost = true;
		};
		canvas.addEventListener?.("webglcontextlost", this.handleContextLost);
	}

	/** True after the canvas fired `webglcontextlost`. `draw` then stays a no-op. */
	isContextLost(): boolean {
		return this.contextLost;
	}

	/**
	 * Composites one video frame. Resizes the canvas to the video width and
	 * half its height when the video size changes. Returns false when the GL
	 * context is lost (the caller should fall back); never throws for that.
	 */
	draw(video: HTMLVideoElement): boolean {
		if (this.contextLost || this.disposed) return false;
		const readyState = (video as HTMLVideoElement & { readyState?: unknown })
			.readyState;
		if (typeof readyState === "number" && readyState < 2) return true;
		const videoWidth = video.videoWidth | 0;
		const videoHeight = video.videoHeight | 0;
		if (videoWidth <= 0 || videoHeight <= 0) return true;
		const gl = this.gl;
		if (videoWidth !== this.videoWidth || videoHeight !== this.videoHeight) {
			this.videoWidth = videoWidth;
			this.videoHeight = videoHeight;
			this.canvas.width = videoWidth;
			this.canvas.height = Math.max(1, Math.floor(videoHeight / 2));
			gl.viewport(0, 0, this.canvas.width, this.canvas.height);
			gl.uniform1f(this.halfTexelLoc, 0.5 / videoHeight);
		}
		gl.bindTexture(gl.TEXTURE_2D, this.texture);
		gl.texImage2D(
			gl.TEXTURE_2D,
			0,
			gl.RGBA,
			gl.RGBA,
			gl.UNSIGNED_BYTE,
			video,
		);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		return true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.canvas.removeEventListener?.(
			"webglcontextlost",
			this.handleContextLost,
		);
		try {
			const lose = this.gl.getExtension("WEBGL_lose_context");
			lose?.loseContext();
		} catch {
			// Releasing the context is best-effort; GC reclaims the rest.
		}
	}
}

export { NvaStackedAlphaGL as StackedAlphaRenderer };
