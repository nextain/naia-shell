// ★ VENDORED REFERENCE — 정본 스냅샷(수동 동기화). 편집 금지.
//   원본 = naia-video-avatar/src/main/nva-core.js (정본 SoT). 이 파일은 그 복사본으로,
//   naia-shell CI 가 크로스레포에 의존하지 않고 divergence 를 검증하기 위한 in-repo 기준이다.
//   정본 규칙이 바뀌면: (1) 이 파일을 원본으로 재복사 → (2) `pnpm gen:nva-golden` → (3) 테스트로 diff 검출.
//   divergence 테스트(nva-core.divergence.test.ts)가 이 JS 와 벤더 TS(nva-core.ts)를 실시간 대조한다.
// nva-core — naia video clip avatar 코어 로직 (브라우저 + node 양용 ESM) — **nva v0.2**
//
// 포맷의 진짜 IP: 비디오 파일이 아니라 "클립의 위치·조합·순서" = animations 풀 + scenario 그래프.
// 의존 0 (순수 JS). 뷰어·에디터·검증기가 공유. 캐스케이드 런타임과 동일 계약.
//
// v0.2 모델 (states/transitions 폐기):
//  - animations{}: 재료 풀. 각 원소 = clip + entry/exit_pose + loop + can_talk + face_bbox.
//    종류(kind)는 필드가 아니라 **조합에서 유도**:
//      말하기 = loop & can_talk / 대기·듣기 = loop & !can_talk / 제스처 = 둘 다 off
//      전환   = entry_pose != exit_pose
//  - scenario{nodes,edges}: 노드 그래프. nodes[k]={type:"start"|"scene", animation, label, dwell_ms},
//    edges=[{from,to}]. start 노드가 가리키는 첫 scene = idle 진입점.
//  - 헤드토킹: can_talk 애니의 face_bbox 영역만 립싱크 렌더러로 렌더해 재생 클립 위에 오버레이.

export const NVA_VERSION = "0.2";

// ─────────────────────────────────────────────────────────────────────────────
// 0. 파생 규칙 헬퍼 (캐스케이드 런타임과 동일 규칙)
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

// cascade 로더와 동일한 파생 필드(idle/talking/listening/events).
export function derive(m) {
  const anims = m.animations || {};
  const isBase = (a) => a.loop && !isTransition(a);
  const start = scenarioStartAnim(m);
  const pick = (pred) => {
    if (start && anims[start] && pred(anims[start])) return start;
    return Object.keys(anims).find((k) => pred(anims[k])) || null;
  };
  const idleKey = pick((a) => isBase(a) && !a.can_talk);
  const talkKey = pick((a) => isBase(a) && a.can_talk);
  const events = Object.fromEntries(
    Object.entries(anims)
      .filter(([, a]) => !a.loop || isTransition(a))
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
      // face_bbox = [x,y,w,h] 직사각(권장, 머리 영역) 또는 [x,y,l] 정사각(하위호환) — 그대로 보존.
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

  if (m.nva_version !== "0.2") E(`nva_version은 "0.2"여야 함 (현재: ${m.nva_version})`);
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
    if (!a.clip) E(`animation ${k}: clip 없음`);
    // entry_pose/exit_pose 는 선택 — 자세 변화(앉기/눕기)가 있을 때만 씀. 서있는 아바타는 불요.
    // 있을 때만 어휘 검사(경고).
    if (a.entry_pose) checkPose(`animation ${k}.entry_pose`, a.entry_pose);
    if (a.exit_pose) checkPose(`animation ${k}.exit_pose`, a.exit_pose);
    if (a.can_talk) {
      if (!Array.isArray(a.face_bbox) || (a.face_bbox.length !== 3 && a.face_bbox.length !== 4))
        E(`animation ${k}: can_talk=true면 face_bbox 필수 — [x,y,w,h] 직사각(머리 영역) 또는 [x,y,l] 정사각`);
      else if (a.face_bbox.some((v) => v < 0 || v > 1))
        E(`animation ${k}: face_bbox 값은 0~1 범위`);
    }
  }

  // label 유일성 — AI/LLM 이 label 로 애니를 지목하므로 중복 label 은 지목 모호 → 에러.
  const seenLabels = new Map();
  for (const [k, a] of Object.entries(anims)) {
    const lb = (a.label || "").trim();
    if (!lb) continue;
    if (seenLabels.has(lb)) E(`animation ${k}: label '${lb}' 중복(${seenLabels.get(lb)}과 동일) — label 은 유일해야(AI 가 label 로 지목)`);
    else seenLabels.set(lb, k);
  }

  // base 루프 권장 (cascade 파생이 idle/talking 을 뽑으려면 필요)
  const hasIdle = Object.values(anims).some((a) => a.loop && !isTransition(a) && !a.can_talk);
  const hasTalk = Object.values(anims).some((a) => a.loop && !isTransition(a) && a.can_talk);
  if (animKeys.length && !hasIdle)
    W("대기 base 루프(loop & !can_talk & 비전환) 없음 — cascade idle 클립 유도 실패");
  if (animKeys.length && !hasTalk)
    W("말하기 base 루프(loop & can_talk) 없음 — 헤드토킹 대상 없음");

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
