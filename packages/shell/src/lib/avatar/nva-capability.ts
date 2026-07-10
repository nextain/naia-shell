// nva-capability — NVA 레이어드 플레이어 실현가능성 프로브 (codex R2 CRITICAL C2).
//   WebView2(Tauri) 에서 레이어드 canvas 합성에 필요한 능력을 런타임 검사한다. 하나라도 불가면
//   레이어드 플레이어 비활성 → 기존 full-composite 경로로 fallback(회귀 0). 결과를 로깅/진단 노출.

export interface NvaCapabilities {
	/** HTMLVideoElement.requestVideoFrameCallback (프레임 PTS 기반 A/V 싱크에 필요). */
	rvfc: boolean;
	/** WebGL2 컨텍스트 + 셰이더 (head chromakey GPU 합성에 필요). */
	webgl2: boolean;
	/** MSE 로 fragmented h264(avc1) 재생 (Ditto head 스트림). */
	mseH264: boolean;
	/** canvas 2d 알파 합성 (투명 배경 유지 → 앱 배경 위). */
	canvasAlpha: boolean;
	/** 위가 모두 참 = 레이어드 플레이어 가능. */
	layeredOk: boolean;
	/** 불가 사유(가시화). */
	reasons: string[];
}

const H264_FMP4 = 'video/mp4; codecs="avc1.42E01F"';

/** 브라우저/WebView2 능력 프로브. 순수 함수(부작용 없음, 짧은 GL 컨텍스트 1개 생성·해제). */
export function probeNvaCapabilities(): NvaCapabilities {
	const reasons: string[] = [];

	const rvfc =
		typeof HTMLVideoElement !== "undefined" &&
		typeof (
			HTMLVideoElement.prototype as unknown as {
				requestVideoFrameCallback?: unknown;
			}
		).requestVideoFrameCallback === "function";
	if (!rvfc) reasons.push("requestVideoFrameCallback 미지원");

	let webgl2 = false;
	try {
		const c = document.createElement("canvas");
		const gl = c.getContext("webgl2");
		webgl2 = !!gl;
		// 컨텍스트 해제(리소스 누수 방지).
		(gl as WebGL2RenderingContext | null)
			?.getExtension("WEBGL_lose_context")
			?.loseContext();
	} catch {
		webgl2 = false;
	}
	if (!webgl2) reasons.push("WebGL2 컨텍스트 불가");

	const mseH264 =
		typeof MediaSource !== "undefined" &&
		typeof MediaSource.isTypeSupported === "function" &&
		MediaSource.isTypeSupported(H264_FMP4);
	if (!mseH264) reasons.push("MSE h264(avc1) 미지원");

	let canvasAlpha = false;
	try {
		const c = document.createElement("canvas");
		c.width = c.height = 2;
		const ctx = c.getContext("2d", { alpha: true });
		if (ctx) {
			ctx.clearRect(0, 0, 2, 2);
			// 클리어 후 알파 0 이면 투명 합성 지원.
			canvasAlpha = ctx.getImageData(0, 0, 1, 1).data[3] === 0;
		}
	} catch {
		canvasAlpha = false;
	}
	if (!canvasAlpha) reasons.push("canvas 알파 합성 불가");

	const layeredOk = rvfc && webgl2 && mseH264 && canvasAlpha;
	return { rvfc, webgl2, mseH264, canvasAlpha, layeredOk, reasons };
}
