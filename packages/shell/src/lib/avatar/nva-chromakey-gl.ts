// nva-chromakey-gl — Layer 1(head) 크로마키를 **WebGL2 셰이더**로 처리(GPU). legacy layered head video.
//   green bg)에서 키 색을 알파 0 으로 제거해 얼굴만 남긴다. getImageData 소프트웨어 키잉은 매 프레임
//   406×720 픽셀 순회 → GC/CPU 부담 → 금지(설계). 결과 = 알파 있는 오프스크린 canvas → 2D 캔버스에
//   drawImage 로 합성(base 위 얼굴 오버레이). WebGL2 미지원 시 생성자에서 throw(호출부가 capability 게이트).

export interface ChromakeyOpts {
	/** 동작 모드: "chromakey"(기본) 또는 투명 WebM 알파 빈칸·외곽 다크 매트 보정("alpha-repair"). */
	mode?: "chromakey" | "alpha-repair";
	/** 키 색(#rrggbb). legacy green key = #00ff00. */
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
  // a_pos: -1..1 풀스크린 쿼드. 캔버스 기본 프레임버퍼 출력용 텍스처 uv 상하 반전(비디오 원점=좌상단).
  v_uv = vec2((a_pos.x + 1.0) * 0.5, 1.0 - (a_pos.y + 1.0) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const VERT_FBO = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // FBO 텍스처 패스용: 0..1 UV 좌표를 원본 텍스처 방향과 1:1 유지
  v_uv = (a_pos + 1.0) * 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const SEED_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_srcTexel;
uniform vec2 u_maskTexel;
in vec2 v_uv;
out vec4 fragColor;

float sampleBaseA(vec2 uv) {
  vec4 c0 = texture(u_tex, uv);
  float a0 = c0.a;
  if (a0 > 0.02 && a0 < 0.80 && (c0.b - c0.r > 0.045 && c0.g - c0.r > 0.02)) {
    float aU1 = texture(u_tex, uv + vec2(0.0, -1.0) * u_srcTexel).a;
    float aU2 = texture(u_tex, uv + vec2(0.0, -2.0) * u_srcTexel).a;
    if (aU1 < 0.05 || (aU1 < 0.80 && aU2 < 0.05)) {
      return 0.0;
    }
  }
  return a0;
}

float sampleCleanA(vec2 uv) {
  float baseA = sampleBaseA(uv);
  if (baseA >= 0.80) return baseA;
  float aU1 = sampleBaseA(uv + vec2(0.0, -1.0) * u_srcTexel);
  float aU2 = sampleBaseA(uv + vec2(0.0, -2.0) * u_srcTexel);
  float aD1 = sampleBaseA(uv + vec2(0.0, 1.0) * u_srcTexel);
  float aD2 = sampleBaseA(uv + vec2(0.0, 2.0) * u_srcTexel);
  float aD3 = sampleBaseA(uv + vec2(0.0, 3.0) * u_srcTexel);
  float aL1 = sampleBaseA(uv + vec2(-1.0, 0.0) * u_srcTexel);
  float aL2 = sampleBaseA(uv + vec2(-2.0, 0.0) * u_srcTexel);
  float aR1 = sampleBaseA(uv + vec2(1.0, 0.0) * u_srcTexel);
  float aR2 = sampleBaseA(uv + vec2(2.0, 0.0) * u_srcTexel);
  bool vBridge = (max(aU1, aU2) >= 0.80 && max(aD1, aD2) >= 0.80 && max(max(aD1, aD2), aD3) >= 0.85 && aU2 >= 0.55);
  bool hBridge = (max(aL1, aL2) >= 0.80 && max(aR1, aR2) >= 0.80 && max(aD1, aD2) >= 0.80 && aL2 >= 0.80 && aR2 >= 0.80);
  if (vBridge) baseA = max(baseA, min(max(aU1, aU2), max(aD1, aD2)));
  if (hBridge) baseA = max(baseA, min(max(aL1, aL2), max(aR1, aR2)));
  return baseA;
}

void main() {
  float cleanA = sampleCleanA(v_uv);
  float baseA = sampleBaseA(v_uv);

  vec2 hStep = (u_maskTexel - u_srcTexel) * 0.5;
  float maxSubCleanA = cleanA;
  float maxSubBaseA = baseA;
  if (hStep.x > 0.0 || hStep.y > 0.0) {
    maxSubCleanA = max(maxSubCleanA, sampleCleanA(v_uv + vec2(-hStep.x, -hStep.y)));
    maxSubCleanA = max(maxSubCleanA, sampleCleanA(v_uv + vec2( hStep.x, -hStep.y)));
    maxSubCleanA = max(maxSubCleanA, sampleCleanA(v_uv + vec2(-hStep.x,  hStep.y)));
    maxSubCleanA = max(maxSubCleanA, sampleCleanA(v_uv + vec2( hStep.x,  hStep.y)));
    maxSubBaseA = max(maxSubBaseA, sampleBaseA(v_uv + vec2(-hStep.x, -hStep.y)));
    maxSubBaseA = max(maxSubBaseA, sampleBaseA(v_uv + vec2( hStep.x, -hStep.y)));
    maxSubBaseA = max(maxSubBaseA, sampleBaseA(v_uv + vec2(-hStep.x,  hStep.y)));
    maxSubBaseA = max(maxSubBaseA, sampleBaseA(v_uv + vec2( hStep.x,  hStep.y)));
  }

  // passBg: 투명 화소(< 0.18)를 따라 바깥 배경 채우기(flood)가 전파되며, 불투명 벽(>= 0.18)에서 차단됨 (색 무관)
  float passBg = maxSubCleanA < 0.18 ? 1.0 : 0.0;
  float passFg = maxSubBaseA >= 0.75 ? 1.0 : 0.0;

  // bgReach 시드: 캔버스 가장자리 투명 화소 또는 큰 투명 배경 개구부(팔-허리 사이 큰 빈 공간 등 반경 4..12px 전체 투명)에서 시작
  bool atBorder = (
    v_uv.x <= u_maskTexel.x * 1.5 ||
    v_uv.x >= 1.0 - u_maskTexel.x * 1.5 ||
    v_uv.y <= u_maskTexel.y * 1.5 ||
    v_uv.y >= 1.0 - u_maskTexel.y * 1.5
  );

  // fgReach 시드: 주 피사체 내부 코어(8방향 반경 1..3 텍셀 모두 불투명 >= 0.80)
  const vec2 dirs[8] = vec2[8](
    vec2( 1.0,  0.0), vec2( 1.0, -1.0),
    vec2( 0.0, -1.0), vec2(-1.0, -1.0),
    vec2(-1.0,  0.0), vec2(-1.0,  1.0),
    vec2( 0.0,  1.0), vec2( 1.0,  1.0)
  );
  bool isOpenBgAperture = (passBg > 0.5 && cleanA < 0.02);
  if (isOpenBgAperture && !atBorder) {
    for (int d = 0; d < 8; d++) {
      if (
        sampleCleanA(v_uv + dirs[d] * u_srcTexel * 4.0) >= 0.05 ||
        sampleCleanA(v_uv + dirs[d] * u_srcTexel * 8.0) >= 0.05 ||
        sampleCleanA(v_uv + dirs[d] * u_srcTexel * 12.0) >= 0.05
      ) {
        isOpenBgAperture = false;
        break;
      }
    }
  }
  float bgReach = ((atBorder && passBg > 0.5) || isOpenBgAperture) ? 1.0 : 0.0;
  bool isCore = baseA >= 0.85;
  if (isCore) {
    for (int d = 0; d < 8; d++) {
      if (
        sampleBaseA(v_uv + dirs[d] * u_srcTexel * 1.0) < 0.80 ||
        sampleBaseA(v_uv + dirs[d] * u_srcTexel * 2.0) < 0.80 ||
        sampleBaseA(v_uv + dirs[d] * u_srcTexel * 3.0) < 0.80
      ) {
        isCore = false;
        break;
      }
    }
  }
  float fgReach = isCore ? 1.0 : 0.0;
  float coreAndPassFg = isCore ? 1.0 : (passFg > 0.5 ? 0.5 : 0.0);

  fragColor = vec4(bgReach, fgReach, passBg, coreAndPassFg);
}`;

const FLOOD_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_maskTex;
uniform vec2 u_maskTexel;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec4 self = texture(u_maskTex, v_uv);
  float bgReach = self.r;
  float fgReach = self.g;
  float passBg = self.b;
  bool passFg = self.a > 0.25;

  if (passBg < 0.5 && !passFg) {
    fragColor = self;
    return;
  }

  const vec2 dirs8[8] = vec2[8](
    vec2( 1.0,  0.0), vec2( 1.0, -1.0),
    vec2( 0.0, -1.0), vec2(-1.0, -1.0),
    vec2(-1.0,  0.0), vec2(-1.0,  1.0),
    vec2( 0.0,  1.0), vec2( 1.0,  1.0)
  );

  // 패스당 최대 24 마스크 텍셀씩 전파하되 장벽(불투명 벽 / 투명 끊김)을 만나면 즉시 중단
  for (int d = 0; d < 8; d++) {
    bool isCardinal = (d == 0 || d == 2 || d == 4 || d == 6);
    bool openBg = isCardinal && (passBg > 0.5) && (bgReach < 0.5);
    bool openFg = passFg && (fgReach < 0.5);
    if (!openBg && !openFg) continue;

    for (int k = 1; k <= 24; k++) {
      if (!openBg && !openFg) break;
      vec2 sampleUv = v_uv + dirs8[d] * u_maskTexel * float(k);
      if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) {
        if (openBg) {
          bgReach = 1.0;
          openBg = false;
        }
        openFg = false;
        break;
      }
      vec4 s = texture(u_maskTex, sampleUv);
      if (openBg) {
        if (s.b < 0.5) {
          openBg = false;
        } else if (s.r > 0.5) {
          bgReach = 1.0;
          openBg = false;
        }
      }
      if (openFg) {
        if (s.a < 0.25) {
          openFg = false;
        } else if (s.g > 0.5) {
          fgReach = 1.0;
          openFg = false;
        }
      }
    }
  }

  fragColor = vec4(bgReach, fgReach, passBg, self.a);
}`;

const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform sampler2D u_maskTex;
uniform vec3 u_key;
uniform float u_thresh;
uniform float u_smooth;
uniform float u_despill;
uniform int u_mode;
uniform vec2 u_texel;
uniform vec2 u_maskTexel;
in vec2 v_uv;
out vec4 fragColor;

float luma(vec3 rgb) {
  return dot(rgb, vec3(0.299, 0.587, 0.114));
}

float sampleBaseA(vec2 uv) {
  vec4 c0 = texture(u_tex, uv);
  float a0 = c0.a;
  if (a0 > 0.02 && a0 < 0.80 && (c0.b - c0.r > 0.045 && c0.g - c0.r > 0.02)) {
    float aU1 = texture(u_tex, uv + vec2(0.0, -1.0) * u_texel).a;
    float aU2 = texture(u_tex, uv + vec2(0.0, -2.0) * u_texel).a;
    if (aU1 < 0.05 || (aU1 < 0.80 && aU2 < 0.05)) {
      return 0.0;
    }
  }
  return a0;
}

float sampleCleanA(vec2 uv) {
  float baseA = sampleBaseA(uv);
  if (baseA >= 0.80) return baseA;
  float aU1 = sampleBaseA(uv + vec2(0.0, -1.0) * u_texel);
  float aU2 = sampleBaseA(uv + vec2(0.0, -2.0) * u_texel);
  float aD1 = sampleBaseA(uv + vec2(0.0, 1.0) * u_texel);
  float aD2 = sampleBaseA(uv + vec2(0.0, 2.0) * u_texel);
  float aD3 = sampleBaseA(uv + vec2(0.0, 3.0) * u_texel);
  float aL1 = sampleBaseA(uv + vec2(-1.0, 0.0) * u_texel);
  float aL2 = sampleBaseA(uv + vec2(-2.0, 0.0) * u_texel);
  float aR1 = sampleBaseA(uv + vec2(1.0, 0.0) * u_texel);
  float aR2 = sampleBaseA(uv + vec2(2.0, 0.0) * u_texel);
  bool vBridge = (max(aU1, aU2) >= 0.80 && max(aD1, aD2) >= 0.80 && max(max(aD1, aD2), aD3) >= 0.85 && aU2 >= 0.55);
  bool hBridge = (max(aL1, aL2) >= 0.80 && max(aR1, aR2) >= 0.80 && max(aD1, aD2) >= 0.80 && aL2 >= 0.80 && aR2 >= 0.80);
  if (vBridge) baseA = max(baseA, min(max(aU1, aU2), max(aD1, aD2)));
  if (hBridge) baseA = max(baseA, min(max(aL1, aL2), max(aR1, aR2)));
  return baseA;
}

float sampleBgReach(vec2 uv) {
  vec2 d = u_maskTexel;
  float sum = texture(u_maskTex, uv).r * 4.0;
  sum += texture(u_maskTex, uv + vec2( d.x,  0.0)).r * 2.0;
  sum += texture(u_maskTex, uv + vec2(-d.x,  0.0)).r * 2.0;
  sum += texture(u_maskTex, uv + vec2( 0.0,  d.y)).r * 2.0;
  sum += texture(u_maskTex, uv + vec2( 0.0, -d.y)).r * 2.0;
  sum += texture(u_maskTex, uv + vec2( d.x,  d.y)).r;
  sum += texture(u_maskTex, uv + vec2(-d.x,  d.y)).r;
  sum += texture(u_maskTex, uv + vec2( d.x, -d.y)).r;
  sum += texture(u_maskTex, uv + vec2(-d.x, -d.y)).r;
  return sum / 16.0;
}

float sampleBoundaryA(vec2 uv) {
  float ca = sampleCleanA(uv);
  if (ca >= 0.96) return ca;
  float extT = smoothstep(0.02, 0.35, sampleBgReach(uv));
  return mix(1.0, ca, extT);
}

void main() {
  vec4 c = texture(u_tex, v_uv);
  if (u_mode == 1) {
    vec3 rgb = c.rgb;
    float a = c.a;
    float cleanA = sampleCleanA(v_uv);

    const vec2 dirs[8] = vec2[8](
      vec2( 1.0,     0.0   ), vec2( 0.7071, -0.7071),
      vec2( 0.0,    -1.0   ), vec2(-0.7071, -0.7071),
      vec2(-1.0,     0.0   ), vec2(-0.7071,  0.7071),
      vec2( 0.0,     1.0   ), vec2( 0.7071,  0.7071)
    );
    const vec2 dirsGrid[8] = vec2[8](
      vec2( 1.0,  0.0), vec2( 1.0, -1.0),
      vec2( 0.0, -1.0), vec2(-1.0, -1.0),
      vec2(-1.0,  0.0), vec2(-1.0,  1.0),
      vec2( 0.0,  1.0), vec2( 1.0,  1.0)
    );

    vec4 mask0 = texture(u_maskTex, v_uv);
    float bgReach = sampleBgReach(v_uv);
    float fgReach = mask0.g;
    for (int d = 0; d < 8; d++) {
      vec2 nSrcUv = v_uv + dirsGrid[d] * u_texel;
      if (sampleBaseA(nSrcUv) >= 0.75) {
        fgReach = max(fgReach, texture(u_maskTex, nSrcUv).g);
      }
    }

    // 1. 바깥과 이어진 투명 배경(bgReach >= 0.35) -> 즉시 투명 유지
    if (cleanA <= 0.02 && bgReach >= 0.35) {
      fragColor = vec4(0.0);
      return;
    }

    // 2. 바깥과 이어지지 않은 내부 영역(bgReach < 0.35) -> 색·휘도 문턱과 무관하게 내부 구멍 메움
    if (bgReach < 0.35) {
      if (a >= 0.96 && cleanA >= 0.96 && fgReach > 0.5 && bgReach < 0.02) {
        fragColor = vec4(rgb, 1.0);
        return;
      }
      if (a < 0.85) {
        vec3 holeFillSum = vec3(0.0);
        float holeFillW = 0.0;
        float nearFg = fgReach;
        int hitDirs = 0;
        for (int d = 0; d < 8; d++) {
          bool dirHit = false;
          for (int step = 1; step <= 14; step++) {
            float r = step <= 8 ? float(step) : float(8 + (step - 8) * 2);
            vec2 uvR = v_uv + dirs[d] * u_texel * r;
            vec4 sr = texture(u_tex, uvR);
            float sra = sampleBaseA(uvR);
            nearFg = max(nearFg, texture(u_maskTex, uvR).g);
            if (sra >= 0.65) {
              if (sra >= 0.85) {
                dirHit = true;
              }
              vec3 cleanSr = sr.rgb;
              float srL = luma(cleanSr);
              float srChroma = max(cleanSr.r, max(cleanSr.g, cleanSr.b)) - min(cleanSr.r, min(cleanSr.g, cleanSr.b));
              if (srL < 0.28 && srChroma < 0.12) {
                cleanSr.g = min(cleanSr.g, max(cleanSr.r, cleanSr.b) + 0.02);
              }
              float w = (sra * sra) / r;
              holeFillSum += cleanSr * w;
              holeFillW += w;
            }
          }
          if (dirHit) {
            hitDirs++;
          }
        }
        int minDirs = fgReach > 0.5 ? 3 : 6;
        if (holeFillW > 0.0 && nearFg > 0.5 && hitDirs >= minDirs) {
          fgReach = 1.0;
          vec3 fillRgb = holeFillSum / holeFillW;
          float fillL = luma(fillRgb);
          float fillChroma = max(fillRgb.r, max(fillRgb.g, fillRgb.b)) - min(fillRgb.r, min(fillRgb.g, fillRgb.b));
          if (fillL < 0.26 && fillChroma < 0.12) {
            rgb.g = min(rgb.g, max(rgb.r, rgb.b) + 0.02);
            if (fillRgb.b <= fillRgb.r + 0.04) {
              rgb.g = min(rgb.g, rgb.r + 0.02);
              rgb.b = min(rgb.b, rgb.r + 0.03);
            }
          }
          rgb = mix(fillRgb, rgb, smoothstep(0.15, 0.85, a));
          if (bgReach < 0.02) {
            fragColor = vec4(rgb, 1.0);
            return;
          }
          cleanA = mix(1.0, cleanA, smoothstep(0.02, 0.35, bgReach));
          a = cleanA;
        }
      }
    }

    if (cleanA <= 0.02) {
      fragColor = vec4(0.0);
      return;
    }

    // 3. 주 피사체와 이어지지 않은 떨어진 섬(fgReach < 0.5) -> 크기·방향과 무관하게 제거
    if (fgReach < 0.5) {
      fragColor = vec4(0.0);
      return;
    }

    // 외곽 경계에서 1px 투명 도랑으로 주 피사체와 분리된 잔여 고립 조각 제거
    if (bgReach >= 0.35) {
      float bL1 = sampleBaseA(v_uv + vec2(-1.0,  0.0) * u_texel);
      float bR1 = sampleBaseA(v_uv + vec2( 1.0,  0.0) * u_texel);
      float bU1 = sampleBaseA(v_uv + vec2( 0.0, -1.0) * u_texel);
      float bD1 = sampleBaseA(v_uv + vec2( 0.0,  1.0) * u_texel);
      if ((bL1 < 0.08 && bR1 < 0.08 && (bU1 < 0.08 || bD1 < 0.08 || a < 0.95)) ||
          (bU1 < 0.08 && bD1 < 0.08 && (bL1 < 0.08 || bR1 < 0.08 || a < 0.95))) {
        fragColor = vec4(0.0);
        return;
      }
    }

    float minA1 = cleanA;
    float minA2 = cleanA;
    float minA3 = cleanA;
    float sumA1 = cleanA;
    float sumA2 = 0.0;
    for (int d = 0; d < 8; d++) {
      float a1 = sampleBoundaryA(v_uv + dirs[d] * u_texel * 1.25);
      float a2 = sampleBoundaryA(v_uv + dirs[d] * u_texel * 2.25);
      float a3 = sampleBoundaryA(v_uv + dirs[d] * u_texel * 3.25);
      minA1 = min(minA1, a1);
      minA2 = min(minA2, a2);
      minA3 = min(minA3, a3);
      sumA1 += a1;
      sumA2 += a2;
    }
    float avgA1 = sumA1 / 9.0;
    float avgA2 = sumA2 / 8.0;

    if (a >= 0.98 && minA3 >= 0.96) {
      fragColor = vec4(rgb, 1.0);
      return;
    }

    if (minA3 < 0.96 || cleanA < 0.98) {
      // 색 테두리 정리(despill 및 내부 피사체 색 복원)
      float bestLuma = 0.0;
      vec3 bestRgb = rgb;
      vec3 sumInRgb = vec3(0.0);
      float inWeight = 0.0;
      for (int d = 0; d < 8; d++) {
        for (int r = 3; r <= 6; r++) {
          vec4 s = texture(u_tex, v_uv + dirs[d] * u_texel * float(r));
          vec4 sNext = texture(u_tex, v_uv + dirs[d] * u_texel * float(r + 1));
          if (s.a >= 0.96 && sNext.a >= 0.96) {
            float sl = luma(s.rgb);
            float w = sl + 0.1;
            sumInRgb += s.rgb * w;
            inWeight += w;
            if (sl > bestLuma) {
              bestLuma = sl;
              bestRgb = s.rgb;
            }
          }
        }
      }
      vec3 avgInRgb = inWeight > 0.0 ? (sumInRgb / inWeight) : rgb;
      float inLuma = inWeight > 0.0 ? luma(avgInRgb) : luma(rgb);
      float inChroma = max(avgInRgb.r, max(avgInRgb.g, avgInRgb.b)) - min(avgInRgb.r, min(avgInRgb.g, avgInRgb.b));
      float curChroma = max(rgb.r, max(rgb.g, rgb.b)) - min(rgb.r, min(rgb.g, rgb.b));
      bool isDarkHairEdge = (inLuma < 0.22 && luma(rgb) < 0.25 && inChroma < 0.12 && curChroma < 0.12);

      if (a < 0.98 && !isDarkHairEdge) {
        rgb = clamp(rgb / max(a, 0.28), 0.0, 1.0);
      }
      rgb.g = min(rgb.g, max(rgb.r, rgb.b) + 0.03);

      if (inWeight > 0.0) {
        if (isDarkHairEdge) {
          if (avgInRgb.b <= avgInRgb.r + 0.04) {
            rgb.g = min(rgb.g, rgb.r + 0.02);
            rgb.b = min(rgb.b, rgb.r + 0.03);
          }
          rgb = mix(avgInRgb, rgb, smoothstep(0.30, 0.90, a));
        } else {
          vec3 targetRgb = mix(avgInRgb, bestRgb, 0.6);
          float curLuma = luma(rgb);
          float targetLuma = luma(targetRgb);
          float targetChroma = max(targetRgb.r, max(targetRgb.g, targetRgb.b)) - min(targetRgb.r, min(targetRgb.g, targetRgb.b));
          if (curLuma < targetLuma - 0.03 || (targetChroma >= 0.12 && curChroma < targetChroma * 0.65)) {
            float lumaDiff = clamp((targetLuma - curLuma) / max(0.08, targetLuma), 0.0, 1.0);
            float chromaDiff = targetChroma >= 0.12 ? clamp((targetChroma - curChroma) / targetChroma, 0.0, 1.0) : 0.0;
            float replaceT = clamp(max(lumaDiff, chromaDiff), 0.35, 1.0);
            rgb = mix(rgb, targetRgb, replaceT);
          }
        }
      }

      // 주 피사체에 연결(fgReach > 0.5)된 1~2px 가는 선(가로·세로·대각선·곡선) 보존:
      // 진행 방향(8방위)을 따라 연속 불투명하면서 양쪽 수직 방향(1~2px 폭 초과 금지 및 2, 4, 6px 투명 배경)인 경우 보존
      bool isConnectedStrand = false;
      if (cleanA >= 0.85) {
        for (int d = 0; d < 8; d++) {
          vec2 tang = dirsGrid[d];
          vec2 perp = vec2(-tang.y, tang.x);
          if (min(sampleBaseA(v_uv + perp * u_texel), sampleBaseA(v_uv - perp * u_texel)) >= 0.05 ||
              sampleBaseA(v_uv + perp * u_texel * 2.0) >= 0.05 ||
              sampleBaseA(v_uv - perp * u_texel * 2.0) >= 0.05 ||
              sampleBaseA(v_uv + perp * u_texel * 4.0) >= 0.05 ||
              sampleBaseA(v_uv - perp * u_texel * 4.0) >= 0.05 ||
              sampleBaseA(v_uv + perp * u_texel * 6.0) >= 0.05 ||
              sampleBaseA(v_uv - perp * u_texel * 6.0) >= 0.05) {
            continue;
          }
          bool validRay = true;
          for (int r = 1; r <= 6; r++) {
            vec2 p = v_uv + tang * u_texel * float(r);
            if (sampleBaseA(p) < 0.85) {
              validRay = false;
              break;
            }
            if (min(sampleBaseA(p + perp * u_texel), sampleBaseA(p - perp * u_texel)) >= 0.05 ||
                sampleBaseA(p + perp * u_texel * 2.0) >= 0.05 ||
                sampleBaseA(p - perp * u_texel * 2.0) >= 0.05 ||
                sampleBaseA(p + perp * u_texel * 4.0) >= 0.05 ||
                sampleBaseA(p - perp * u_texel * 4.0) >= 0.05 ||
                sampleBaseA(p + perp * u_texel * 6.0) >= 0.05 ||
                sampleBaseA(p - perp * u_texel * 6.0) >= 0.05) {
              validRay = false;
              break;
            }
          }
          if (validRay) {
            isConnectedStrand = true;
            break;
          }
        }
      }

      if (isConnectedStrand) {
        a = cleanA;
      } else {
        // 4. 외곽 경계 매끄럽게 하기: 위치·색 문턱 없이 순수 알파 기반으로 경계 들쭉날쭉함을 정돈
        float erode1 = smoothstep(0.45, 0.96, mix(minA1, avgA1, 0.25));
        float erode2 = smoothstep(0.25, 0.90, mix(minA2, avgA2, 0.45));
        float erodedA = mix(min(cleanA, avgA1), avgA1, 0.35) * erode1 * mix(0.20, 1.0, erode2);
        a = mix(1.0, erodedA, smoothstep(0.02, 0.35, bgReach));
        if (a < 0.05 || (a < 0.25 && erode1 < 0.20)) {
          a = 0.0;
        }
      }
    } else {
      a = cleanA;
    }
    fragColor = vec4(rgb, a);
    return;
  }

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

function linkProgram(
	gl: WebGL2RenderingContext,
	vsSrc: string,
	fsSrc: string,
): WebGLProgram {
	const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
	const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
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
	return program;
}

export class NvaChromakeyGL {
	private readonly canvas: HTMLCanvasElement;
	private readonly gl: WebGL2RenderingContext;
	private readonly program: WebGLProgram;
	private readonly seedProgram: WebGLProgram | null = null;
	private readonly floodProgram: WebGLProgram | null = null;
	private readonly tex: WebGLTexture;
	private readonly maskTexA: WebGLTexture | null = null;
	private readonly maskTexB: WebGLTexture | null = null;
	private readonly fboA: WebGLFramebuffer | null = null;
	private readonly fboB: WebGLFramebuffer | null = null;
	private readonly vbo: WebGLBuffer | null;
	private readonly uKey: WebGLUniformLocation | null;
	private readonly uThresh: WebGLUniformLocation | null;
	private readonly uSmooth: WebGLUniformLocation | null;
	private readonly uDespill: WebGLUniformLocation | null;
	private readonly uMode: WebGLUniformLocation | null;
	private readonly uTexel: WebGLUniformLocation | null;
	private readonly uMaskTex: WebGLUniformLocation | null;
	private readonly uMaskTexel: WebGLUniformLocation | null;
	private readonly uSeedTex: WebGLUniformLocation | null = null;
	private readonly uSeedSrcTexel: WebGLUniformLocation | null = null;
	private readonly uSeedMaskTexel: WebGLUniformLocation | null = null;
	private readonly uFloodMaskTex: WebGLUniformLocation | null = null;
	private readonly uFloodMaskTexel: WebGLUniformLocation | null = null;
	private maskW = 0;
	private maskH = 0;
	private hasRenderedFrame = false;
	private lastVideoSource: HTMLVideoElement | null = null;
	private lastVideoSrc = "";
	private lastVideoTime = -1;
	private lastWidth = 0;
	private lastHeight = 0;
	private lastMode: "chromakey" | "alpha-repair" = "chromakey";
	private mode: "chromakey" | "alpha-repair";
	private key: [number, number, number];
	private threshold: number;
	private smoothness: number;
	private despill: number;
	private disposed = false;

	constructor(opts: ChromakeyOpts = {}) {
		this.mode = opts.mode ?? "chromakey";
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

		const program = linkProgram(gl, VERT, FRAG);
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

		if (typeof gl.createFramebuffer === "function") {
			this.seedProgram = linkProgram(gl, VERT_FBO, SEED_FRAG);
			this.floodProgram = linkProgram(gl, VERT_FBO, FLOOD_FRAG);
			for (const p of [this.seedProgram, this.floodProgram]) {
				const aLoc = gl.getAttribLocation(p, "a_pos");
				gl.enableVertexAttribArray(aLoc);
				gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);
			}
			this.uSeedTex = gl.getUniformLocation(this.seedProgram, "u_tex");
			this.uSeedSrcTexel = gl.getUniformLocation(this.seedProgram, "u_srcTexel");
			this.uSeedMaskTexel = gl.getUniformLocation(
				this.seedProgram,
				"u_maskTexel",
			);
			this.uFloodMaskTex = gl.getUniformLocation(
				this.floodProgram,
				"u_maskTex",
			);
			this.uFloodMaskTexel = gl.getUniformLocation(
				this.floodProgram,
				"u_maskTexel",
			);
			this.maskTexA = gl.createTexture();
			this.maskTexB = gl.createTexture();
			this.fboA = gl.createFramebuffer();
			this.fboB = gl.createFramebuffer();
		}

		gl.useProgram(program);
		gl.uniform1i(gl.getUniformLocation(program, "u_tex"), 0);
		this.uMaskTex = gl.getUniformLocation(program, "u_maskTex");
		this.uMaskTexel = gl.getUniformLocation(program, "u_maskTexel");
		this.uKey = gl.getUniformLocation(program, "u_key");
		this.uThresh = gl.getUniformLocation(program, "u_thresh");
		this.uSmooth = gl.getUniformLocation(program, "u_smooth");
		this.uDespill = gl.getUniformLocation(program, "u_despill");
		this.uMode = gl.getUniformLocation(program, "u_mode");
		this.uTexel = gl.getUniformLocation(program, "u_texel");
	}

	private ensureMaskFbos(mw: number, mh: number): void {
		if (mw === this.maskW && mh === this.maskH) return;
		const gl = this.gl;
		if (!this.maskTexA || !this.maskTexB || !this.fboA || !this.fboB) return;
		this.maskW = mw;
		this.maskH = mh;
		for (const [t, f] of [
			[this.maskTexA, this.fboA],
			[this.maskTexB, this.fboB],
		] as const) {
			gl.bindTexture(gl.TEXTURE_2D, t);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texImage2D(
				gl.TEXTURE_2D,
				0,
				gl.RGBA,
				mw,
				mh,
				0,
				gl.RGBA,
				gl.UNSIGNED_BYTE,
				null,
			);
			gl.bindFramebuffer(gl.FRAMEBUFFER, f);
			gl.framebufferTexture2D(
				gl.FRAMEBUFFER,
				gl.COLOR_ATTACHMENT0,
				gl.TEXTURE_2D,
				t,
				0,
			);
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	/** 키 파라미터 런타임 조정(정합/키잉 튜닝). clamp 적용. */
	setParams(p: ChromakeyOpts): void {
		if (p.mode) this.mode = p.mode;
		else if (p.keyColor) this.mode = "chromakey";
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

		const isVideo =
			typeof HTMLVideoElement !== "undefined" &&
			source instanceof HTMLVideoElement;
		const videoSrc = isVideo
			? source.currentSrc ||
				source.src ||
				(source as HTMLElement).dataset?.naiaClipUrl ||
				""
			: "";
		const videoTime = isVideo ? source.currentTime : -1;

		// 클립·프레임(currentTime)·해상도·모드가 바뀌지 않았으면 이전 GPU 합성 캔버스를 그대로 재사용 (휴대폰 60Hz 루프 성능 최적화)
		if (
			isVideo &&
			this.hasRenderedFrame &&
			this.lastVideoSource === source &&
			this.lastVideoSrc === videoSrc &&
			this.lastVideoTime === videoTime &&
			this.lastWidth === w &&
			this.lastHeight === h &&
			this.lastMode === this.mode &&
			this.canvas.width === w &&
			this.canvas.height === h
		) {
			return this.canvas;
		}

		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}

		const srcW =
			(source as HTMLVideoElement).videoWidth ||
			(source as HTMLCanvasElement).width ||
			w;
		const srcH =
			(source as HTMLVideoElement).videoHeight ||
			(source as HTMLCanvasElement).height ||
			h;
		const invSrcW = 1 / Math.max(1, srcW);
		const invSrcH = 1 / Math.max(1, srcH);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, this.tex);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // uv 반전은 셰이더가 처리
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

		if (
			this.mode === "alpha-repair" &&
			this.seedProgram &&
			this.floodProgram &&
			this.maskTexA &&
			this.maskTexB &&
			this.fboA &&
			this.fboB
		) {
			const scale = srcW > 360 || srcH > 640 ? 0.5 : 1.0;
			const mw = Math.max(1, Math.round(srcW * scale));
			const mh = Math.max(1, Math.round(srcH * scale));
			this.ensureMaskFbos(mw, mh);
			const invMaskW = 1 / mw;
			const invMaskH = 1 / mh;

			gl.bindTexture(gl.TEXTURE_2D, this.maskTexA);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.bindTexture(gl.TEXTURE_2D, this.tex);

			// Pass 1: 원본 알파 기반 바깥 배경 시드(가장자리) + 주 피사체 코어 시드 생성
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
			gl.viewport(0, 0, mw, mh);
			gl.useProgram(this.seedProgram);
			if (this.uSeedTex) gl.uniform1i(this.uSeedTex, 0);
			if (this.uSeedSrcTexel)
				gl.uniform2f(this.uSeedSrcTexel, invSrcW, invSrcH);
			if (this.uSeedMaskTexel)
				gl.uniform2f(this.uSeedMaskTexel, invMaskW, invMaskH);
			gl.drawArrays(gl.TRIANGLES, 0, 6);

			// Pass 2: 낮춘 해상도 핑퐁 FBO 채우기(flood) 반복으로 바깥 배경 연결성(bgReach) 및 피사체 연결성(fgReach) 계산
			gl.useProgram(this.floodProgram);
			if (this.uFloodMaskTex) gl.uniform1i(this.uFloodMaskTex, 1);
			if (this.uFloodMaskTexel)
				gl.uniform2f(this.uFloodMaskTexel, invMaskW, invMaskH);
			gl.activeTexture(gl.TEXTURE1);
			for (let i = 0; i < 8; i++) {
				gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboB);
				gl.bindTexture(gl.TEXTURE_2D, this.maskTexA);
				gl.drawArrays(gl.TRIANGLES, 0, 6);

				gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA);
				gl.bindTexture(gl.TEXTURE_2D, this.maskTexB);
				gl.drawArrays(gl.TRIANGLES, 0, 6);
			}

			// Pass 3: 원본 해상도에서 구멍 메움 · 떨어진 섬 제거 · 외곽 테두리 스무딩 합성
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, this.maskTexA);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, this.tex);
		}

		gl.viewport(0, 0, w, h);
		gl.useProgram(this.program);
		gl.uniform3f(this.uKey, this.key[0], this.key[1], this.key[2]);
		gl.uniform1f(this.uThresh, this.threshold);
		gl.uniform1f(this.uSmooth, this.smoothness);
		gl.uniform1f(this.uDespill, this.despill);
		if (this.uMode) {
			gl.uniform1i?.(this.uMode, this.mode === "alpha-repair" ? 1 : 0);
		}
		if (this.uTexel) {
			gl.uniform2f?.(this.uTexel, invSrcW, invSrcH);
		}
		if (this.uMaskTex) {
			gl.uniform1i?.(this.uMaskTex, 1);
		}
		if (this.uMaskTexel) {
			gl.uniform2f?.(
				this.uMaskTexel,
				1 / Math.max(1, this.maskW || srcW),
				1 / Math.max(1, this.maskH || srcH),
			);
		}

		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.drawArrays(gl.TRIANGLES, 0, 6);

		this.hasRenderedFrame = true;
		this.lastVideoSource = isVideo ? source : null;
		this.lastVideoSrc = videoSrc;
		this.lastVideoTime = videoTime;
		this.lastWidth = w;
		this.lastHeight = h;
		this.lastMode = this.mode;
		return this.canvas;
	}

	/** WebGL 리소스 해제. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const gl = this.gl;
		gl.deleteTexture(this.tex);
		if (this.maskTexA) gl.deleteTexture(this.maskTexA);
		if (this.maskTexB) gl.deleteTexture(this.maskTexB);
		if (this.fboA) gl.deleteFramebuffer?.(this.fboA);
		if (this.fboB) gl.deleteFramebuffer?.(this.fboB);
		gl.deleteBuffer(this.vbo);
		gl.deleteProgram(this.program);
		if (this.seedProgram) gl.deleteProgram(this.seedProgram);
		if (this.floodProgram) gl.deleteProgram(this.floodProgram);
		gl.getExtension("WEBGL_lose_context")?.loseContext();
	}
}
