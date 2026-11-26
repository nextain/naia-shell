/** @spec SPEC-004 — eval-anchored 검증. 운영자 정답(GoldQA)을 루프 밖 합격 기준 삼아 KB 자가검증. 결정론.
 * 리뷰 반영: 질문 관련성 + 정답 재현 둘 다 요구(F1 stuffing/순환 완화), score는 accepted 기준(F3), 모순은 다중 필드(F5).
 */
import messages from "../ko-messages.json";
import { interpolateMessage } from "../interpolate-message";
import type { RetrievalPort } from "../domain/ports.js";
import type { Kb, GoldQA, Gap, VerifyResult, ServiceCard } from "../domain/types.js";
import { coverage, normalize } from "./text.js";

const ANSWER_THRESHOLD = 0.6; // Required answer coverage.
const QUESTION_THRESHOLD = 0.5; // Required question coverage.
const CONTRADICTION_FIELDS = ["fee", "hours", "department", "documents", "phone", "eligibility"];

function cardText(c: ServiceCard): string {
  return [c.title, ...Object.values(c.fields)].join(" ");
}

export async function verify(
  kb: Kb,
  gold: GoldQA[],
  retrieval: RetrievalPort,
  lowConfidenceThreshold = 0.5,
): Promise<VerifyResult> {
  await retrieval.index(kb);
  const gaps: Gap[] = [];
  const accepted = new Set<string>();
  let answered = 0; // Count accepted answers only.

  for (const qa of gold) {
    const hits = await retrieval.search(qa.q, 3);
    // 질문 관련 + 정답 재현 둘 다 충족하는 카드 (정답만 든 무관 카드 배제)
    const best = hits.find((c) => coverage(qa.q, cardText(c)) >= QUESTION_THRESHOLD) ?? hits[0];
    if (!best) {
      gaps.push({ kind: "unanswered", detail: interpolateMessage(messages.noAnswer, { question: qa.q }), gold: qa });
      continue;
    }
    const qCov = coverage(qa.q, cardText(best));
    const aCov = coverage(qa.a, cardText(best));
    if (qCov >= QUESTION_THRESHOLD && aCov >= ANSWER_THRESHOLD) {
      if (best.confidence >= lowConfidenceThreshold) {
        accepted.add(best.id);
        answered++;
      } else {
        gaps.push({
          kind: "low_confidence",
          detail: interpolateMessage(messages.lowConfidenceUnaccepted, {
            title: best.title,
            confidence: best.confidence.toFixed(2),
            minimum: lowConfidenceThreshold,
          }),
          gold: qa,
          cardId: best.id,
        });
      }
    } else if (qCov < QUESTION_THRESHOLD) {
      gaps.push({ kind: "unanswered", detail: interpolateMessage(messages.noRelevantCard, { question: qa.q }), gold: qa });
    } else {
      gaps.push({
        kind: "mismatch",
        detail: interpolateMessage(messages.answerNotReproduced, { question: qa.q, coverage: aCov.toFixed(2) }),
        gold: qa,
        cardId: best.id,
      });
    }
  }

  // 저신뢰 카드(정답 매칭과 무관) 표면화
  for (const c of kb.cards) {
    if (c.confidence < lowConfidenceThreshold && !gaps.some((g) => g.cardId === c.id)) {
      gaps.push({
        kind: "low_confidence",
        detail: interpolateMessage(messages.lowConfidence, {
          title: c.title,
          confidence: c.confidence.toFixed(2),
          minimum: lowConfidenceThreshold,
        }),
        cardId: c.id,
      });
    }
  }

  // 모순: 동일 제목, 주요 필드 값 충돌
  const byTitle = new Map<string, ServiceCard[]>();
  for (const c of kb.cards) {
    const key = normalize(c.title);
    const arr = byTitle.get(key) ?? [];
    arr.push(c);
    byTitle.set(key, arr);
  }
  for (const group of byTitle.values()) {
    if (group.length < 2) continue;
    for (const field of CONTRADICTION_FIELDS) {
      const vals = new Set(group.map((c) => c.fields[field]).filter(Boolean));
      if (vals.size > 1) {
        for (const c of group) {
          gaps.push({
            kind: "contradiction",
            detail: interpolateMessage(messages.contradiction, { title: c.title, field, choices: [...vals].join(" vs ") }),
            cardId: c.id,
          });
          accepted.delete(c.id);
        }
      }
    }
  }

  return {
    score: gold.length ? answered / gold.length : 1,
    acceptedCardIds: [...accepted],
    gaps,
  };
}
