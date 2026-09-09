// #582 S2e — 실제 접근성 스냅샷과 화면 캡처 (계약 4.4·4.5, ABI 7).
//
// S2a·S2c 의 스냅샷은 모양만 맞춘 임시 구현이었다(AX 트리를 한 줄씩 나열). 여기서 두 가지를
// 진짜로 만든다.
//
//  (1) **본문 형식이 벤더 스킬의 예시와 같다.** `[ref=N, loc=..., url=...]` 주석이 달린
//      들여쓴 접근성 트리 텍스트다(`skills/ego-browser/SKILL.md:182`, `:128`). 벤더 런타임은
//      본문을 **파싱하지 않는다** — `refs` 만 `browserSnapshotRefsToRefMap` 으로 읽는다
//      (`src/browser-runtime.ts:309-326`). 그래서 본문은 사람과 에이전트가 읽는 면이고,
//      `ref=N` 과 `refs[].backendNodeId` 가 **같은 값**이라는 것만이 기계 계약이다.
//  (2) **`loc=` 는 실제 DOM 에서 뽑는다.** AX 트리만으로는 css 선택자를 만들 수 없어
//      `DOM.getDocument` 를 한 번 더 불러 `backendNodeId → {태그, id, href}` 를 만든다.
//      노드마다 `DOM.describeNode` 를 부르면 왕복이 노드 수만큼 생겨 15초 상한(ABI 1)에 걸린다.
//
// **감독자 내부 CDP 로 실행한다.** 승인(grant) 없는 관측 연결은 원시 CDP 를 보낼 수 없으므로
// (S2a 리뷰의 지적), 스냅샷·캡처를 원시 CDP 로 구현하면 관측 연결이 아무것도 못 본다.
// 이 파일의 모든 호출은 `hostRequest`(감독자 전용 통로)로 나간다.
//
// ## 옵션 (벤더 `src/driver/observe.ts:24-28` 이 보내는 것)
//
// | 옵션 | 우리 지원 |
// |---|---|
// | `includeStableLocator` | 지원. 거짓이면 `loc=` 을 붙이지 않는다 |
// | `includeActionMarks` | 지원. 참이면 조작 가능한 역할 앞에 `*` 를 붙인다 |
// | `scope: "only_within_viewport"` | **미지원 — 무시하고 전체 문서를 준다.** 뷰포트 판정은 노드마다 `DOM.getBoxModel` 을 불러야 해서 왕복이 노드 수만큼 늘고, 헤드리스 기본 창 크기는 사람이 보는 뷰포트가 아니라 잘라 낼 근거도 없다. 벤더 기본값도 `full_page` 다(`observe.ts:73-77`) |
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODES, hostError } from "../errors.mjs";
import { egoHostDir } from "./ledger.mjs";

/** 본문 상한. 넘으면 잘렸다고 본문에 적는다 — 조용히 자르면 없는 것과 구별되지 않는다. */
export const MAX_SNAPSHOT_NODES = 1500;
export const MAX_SNAPSHOT_DEPTH = 25;

/** `includeActionMarks` 가 참일 때 표시할 역할. */
export const ACTIONABLE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "slider",
  "spinbutton",
  "switch",
  "tab",
]);

/** 무시할 역할. 트리를 읽을 수 없게 만드는 잡음이다. */
const SKIP_ROLES = new Set(["none", "presentation", "InlineTextBox", "generic"]);

export function evidenceDir(adkDir) {
  return join(egoHostDir(adkDir), "evidence");
}

function axValue(node, key) {
  const raw = node?.[key];
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "object") return raw.value === undefined ? "" : String(raw.value);
  return String(raw);
}

function axProperty(node, name) {
  for (const property of node?.properties ?? []) {
    if (property?.name === name) return property?.value?.value;
  }
  return undefined;
}

/** `DOM.getDocument` 트리를 `backendNodeId → {tag, id, href, classes}` 로 편다. */
export function flattenDomIndex(root) {
  const index = new Map();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (typeof node.backendNodeId === "number") {
      const attributes = node.attributes ?? [];
      const attr = {};
      for (let i = 0; i + 1 < attributes.length; i += 2) attr[attributes[i]] = attributes[i + 1];
      index.set(node.backendNodeId, {
        tag: (node.localName || node.nodeName || "").toLowerCase(),
        id: attr.id ?? null,
        href: attr.href ?? null,
        name: attr.name ?? null,
        type: attr.type ?? null,
      });
    }
    for (const child of node.children ?? []) stack.push(child);
    for (const child of node.shadowRoots ?? []) stack.push(child);
    if (node.contentDocument) stack.push(node.contentDocument);
  }
  return index;
}

/**
 * 안정 로케이터 하나. 벤더가 받는 형식은 `css:`·`role:`·`href:` 셋뿐이다
 * (`skills/ego-browser/SKILL.md:128`).
 */
export function stableLocator({ dom, role, name }) {
  if (dom?.id) return `css:#${dom.id}`;
  if (dom?.href) return `href:${dom.href}`;
  if (dom?.tag && dom?.name) return `css:${dom.tag}[name="${dom.name}"]`;
  if (role && name) return `role:${role}[name="${name}"]`;
  if (dom?.tag) return `css:${dom.tag}`;
  return null;
}

/**
 * AX 트리 + DOM 색인 → `{content, refs}`.
 * 순수 함수다 — CDP 를 부르지 않으므로 픽스처 없이도 형식을 시험할 수 있다.
 */
export function renderSnapshot({
  nodes,
  domIndex = new Map(),
  includeStableLocator = true,
  includeActionMarks = true,
  maxNodes = MAX_SNAPSHOT_NODES,
  maxDepth = MAX_SNAPSHOT_DEPTH,
}) {
  const byId = new Map();
  for (const node of nodes ?? []) byId.set(node.nodeId, node);
  const roots = (nodes ?? []).filter((node) => !node.parentId || !byId.has(node.parentId));

  const refs = [];
  const lines = [];
  let emitted = 0;
  let skippedForCap = 0;
  let depthCapped = 0;

  const walk = (node, depth) => {
    if (!node) return;
    if (depth > maxDepth) {
      depthCapped += 1;
      return;
    }
    const role = axValue(node, "role");
    const name = axValue(node, "name");
    const backendNodeId = node.backendDOMNodeId ?? node.backendNodeId;
    const ignored = node.ignored === true || SKIP_ROLES.has(role);
    let nextDepth = depth;

    if (!ignored && backendNodeId !== undefined && backendNodeId !== null) {
      if (emitted >= maxNodes) {
        skippedForCap += 1;
      } else {
        const dom = domIndex.get(backendNodeId) ?? null;
        const url = axProperty(node, "url") ?? dom?.href ?? null;
        const annotations = [`ref=${backendNodeId}`];
        if (includeStableLocator) {
          const locator = stableLocator({ dom, role, name });
          if (locator) annotations.push(`loc=${locator}`);
        }
        if (url) annotations.push(`url=${url}`);
        const mark = includeActionMarks && ACTIONABLE_ROLES.has(role) ? "*" : "";
        const label = name ? ` "${name}"` : "";
        lines.push(`${"  ".repeat(Math.min(depth, maxDepth))}- ${mark}${role}${label} [${annotations.join(", ")}]`);
        refs.push({ backendNodeId, role, name });
        emitted += 1;
        nextDepth = depth + 1;
      }
    }

    for (const childId of node.childIds ?? []) walk(byId.get(childId), nextDepth);
  };

  for (const root of roots) walk(root, 0);

  if (skippedForCap > 0 || depthCapped > 0) {
    lines.push(
      `- … 잘림: 노드 상한 ${maxNodes} 로 ${skippedForCap} 개, 깊이 상한 ${maxDepth} 로 ` +
        `${depthCapped} 개의 가지를 뺐다. 더 좁은 영역을 열어 다시 본다.`,
    );
  }

  return { content: lines.join("\n"), refs, truncated: skippedForCap > 0 || depthCapped > 0 };
}

/**
 * 실제 접근성 스냅샷 하나.
 *
 * @param {object} options
 * @param {(method:string, params?:object, sessionId?:string)=>Promise<object>} options.hostRequest
 * @param {string} options.targetId
 */
export async function captureAxSnapshot({ hostRequest, targetId, options = {} }) {
  if (!targetId) throw hostError(CODES.NO_TASK_SPACE, "스냅샷을 찍을 탭이 없다");
  const attached = await hostRequest("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attached?.sessionId;
  if (!sessionId) {
    throw hostError(CODES.BROWSER_GONE, `탭 ${targetId} 에 붙지 못해 스냅샷을 찍을 수 없다`);
  }
  try {
    const tree = await hostRequest("Accessibility.getFullAXTree", {}, sessionId);
    let domIndex = new Map();
    if (options.includeStableLocator !== false) {
      try {
        const document = await hostRequest("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
        domIndex = flattenDomIndex(document?.root);
      } catch (error) {
        // 로케이터는 편의다. DOM 을 못 읽어도 ref 는 나와야 한다(ABI 7 이 요구하는 것은 refs 다).
        domIndex = new Map();
      }
    }
    return renderSnapshot({
      nodes: tree?.nodes ?? [],
      domIndex,
      includeStableLocator: options.includeStableLocator !== false,
      includeActionMarks: options.includeActionMarks !== false,
    });
  } finally {
    hostRequest("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

/**
 * 접근성 스냅샷 본문을 증거 파일로 남긴다 (계약 4.5, S3a).
 *
 * 캡처와 같은 이름 규칙(`<operationId>-<n>`)을 쓰고 확장자만 다르다. 어댑터가
 * `BrowserEvidence.snapshotRef` 로 이 경로를 돌려주므로, 증거가 대화 기록 안의 휘발성
 * 문자열이 아니라 **나중에 다시 열어 볼 수 있는 파일**이 된다.
 *
 * @returns {{path:string, bytes:number}}
 */
export function writeSnapshotFile({ adkDir, operationId, index = 1, content = "" }) {
  if (!adkDir) throw hostError(CODES.USAGE, "스냅샷 증거 경로에 adkDir 이 필요하다");
  const dir = evidenceDir(adkDir);
  mkdirSync(dir, { recursive: true });
  const safeOperation = String(operationId ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  const path = join(dir, `${safeOperation}-${index}.snapshot.txt`);
  const bytes = Buffer.from(content, "utf8");
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, bytes: bytes.length };
}

/**
 * 화면 캡처 하나. **경로는 감독자가 정한다** — 사용자 인자를 받지 않는다(계약 4.4 마지막 문장).
 *
 * @returns {Promise<{path:string, bytes:number}>}
 */
export async function captureScreenshot({
  hostRequest,
  targetId,
  adkDir,
  operationId,
  index = 1,
  fullPage = false,
}) {
  if (!adkDir) throw hostError(CODES.USAGE, "캡처 경로에 adkDir 이 필요하다");
  if (!targetId) throw hostError(CODES.NO_TASK_SPACE, "캡처할 탭이 없다");
  const attached = await hostRequest("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attached?.sessionId;
  if (!sessionId) {
    throw hostError(CODES.BROWSER_GONE, `탭 ${targetId} 에 붙지 못해 캡처할 수 없다`);
  }
  try {
    const shot = await hostRequest(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: fullPage },
      sessionId,
    );
    if (typeof shot?.data !== "string" || shot.data === "") {
      throw hostError(CODES.EVIDENCE_FAILED, "Page.captureScreenshot 이 데이터를 주지 않았다");
    }
    const dir = evidenceDir(adkDir);
    mkdirSync(dir, { recursive: true });
    // 이름은 `<operationId>-<n>.png` 다(계약 4.5). 사용자 인자는 이름에도 경로에도 안 들어간다.
    const safeOperation = String(operationId ?? "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
    const path = join(dir, `${safeOperation}-${index}.png`);
    const bytes = Buffer.from(shot.data, "base64");
    writeFileSync(path, bytes, { mode: 0o600 });
    return { path, bytes: bytes.length };
  } finally {
    hostRequest("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}
