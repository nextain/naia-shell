// #582 S2a — 길이 접두 프레이밍.
// 프레임 = [4바이트 BE uint32 길이][UTF-8 JSON]. 스트림 경계는 우리가 정한다 —
// 소켓은 경계를 보장하지 않으므로 JSON 을 줄 단위로 읽으면 큰 스냅샷에서 반드시 깨진다.
import { CODES, hostError } from "../errors.mjs";

/** 최대 프레임. 접근성 스냅샷 하나가 수 MiB 까지 가므로 8MiB 를 상한으로 둔다. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const HEADER_BYTES = 4;

/** 값을 프레임 하나로 만든다. 상한을 넘으면 보내기 전에 던진다(반쪽 프레임을 만들지 않는다). */
export function encodeFrame(value, { maxBytes = MAX_FRAME_BYTES } = {}) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > maxBytes) {
    throw hostError(
      CODES.FRAME_TOO_LARGE,
      `프레임 ${body.length}바이트가 상한 ${maxBytes}바이트를 넘었다`,
    );
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

/**
 * 스트림 디코더. 한 청크에 프레임이 여러 개 오거나 프레임 하나가 여러 청크에 걸쳐도 된다.
 * 상한을 넘는 길이 헤더는 본문을 기다리지 않고 즉시 오류다 — 기다리면 그것이 곧 메모리 폭탄이다.
 */
export function createFrameDecoder({ maxBytes = MAX_FRAME_BYTES, onFrame, onError } = {}) {
  let buffer = Buffer.alloc(0);
  let broken = false;

  const fail = (error) => {
    broken = true;
    buffer = Buffer.alloc(0);
    onError?.(error);
  };

  return {
    push(chunk) {
      if (broken) return;
      buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
      while (!broken) {
        if (buffer.length < HEADER_BYTES) return;
        const length = buffer.readUInt32BE(0);
        if (length > maxBytes) {
          fail(
            hostError(
              CODES.FRAME_TOO_LARGE,
              `수신 프레임 길이 ${length}바이트가 상한 ${maxBytes}바이트를 넘었다`,
            ),
          );
          return;
        }
        if (buffer.length < HEADER_BYTES + length) return;
        const body = buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
        buffer = buffer.subarray(HEADER_BYTES + length);
        let value;
        try {
          value = JSON.parse(body.toString("utf8"));
        } catch (error) {
          fail(hostError(CODES.FRAME_MALFORMED, `프레임 JSON 파싱 실패: ${error.message}`));
          return;
        }
        onFrame?.(value);
      }
    },
    get pendingBytes() {
      return buffer.length;
    },
  };
}
