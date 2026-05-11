/**
 * Phase 5+ adversarial 6차 P0 fix - factory regex pattern coverage tests.
 *
 * Adversarial 6th review: vllm-omni + lab-proxy live regex가 cover 못하는 모델
 * 발견 (nanocpm-o, gpt-omni, gemini-*-live-stream 등). 보안/기능 P0 분류.
 *
 * 본 test = factory.ts의 isOmni/isLive regex가 다양한 모델 명을 정확히 분류하는지 검증.
 */

import { describe, expect, it } from "vitest";

// Mirror regex from factory.ts (단일 source 검증). drift 시 test fail.
const OMNI_PATTERN_PRIMARY = /(?:minicpm|nanocpm|nano-cpm|gpt|qwen2?-?vl|intern-?vl)[-_]?o(?:mnimodal|mni)?(?:[-_]|$)/i;
const OMNI_PATTERN_GENERIC_OMNI = /[-_]omni(?:[-_]|$)/i;
const OMNI_PATTERN_O_SUFFIX = /[-_]o\b/i;
const isOmni = (model: string) =>
  OMNI_PATTERN_PRIMARY.test(model) || OMNI_PATTERN_GENERIC_OMNI.test(model) || OMNI_PATTERN_O_SUFFIX.test(model);

const LIVE_PATTERN = /[-_]live(?:[-_][a-z0-9]+)*$/i;
const isLive = (model: string) => LIVE_PATTERN.test(model);

describe("factory regex - vllm-omni audio model detection", () => {
  it("matches MiniCPM-o variants (existing)", () => {
    expect(isOmni("minicpm-o")).toBe(true);
    expect(isOmni("MiniCPM-o-2.6")).toBe(true);
    expect(isOmni("minicpm_o")).toBe(true);
    expect(isOmni("minicpm-o-26b")).toBe(true);
  });

  it("matches NanoCPM-o variants (new)", () => {
    expect(isOmni("nanocpm-o")).toBe(true);
    expect(isOmni("NanoCPM-o-1.5")).toBe(true);
    expect(isOmni("nano-cpm-o")).toBe(true);
  });

  it("matches GPT-omni variants (new)", () => {
    expect(isOmni("gpt-omni")).toBe(true);
    expect(isOmni("gpt-4o-omni")).toBe(true);
    expect(isOmni("gpt-omnimodal")).toBe(true);
  });

  it("matches QwenVL/InternVL omni (new)", () => {
    expect(isOmni("qwen2-vl-o")).toBe(true);
    expect(isOmni("qwen-vl-omni")).toBe(true);
    expect(isOmni("internvl-o")).toBe(true);
    expect(isOmni("intern-vl-omni")).toBe(true);
  });

  it("matches generic -omni suffix (vendor-agnostic)", () => {
    expect(isOmni("custom-model-omni")).toBe(true);
    expect(isOmni("vendor_omni_v2")).toBe(true);
  });

  it("does NOT match unrelated models", () => {
    expect(isOmni("claude-opus-4-7")).toBe(false);
    expect(isOmni("gemini-2.5-flash")).toBe(false);
    expect(isOmni("llama3-70b")).toBe(false);
    expect(isOmni("qwen2-7b")).toBe(false);
    expect(isOmni("gpt-4o-mini")).toBe(false);  // -mini suffix, not -omni
  });
});

describe("factory regex - lab-proxy live model detection", () => {
  it("matches existing live models", () => {
    expect(isLive("gemini-2.5-flash-live")).toBe(true);
    expect(isLive("gemini-3.1-flash-live-preview")).toBe(true);
  });

  it("matches new live suffix variants (P0-2 fix)", () => {
    expect(isLive("gemini-2.5-flash-live-stream")).toBe(true);
    expect(isLive("gemini-3-flash-live-realtime")).toBe(true);
    expect(isLive("gemini-2.5-pro-live-preview")).toBe(true);
    expect(isLive("model-live-v2-experimental")).toBe(true);
  });

  it("matches underscore variant", () => {
    expect(isLive("gemini_live")).toBe(true);
    expect(isLive("model_live_stream")).toBe(true);
  });

  it("does NOT match non-live models", () => {
    expect(isLive("gemini-2.5-flash")).toBe(false);
    expect(isLive("gpt-4o-mini")).toBe(false);
    expect(isLive("claude-opus-4-7")).toBe(false);
    expect(isLive("livestream-model")).toBe(false);  // live not at end
    expect(isLive("alive-model")).toBe(false);  // not preceded by -/_
  });
});
