// nva-core — NVA completed-media playback contract (browser + Node ESM)
//
// The public v0.3 contract contains only finished media. Generation and
// real-time processing are intentionally outside this repository. v0.2 is
// accepted only for read compatibility with existing local files.

import { SPEECH_UNITS } from "./speech-plan.js";

export const NVA_VERSION = "0.3";
export const READABLE_NVA_VERSIONS = Object.freeze(["0.2", NVA_VERSION]);

function isBundleRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. Legacy v0.2 playback helpers
// ─────────────────────────────────────────────────────────────────────────────
export function isTransition(a) {
  return (a?.entry_pose || "") !== (a?.exit_pose || "");
}

// 조합 → 종류 라벨 (UI 표기용).
export function animKind(a) {
  if (isTransition(a)) return "transition";
  if (a.loop && a.can_talk) return "talking";
  if (a.loop) return "idle";
  return "gesture";
}

// scenario start → 첫 scene 애니 (idle 진입점 선택 우선순위).
export function scenarioStartAnim(m) {
  const nodes = m.scenario?.nodes || {};
  const edges = m.scenario?.edges || [];
  const sk = Object.keys(nodes).find((k) => nodes[k].type === "start");
  if (!sk) return null;
  const nx = edges.find((e) => e.from === sk)?.to;
  return nx && nodes[nx] ? nodes[nx].animation : null;
}

export function isPropAction(a) {
  return typeof a?.prop_sequence === "object" && a?.prop_sequence !== null;
}

export function isPropAuxiliaryClip(m, key, a = m?.animations?.[key]) {
  if (a?.role === "prop_enter" || a?.role === "prop_exit") return true;
  for (const anim of Object.values(m?.animations || {})) {
    if (typeof anim?.prop_sequence === "object" && anim.prop_sequence !== null) {
      if (anim.prop_sequence.enter === key || anim.prop_sequence.exit === key) return true;
    }
  }
  return false;
}

export function isPropExcluded(m, key, a = m?.animations?.[key]) {
  return isPropAction(a) || isPropAuxiliaryClip(m, key, a);
}

export function propActions(manifest) {
  const anims = manifest?.animations || {};
  const results = [];
  for (const [key, anim] of Object.entries(anims)) {
    if (typeof anim?.prop_sequence === "object" && anim.prop_sequence !== null) {
      const enterKey = anim.prop_sequence.enter;
      const exitKey = anim.prop_sequence.exit;
      results.push({
        key,
        label: anim.label || key,
        enter: (typeof enterKey === "string" && anims[enterKey]) ? enterKey : null,
        exit: (typeof exitKey === "string" && anims[exitKey]) ? exitKey : null,
      });
    }
  }
  return results;
}

// Fields retained only so existing v0.2 files remain readable.
export function derive(m) {
  const anims = m?.animations || {};
  const isBase = (a) => a.loop && !isTransition(a);
  const start = scenarioStartAnim(m);
  const isExcluded = (k, a) => isPropExcluded(m, k, a);
  const pick = (pred) => {
    if (start && anims[start] && !isExcluded(start, anims[start]) && pred(anims[start])) return start;
    return Object.keys(anims).find((k) => !isExcluded(k, anims[k]) && pred(anims[k])) || null;
  };
  const idleKey = pick((a) => isBase(a) && !a.can_talk);
  const talkKey = pick((a) => isBase(a) && a.can_talk);
  const events = Object.fromEntries(
    Object.entries(anims)
      .filter(([k, a]) => (!a.loop || isTransition(a)) && !isExcluded(k, a))
      .map(([k, a]) => [k, a.clip]),
  );
  return {
    idleKey,
    talkKey,
    listeningKey: idleKey, // v0.2 엔 별도 listening 개념 없음 → idle 재사용
    events,
    idle: anims[idleKey],
    talking: anims[talkKey],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. v0.1 → v0.2 자동 마이그레이션 (구 .nva 열람 호환)
// ─────────────────────────────────────────────────────────────────────────────
export function migrateToV02(m) {
  if (!m || m.nva_version === "0.2") return m;
  if (m.nva_version !== "0.1") return m; // 알 수 없는 버전은 그대로

  const animations = {};
  for (const [k, s] of Object.entries(m.states || {})) {
    animations[k] = {
      clip: s.clip,
      entry_pose: s.entry_pose,
      exit_pose: s.exit_pose,
      loop: !!s.loop,
      can_talk: !!s.can_talk,
      ...(Array.isArray(s.face_bbox) ? { face_bbox: s.face_bbox } : {}),
      label: s.label || k,
    };
  }
  for (const [k, t] of Object.entries(m.transitions || {})) {
    animations[k] = {
      clip: t.clip,
      entry_pose: t.entry_pose,
      exit_pose: t.exit_pose,
      loop: false,
      can_talk: false,
      label: t.label || k,
    };
  }

  // scenarios(steps) → scenario(nodes/edges): 첫 시나리오를 선형 그래프로.
  const nodes = { start: { type: "start", label: "진입" } };
  const edges = [];
  const firstScn = Object.values(m.scenarios || {})[0];
  let prev = "start";
  let i = 0;
  if (firstScn) {
    for (const st of firstScn.steps || []) {
      const anim = st.goto || st.event;
      if (!anim) continue;
      const nid = "n" + i++;
      nodes[nid] = {
        type: "scene",
        animation: anim,
        label: st.say || anim,
        ...(st.dwell_ms ? { dwell_ms: st.dwell_ms } : {}),
      };
      edges.push({ from: prev, to: nid });
      prev = nid;
    }
  } else if (m.initial) {
    nodes["n0"] = { type: "scene", animation: m.initial, label: "대기" };
    edges.push({ from: "start", to: "n0" });
  }

  const out = {
    nva_version: "0.2",
    meta: m.meta || {},
    canvas: m.canvas || { width: 720, height: 1280, fps: 25 },
    background: m.background || { type: "transparent" },
    poses: m.poses || [],
    animations,
    scenario: { nodes, edges },
  };
  if (m.chroma_key) out.chroma_key = m.chroma_key;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 검증 (validator)
// ─────────────────────────────────────────────────────────────────────────────
export function validateManifest(m, opts = {}) {
  const errors = [];
  const warnings = [];
  const E = (s) => errors.push(s);
  const W = (s) => warnings.push(s);

  if (!m || typeof m !== "object")
    return { ok: false, errors: ["manifest가 객체가 아님"], warnings };

  if (!READABLE_NVA_VERSIONS.includes(m.nva_version))
    E(`지원하지 않는 nva_version: ${m.nva_version}`);
  const completedMedia = m.nva_version === NVA_VERSION;
  if (completedMedia && m.profile !== "completed-media")
    E('NVA v0.3 profile은 "completed-media"여야 함');
  if (completedMedia) {
    const rootFields = new Set(["nva_version", "profile", "meta", "canvas", "background", "poses", "animations", "speech_clips", "expressions", "scenario", "speech_motion"]);
    for (const field of Object.keys(m))
      if (!rootFields.has(field)) E(`NVA v0.3 공개 포맷에서 허용하지 않는 최상위 필드 '${field}'`);
  }
  if (!m.canvas || !(m.canvas.width > 0) || !(m.canvas.height > 0))
    E("canvas.width/height 필수(양수)");

  const anims = m.animations || {};
  const animKeys = Object.keys(anims);
  if (animKeys.length === 0) E("animations가 비어있음 (최소 1개)");

  const poses = new Set(m.poses || []);
  const useVocab = poses.size > 0;
  const checkPose = (where, p) => {
    if (!p) {
      E(`${where}: pose 없음`);
      return;
    }
    if (useVocab && !poses.has(p)) W(`${where}: pose '${p}'가 poses 어휘에 없음`);
  };

  for (const [k, a] of Object.entries(anims)) {
    if (!isBundleRelativePath(a.clip)) E(`animation ${k}: clip은 번들 내부 상대경로여야 함`);
    if (completedMedia) {
      const animationFields = new Set(["clip", "loop", "entry_pose", "exit_pose", "label", "intent", "triggers"]);
      for (const field of Object.keys(a))
        if (!animationFields.has(field)) E(`animation ${k}: v0.3 공개 포맷에서 허용하지 않는 필드 '${field}'`);
      if (typeof a.loop !== "boolean") E(`animation ${k}: loop는 boolean이어야 함`);
    }
    // entry_pose/exit_pose 는 선택 — 자세 변화(앉기/눕기)가 있을 때만 씀. 서있는 아바타는 불요.
    // 있을 때만 어휘 검사(경고).
    if (a.entry_pose) checkPose(`animation ${k}.entry_pose`, a.entry_pose);
    if (a.exit_pose) checkPose(`animation ${k}.exit_pose`, a.exit_pose);
  }

  // label 유일성 — AI/LLM 이 label 로 애니를 지목하므로 중복 label 은 지목 모호 → v0.3 에러, v0.2 경고.
  const seenLabels = new Map();
  for (const [k, a] of Object.entries(anims)) {
    const lb = (a.label || "").trim();
    if (!lb) continue;
    if (seenLabels.has(lb)) {
      const msg = `animation ${k}: label '${lb}' 중복(${seenLabels.get(lb)}과 동일) — label 은 유일해야(AI 가 label 로 지목)`;
      if (completedMedia) E(msg);
      else W(msg);
    } else {
      seenLabels.set(lb, k);
    }
  }

  // v0.2 prop_sequence 참조 키 검사 (없는 키마다 경고)
  if (!completedMedia) {
    for (const [k, a] of Object.entries(anims)) {
      if (typeof a?.prop_sequence === "object" && a.prop_sequence !== null) {
        if (a.prop_sequence.enter && !anims[a.prop_sequence.enter]) {
          W(`animation ${k}: prop_sequence.enter '${a.prop_sequence.enter}' animations에 없음`);
        }
        if (a.prop_sequence.exit && !anims[a.prop_sequence.exit]) {
          W(`animation ${k}: prop_sequence.exit '${a.prop_sequence.exit}' animations에 없음`);
        }
      }
    }
  }

  // A completed-media file always needs an idle loop.
  const hasIdle = Object.entries(anims).some(([k, a]) => !isPropExcluded(m, k, a) && a.loop && !isTransition(a) && !a.can_talk);
  const hasTalk = Object.values(anims).some((a) => a.loop && !isTransition(a) && a.can_talk);
  if (animKeys.length && !hasIdle) {
    if (completedMedia) E("대기 반복 영상(loop=true)이 필요함");
    else W("대기 base 루프(loop & !can_talk & 비전환) 없음 — cascade idle 클립 유도 실패");
  }
  if (!completedMedia && animKeys.length && !hasTalk)
    W("말하기 base 루프(loop & can_talk) 없음 — 헤드토킹 대상 없음");

  // Optional completed speech videos. These are final media outputs with
  // embedded audio; the public contract intentionally contains no real-time
  // generation, alignment, model, or runtime details.
  const speechClips = m.speech_clips;
  if (completedMedia && !m.speech_motion && (!speechClips || Object.keys(speechClips).length === 0))
    E("NVA v0.3에는 완성된 speech_clips가 최소 1개 필요함");
  if (speechClips !== undefined) {
    if (!speechClips || typeof speechClips !== "object" || Array.isArray(speechClips)) {
      E("speech_clips는 객체여야 함");
    } else {
      for (const [key, speech] of Object.entries(speechClips)) {
        if (!speech || typeof speech !== "object" || Array.isArray(speech)) {
          E(`speech_clips.${key}는 객체여야 함`);
          continue;
        }
        if (!isBundleRelativePath(speech.clip))
          E(`speech_clips.${key}.clip은 번들 내부 상대경로여야 함`);
        else if (opts.clipFiles && !new Set(opts.clipFiles).has(speech.clip))
          E(`speech_clips.${key}.clip '${speech.clip}' 번들에 없음`);
        if (speech.audio !== "embedded") E(`speech_clips.${key}.audio는 embedded여야 함`);
        // v0.2 packages used `locale`; v0.3 renamed it to `language`. The alias
        // is read-only so existing NVA files still open, while newly authored
        // v0.3 packages stay on the public contract.
        const speechLanguage = completedMedia ? speech.language : (speech.language ?? speech.locale);
        const languageField = !completedMedia && speech.language === undefined ? "locale" : "language";
        if (typeof speechLanguage !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(speechLanguage))
          E(`speech_clips.${key}.${languageField}은 BCP 47 언어 태그여야 함`);
        if (typeof speech.label !== "string" || !speech.label.trim())
          E(`speech_clips.${key}.label은 비어 있지 않은 문자열이어야 함`);
        if (speech.text !== undefined && (typeof speech.text !== "string" || speech.text.length > 10_000))
          E(`speech_clips.${key}.text는 최대 10000자의 문자열이어야 함`);
        if (speech.duration_ms !== undefined && (!Number.isInteger(speech.duration_ms) || speech.duration_ms <= 0))
          E(`speech_clips.${key}.duration_ms는 양의 정수여야 함`);
      }
    }
  }

  // Optional GPU-free speech extension. Old v0.2 manifests remain valid.
  // The player consumes only this language-independent inventory and bundle
  // references; generation-provider details stay in the provenance receipt.
  const speech = m.speech_motion;
  if (speech !== undefined) {
    if (!speech || typeof speech !== "object" || Array.isArray(speech)) {
      E("speech_motion은 객체여야 함");
    } else {
      if (speech.version !== "1") E('speech_motion.version은 "1"이어야 함');
      if (speech.representation !== "factorized-difference-layer" && speech.representation !== "whole-head-layer")
        E('speech_motion.representation은 factorized-difference-layer 또는 whole-head-layer여야 함');
      if (speech.representation === "whole-head-layer") {
        const r = speech.region;
        if (!Array.isArray(r) || r.length !== 4 || r.some((v) => !Number.isInteger(v))) {
          E("speech_motion.region은 정수 [x,y,w,h]여야 함");
        } else {
          const [x, y, w, h] = r;
          if (w <= 0 || h <= 0 || w % 2 !== 0 || h % 2 !== 0) {
            E("speech_motion.region의 w, h는 양수 짝수여야 함");
          }
          if (x < 0 || y < 0 || x + w > m.canvas.width || y + h > m.canvas.height) {
            E("speech_motion.region이 canvas 범위를 벗어남");
          }
        }
      }
      if (speech.inventory_version !== "1.0.0")
        E("speech_motion.inventory_version은 1.0.0이어야 함");
      if (!Array.isArray(speech.inventory)
        || speech.inventory.length !== SPEECH_UNITS.length
        || speech.inventory.some((unit, index) => unit !== SPEECH_UNITS[index]))
        E("speech_motion.inventory는 순서를 포함해 고정 13단위와 같아야 함");

      const paths = ["neutral_head", "atlas", "atlas_index", "validation_report", "quality_report", "provenance"];
      for (const field of paths) {
        const path = speech[field];
        if (!isBundleRelativePath(path))
          E(`speech_motion.${field}는 번들 내부 상대경로여야 함`);
        else if (opts.clipFiles && !new Set(opts.clipFiles).has(path))
          E(`speech_motion.${field} '${path}' 번들에 없음`);
      }
    }
  }

  // scenario 그래프
  const scen = m.scenario || {};
  const nodes = scen.nodes || {};
  const nodeKeys = Object.keys(nodes);
  if (nodeKeys.length) {
    let starts = 0;
    for (const [k, n] of Object.entries(nodes)) {
      if (n.type === "start") {
        starts++;
      } else {
        if (!n.animation) E(`scenario node ${k}: animation 없음`);
        else if (!anims[n.animation]) E(`scenario node ${k}: animation '${n.animation}' 없음`);
      }
    }
    if (starts === 0) W("scenario: start 노드 없음 (idle 진입점 유도 실패)");
    if (starts > 1) E("scenario: start 노드는 1개여야 함");
    for (const e of scen.edges || []) {
      if (!e.from || !e.to) {
        E("scenario edge: from/to 필수");
        continue;
      }
      if (!nodes[e.from]) E(`scenario edge from '${e.from}' 노드 없음`);
      if (!nodes[e.to]) E(`scenario edge to '${e.to}' 노드 없음`);
    }
  }

  // 클립 참조 존재 (번들 파일 목록이 주어질 때만)
  if (opts.clipFiles) {
    const files = new Set(opts.clipFiles);
    for (const [k, a] of Object.entries(anims))
      if (a.clip && !files.has(a.clip)) E(`animation ${k}: 클립 '${a.clip}' 번들에 없음`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. scenario 목록 (뷰어 드롭다운용) — v0.2 는 단일 scenario 그래프.
// ─────────────────────────────────────────────────────────────────────────────
export function listScenarios(m) {
  const scen = m.scenario;
  if (!scen || !scen.nodes) return [];
  const scenes = Object.values(scen.nodes).filter((n) => n.type !== "start").length;
  return [{ id: "scenario", label: "시나리오 흐름", steps: scenes }];
}

// scenario 그래프를 start 부터 edge 따라 선형 방문 순서로 평탄화 (미리보기 재생용).
export function scenarioPlayOrder(m) {
  const nodes = m.scenario?.nodes || {};
  const edges = m.scenario?.edges || [];
  const start = Object.keys(nodes).find((k) => nodes[k].type === "start");
  if (!start) return [];
  const order = [];
  const seen = new Set();
  let cur = start;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = nodes[cur];
    if (n && n.type !== "start" && n.animation)
      order.push({ animation: n.animation, say: n.label, dwell_ms: n.dwell_ms });
    cur = edges.find((e) => e.from === cur)?.to;
  }
  return order;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 재생 시퀀스 — 목표 애니로 가는 전환 자동 삽입 (포즈 연속성).
// ─────────────────────────────────────────────────────────────────────────────

// entry/exit pose 로 전환 애니(is_transition) 를 BFS. fromPose → toPose 최단 키 시퀀스.
export function findTransitionPath(m, fromPose, toPose) {
  if (fromPose === toPose) return [];
  const trans = Object.entries(m.animations || {}).filter(([, a]) => isTransition(a));
  const queue = [[fromPose, []]];
  const seen = new Set([fromPose]);
  while (queue.length) {
    const [pose, path] = queue.shift();
    for (const [key, a] of trans) {
      if (a.entry_pose !== pose || seen.has(a.exit_pose)) continue;
      const next = [...path, key];
      if (a.exit_pose === toPose) return next;
      seen.add(a.exit_pose);
      queue.push([a.exit_pose, next]);
    }
  }
  return null;
}

// 런타임 상태머신 — 현재 애니의 exit_pose 에서 목표 애니의 entry_pose 로 전환 계획.
export class NvaRuntime {
  constructor(manifest) {
    this.m = manifest;
    const d = derive(manifest);
    this.current = d.idleKey || Object.keys(manifest.animations || {})[0] || null;
  }

  anim(key = this.current) {
    return this.m.animations?.[key];
  }

  // 목표 애니로 가는 계획: { transitions:[key...], target }. 불가면 null.
  plan(targetKey) {
    const cur = this.anim(this.current);
    const tgt = this.anim(targetKey);
    if (!tgt) return null;
    const path = findTransitionPath(this.m, cur?.exit_pose ?? tgt.entry_pose, tgt.entry_pose);
    if (path === null) return null;
    return { transitions: path, target: targetKey };
  }

  commit(targetKey) {
    this.current = targetKey;
  }
}

// 계획 → (클립, loop, can_talk, face_bbox) 시퀀스. player 가 그대로 재생.
export function buildPlaybackSequence(m, plan) {
  const seq = [];
  for (const tk of plan.transitions) {
    const a = m.animations[tk];
    seq.push({ key: tk, clip: a.clip, loop: false, can_talk: false, face_bbox: null });
  }
  const a = m.animations[plan.target];
  seq.push({
    key: plan.target,
    clip: a.clip,
    loop: !!a.loop,
    can_talk: !!a.can_talk,
    face_bbox: a.face_bbox || null,
  });
  return seq;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. CLI 요약
// ─────────────────────────────────────────────────────────────────────────────
export function summarize(result) {
  const lines = [];
  lines.push(result.ok ? "✅ VALID" : "❌ INVALID");
  for (const e of result.errors) lines.push("  ERROR  " + e);
  for (const w of result.warnings) lines.push("  WARN   " + w);
  return lines.join("\n");
}
