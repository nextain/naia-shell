/** @spec SPEC-006 — Compile 오케스트레이션: ingest→extract→verify(eval-anchored)→store. */
import type { Adapters } from "../domain/ports.js";
import type { CompileInput, CompileResult, Kb, SafetySummary } from "../domain/types.js";
import { verify } from "./verify.js";
import { applySafety } from "./safety.js";

export async function compile(input: CompileInput, adapters: Adapters): Promise<CompileResult> {
  let sources = await adapters.ingest.ingest(input.sources);

  // 안전: 외부 추출 전 PII/대외비 스캔 → warn(기본)/redact/block
  const safe = applySafety(sources.map((s) => ({ id: s.id, text: s.text })), input.safety ?? "warn");
  const safety: SafetySummary = {
    findings: safe.report.findings,
    piiCount: safe.report.piiCount,
    confidentialCount: safe.report.confidentialCount,
    mode: safe.report.mode,
    redactedCount: safe.report.redactedCount,
  };
  if (input.safety === "redact") {
    const redacted = new Map(safe.sources.map((s) => [s.id, s.text]));
    sources = sources.map((s) => ({ ...s, text: redacted.get(s.id) ?? s.text }));
  }

  const ex = await adapters.extract.extract(sources);
  const kb: Kb = { cards: ex.cards, entities: ex.entities, relations: ex.relations };

  await adapters.retrieval.index(kb);

  let verifyResult;
  const threshold = input.lowConfidenceThreshold ?? 0.5;
  if (input.goldQA && input.goldQA.length) {
    verifyResult = await verify(kb, input.goldQA, adapters.retrieval, threshold);
    const acc = new Set(verifyResult.acceptedCardIds);
    const gapCards = new Set(verifyResult.gaps.map((g) => g.cardId).filter(Boolean) as string[]);
    for (const c of kb.cards) {
      c.status = acc.has(c.id) ? "accepted" : gapCards.has(c.id) ? "gap" : c.status;
    }
  }

  await adapters.store.save(kb);

  const acceptedCount = kb.cards.filter((c) => c.status === "accepted").length;
  const draftCount = kb.cards.filter((c) => c.status === "draft").length;
  const gapCount = verifyResult?.gaps.length ?? 0;

  return {
    kb,
    verify: verifyResult,
    safety,
    report: {
      sourceCount: sources.length,
      cardCount: kb.cards.length,
      entityCount: kb.entities.length,
      relationCount: kb.relations.length,
      acceptedCount,
      gapCount,
      draftCount,
      score: verifyResult?.score,
    },
  };
}
