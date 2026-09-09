// #582 S2a — 감독자·클라이언트 공통 오류 모양.
// 벤더 런타임은 `{error, error_code}` 를 그대로 읽는다(docs/ego-runtime-abi.md 6절).
// 미지의 코드는 런타임이 문구를 덮어쓰지 않으므로 `error` 에 사람이 읽을 설명을 반드시 담는다.

/** 안정 코드. 업스트림 목록 밖이라 문구는 우리가 책임진다. */
export const CODES = Object.freeze({
  FRAME_TOO_LARGE: "EGO_HOST_FRAME_TOO_LARGE",
  FRAME_MALFORMED: "EGO_HOST_FRAME_MALFORMED",
  BACKPRESSURE: "EGO_HOST_BACKPRESSURE",
  DISCONNECTED: "EGO_HOST_DISCONNECTED",
  NOT_CONNECTED: "EGO_HOST_NOT_CONNECTED",
  HANDSHAKE_REQUIRED: "EGO_HOST_HANDSHAKE_REQUIRED",
  HANDSHAKE_INVALID: "EGO_HOST_HANDSHAKE_INVALID",
  TOKEN_MISSING: "EGO_HOST_TOKEN_MISSING",
  TOKEN_REUSED: "EGO_HOST_TOKEN_REUSED",
  GRANT_REQUIRED: "EGO_HOST_GRANT_REQUIRED",
  METHOD_DENIED: "EGO_HOST_METHOD_DENIED",
  DEADLINE: "EGO_HOST_DEADLINE_EXCEEDED",
  NO_TASK_SPACE: "EGO_TASK_SPACE_NOT_SELECTED",
  TASK_SPACE_NOT_FOUND: "EGO_TASK_SPACE_NOT_FOUND",
  HANDOFF_HEADLESS: "EGO_HANDOFF_UNSUPPORTED_HEADLESS",
  SDK_NOT_FOUND: "EGO_HOST_SDK_NOT_FOUND",
  USAGE: "EGO_HOST_USAGE",
});

/** `{error, error_code}` 를 달고 다니는 Error. 두 통로(throw·resolve)가 같은 모양을 쓴다. */
export class EgoHostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EgoHostError";
    this.error_code = code;
  }
  /** 런타임이 그대로 읽는 resolve 모양. */
  toShape() {
    return { error: this.message, error_code: this.error_code };
  }
}

export function hostError(code, message) {
  return new EgoHostError(code, message);
}

/** 어떤 오류든 `{error, error_code}` 로 만든다. 설명이 비면 코드만 남아 사람이 읽을 것이 없다. */
export function toShape(error, fallbackCode = CODES.DISCONNECTED) {
  if (error instanceof EgoHostError) return error.toShape();
  const message = error instanceof Error ? error.message : String(error);
  return { error: message || "설명 없는 실패", error_code: error?.error_code ?? fallbackCode };
}
