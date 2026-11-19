/** @spec SPEC-010 — 개인정보(PII)·대외비 탐지/경고/레닥션 (D05 안전 우선). 결정론.
 * 내부 기밀자료를 외부 LLM(클라우드)에 보내기 전 스캔 → 경고/레닥션/차단.
 */

export type SensitiveKind = "rrn" | "phone" | "email" | "card" | "account" | "passport" | "confidential";
export type Severity = "pii" | "confidential";

export interface SensitiveFinding {
  kind: SensitiveKind;
  severity: Severity;
  sample: string; // 마스킹된 예시(원문 노출 금지)
  count: number;
  sourceId?: string;
}

export type SafetyMode = "warn" | "redact" | "block";

interface Rule {
  kind: SensitiveKind;
  severity: Severity;
  re: RegExp;
}

// 주민번호: 6자리-[1-4]+6자리 (생년월일 오탐 줄이려 7번째 1~4)
const PII_RULES: Rule[] = [
  { kind: "rrn", severity: "pii", re: /\b\d{6}-?[1-4]\d{6}\b/g },
  { kind: "card", severity: "pii", re: /\b\d{4}-\d{4}-\d{4}-\d{4}\b/g },
  { kind: "phone", severity: "pii", re: /\b01[016789]-?\d{3,4}-?\d{4}\b/g },
  { kind: "passport", severity: "pii", re: /\b[A-Z]\d{8}\b/g },
  { kind: "email", severity: "pii", re: /\b[\w.+-]+@[\w-]+\.[\w][\w.-]*\b/g },
  { kind: "account", severity: "pii", re: /(계좌|account)\D{0,6}\d{2,}-?\d{2,}-?\d{2,}/gi },
];

// 대외비/기밀 마커 (텍스트는 redact 안 함 — 경고만)
const CONFIDENTIAL_TERMS = ["대외비", "기밀", "비밀", "영업비밀", "내부자료", "내부용", "대외주의", "confidential", "secret", "proprietary", "do not distribute"];

function maskSample(s: string): string {
  if (s.length <= 4) return "█".repeat(s.length);
  return s.slice(0, 2) + "█".repeat(Math.max(2, s.length - 4)) + s.slice(-2);
}

/** 텍스트 1건 스캔 → findings. */
export function scanSensitive(text: string, sourceId?: string): SensitiveFinding[] {
  const t = (text ?? "").normalize("NFC");
  const out: SensitiveFinding[] = [];

  for (const rule of PII_RULES) {
    const matches = t.match(rule.re);
    if (matches && matches.length) {
      out.push({ kind: rule.kind, severity: "pii", sample: maskSample(matches[0]), count: matches.length, sourceId });
    }
  }
  const low = t.toLowerCase();
  let confCount = 0;
  let confSample = "";
  for (const term of CONFIDENTIAL_TERMS) {
    const re = new RegExp(term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const m = low.match(re);
    if (m) {
      confCount += m.length;
      if (!confSample) confSample = term;
    }
  }
  if (confCount > 0) out.push({ kind: "confidential", severity: "confidential", sample: confSample, count: confCount, sourceId });

  return out;
}

/** PII 를 마스킹(대외비 키워드는 보존 — 경고 대상이지 비밀값 아님). */
export function redact(text: string): { text: string; redactedCount: number } {
  let redactedCount = 0;
  let out = text ?? "";
  for (const rule of PII_RULES) {
    out = out.replace(rule.re, (_m) => {
      redactedCount++;
      return `█[${rule.kind}]`;
    });
  }
  return { text: out, redactedCount };
}

export interface SafetyReport {
  findings: SensitiveFinding[];
  piiCount: number;
  confidentialCount: number;
  mode: SafetyMode;
  redactedCount: number;
}

export class SafetyBlockedError extends Error {
  constructor(public report: SafetyReport) {
    super(`민감정보 차단(block): PII ${report.piiCount}건 · 대외비 ${report.confidentialCount}건`);
  }
}

/** 여러 소스 일괄 스캔 + 모드별 처리. redact 시 텍스트 변형본 반환. */
export function applySafety(
  sources: { id?: string; text: string }[],
  mode: SafetyMode = "warn",
): { sources: { id?: string; text: string }[]; report: SafetyReport } {
  const findings: SensitiveFinding[] = [];
  for (const s of sources) findings.push(...scanSensitive(s.text, s.id));
  const piiCount = findings.filter((f) => f.severity === "pii").reduce((a, f) => a + f.count, 0);
  const confidentialCount = findings.filter((f) => f.severity === "confidential").reduce((a, f) => a + f.count, 0);

  const report: SafetyReport = { findings, piiCount, confidentialCount, mode, redactedCount: 0 };

  if (mode === "block" && findings.length > 0) {
    throw new SafetyBlockedError(report);
  }
  if (mode === "redact") {
    const red = sources.map((s) => {
      const r = redact(s.text);
      report.redactedCount += r.redactedCount;
      return { id: s.id, text: r.text };
    });
    return { sources: red, report };
  }
  return { sources, report };
}
