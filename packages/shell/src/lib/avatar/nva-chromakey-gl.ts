// nva-chromakey-gl — Layer 1(head) 크로마키를 **WebGL2 셰이더**로 처리(GPU). Ditto head 프레임(h264,
//   green bg)에서 키 색을 알파 0 으로 제거해 얼굴만 남긴다. getImageData 소프트웨어 키잉은 매 프레임
//   406×720 픽셀 순회 → GC/CPU 부담 → 금지(설계). 결과 = 알파 있는 오프스크린 canvas → 2D 캔버스에
//   drawImage 로 합성(base 위 얼굴 오버레이). WebGL2 미지원 시 생성자에서 throw(호출부가 capability 게이트).

export interface ChromakeyOpts {
	/** 키 색(#rrggbb). Ditto green = #00ff00. */
	keyColor?: string;
	/** 키 판정 거리 임계(0~1, RGB 유클리드). 이하 = 완전 투명. */
	threshold?: number;
	/** 소프트 엣지 폭(0~1). threshold~threshold+smoothness 사이 선형 알파. */
	smoothness?: number;
	/** 디스필(잔여 초록 억제) 강도(0~1). */
	despill?: number;
}

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // a_pos: -1..1 풀스크린 쿼드. 텍스처 uv 는 상하 반전(비디오 원점=좌상단).
  v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec3 u_key;
uniform float u_thresh;
uniform float u_smooth;
uniform float u_despill;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_tex, v_uv);
  float d = distance(c.rgb, u_key);
  float a = smoothstep(u_thresh, u_thresh + u_smooth, d); // 키색 근처=0, 멀면=1
  // 디스필: 초록이 적/청 평균보다 강하면 억제(엣지 초록 테두리 제거).
  vec3 rgb = c.rgb;
  float g = rgb.g - u_despill * max(0.0, rgb.g - max(rgb.r, rgb.b));
  rgb.g = mix(rgb.g, g, step(0.001, u_despill));
  fragColor = vec4(rgb, c.a * a); // 스트레이트 알파
}`;

/** 파라미터 clamp(NaN/음수/과대 방어). */
const clampNum = (v: number, lo: number, hi: number) =>
	Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;

function hexToRgb01(hex: string): [number, number, number] {
	const h = (hex || "#00ff00").replace("#", "");
	return [
		Number.parseInt(h.slice(0, 2), 16) / 255,
		Number.parseInt(h.slice(2, 4), 16) / 255,
		Number.parseInt(h.slice(4, 6), 16) / 255,
	];
}

function compile(
	gl: WebGL2RenderingContext,
	type: number,
	src: string,
): WebGLShader {
	const sh = gl.createShader(type);
	if (!sh) throw new Error("셰이더 생성 실패");
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
		const log = gl.getShaderInfoLog(sh);
		gl.deleteShader(sh);
		throw new Error(`셰이더 컴파일 실패: ${log}`);
	}
	return sh;
}

export class NvaChromakeyGL {
	private readonly canvas: HTMLCanvasElement;
	private readonly gl: WebGL2RenderingContext;
	private readonly program: WebGLProgram;
	private readonly tex: WebGLTexture;
	private readonly vbo: WebGLBuffer | null;
	private readonly uKey: WebGLUniformLocation | null;
	private readonly uThresh: WebGLUniformLocation | null;
	private readonly uSmooth: WebGLUniformLocation | null;
	private readonly uDespill: WebGLUniformLocation | null;
	private key: [number, number, number];
	private threshold: number;
	private smoothness: number;
	private despill: number;
	private disposed = false;

	constructor(opts: ChromakeyOpts = {}) {
		this.key = hexToRgb01(opts.keyColor ?? "#00ff00");
		this.threshold = clampNum(opts.threshold ?? 0.3, 0, 2); // RGB 거리 max=√3≈1.73
		this.smoothness = clampNum(opts.smoothness ?? 0.12, 0, 2);
		this.despill = clampNum(opts.despill ?? 0.4, 0, 1);

		const canvas = document.createElement("canvas");
		canvas.width = 2;
		canvas.height = 2;
		// premultipliedAlpha:false = 셰이더의 스트레이트 알파 출력을 그대로 → 2D drawImage 합성 정확.
		const gl = canvas.getContext("webgl2", {
			premultipliedAlpha: false,
			alpha: true,
		});
		if (!gl)
			throw new Error(
				"WebGL2 컨텍스트 불가 (capability 게이트로 사전 차단해야 함)",
			);
		this.canvas = canvas;
		this.gl = gl;

		const vs = compile(gl, gl.VERTEX_SHADER, VERT);
		const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
		const program = gl.createProgram();
		if (!program) throw new Error("프로그램 생성 실패");
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			throw new Error(`프로그램 링크 실패: ${gl.getProgramInfoLog(program)}`);
		}
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		this.program = program;

		// 풀스크린 쿼드.
		const buf = gl.createBuffer();
		this.vbo = buf;
		gl.bindBuffer(gl.ARRAY_BUFFER, buf);
		gl.bufferData(
			gl.ARRAY_BUFFER,
			new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
			gl.STATIC_DRAW,
		);
		const loc = gl.getAttribLocation(program, "a_pos");
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

		const tex = gl.createTexture();
		if (!tex) throw new Error("텍스처 생성 실패");
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		this.tex = tex;

		gl.useProgram(program);
		gl.uniform1i(gl.getUniformLocation(program, "u_tex"), 0);
		this.uKey = gl.getUniformLocation(program, "u_key");
		this.uThresh = gl.getUniformLocation(program, "u_thresh");
		this.uSmooth = gl.getUniformLocation(program, "u_smooth");
		this.uDespill = gl.getUniformLocation(program, "u_despill");
	}

	/** 키 파라미터 런타임 조정(정합/키잉 튜닝). clamp 적용. */
	setParams(p: ChromakeyOpts): void {
		if (p.keyColor) this.key = hexToRgb01(p.keyColor);
		if (p.threshold != null) this.threshold = clampNum(p.threshold, 0, 2);
		if (p.smoothness != null) this.smoothness = clampNum(p.smoothness, 0, 2);
		if (p.despill != null) this.despill = clampNum(p.despill, 0, 1);
	}

	/**
	 * source(비디오/캔버스/이미지) 프레임을 키잉해 내부 canvas 에 렌더 후 그 canvas 를 반환.
	 * 반환 canvas 는 알파 있는 RGBA → 호출부가 2D ctx.drawImage(canvas, x, y, w, h) 로 base 위 합성.
	 */
	process(
		source: TexImageSource,
		width: number,
		height: number,
	): HTMLCanvasElement {
		if (this.disposed) throw new Error("dispose 된 chromakey 사용");
		const gl = this.gl;
		// WebGL 컨텍스트 유실(GPU 리셋/탭 백그라운드) 시 크래시 대신 마지막 canvas 반환(호출부는 fallback 처리).
		if (gl.isContextLost()) return this.canvas;
		const w = Math.max(1, Math.floor(width));
		const h = Math.max(1, Math.floor(height));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}
		gl.viewport(0, 0, w, h);
		gl.useProgram(this.program);
		gl.uniform3f(this.uKey, this.key[0], this.key[1], this.key[2]);
		gl.uniform1f(this.uThresh, this.threshold);
		gl.uniform1f(this.uSmooth, this.smoothness);
		gl.uniform1f(this.uDespill, this.despill);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // uv 반전은 셰이더가 처리
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.drawArrays(gl.TRIANGLES, 0, 6);
		return this.canvas;
	}

	/** WebGL 리소스 해제. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const gl = this.gl;
		gl.deleteTexture(this.tex);
		gl.deleteBuffer(this.vbo);
		gl.deleteProgram(this.program);
		gl.getExtension("WEBGL_lose_context")?.loseContext();
	}
}
