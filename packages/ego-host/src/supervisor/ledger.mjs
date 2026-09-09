// #582 S2c — 작업 공간·타깃·세션 장부 (계약 4.3.1·4.4).
//
// S2a 의 `task-space-ledger.mjs` 는 모양만 맞춘 임시 인메모리 장부였다. 이 파일이 그것을
// 대체한다. 바뀐 것은 셋이다.
//
//  (1) **작업 공간 = 격리 브라우저 컨텍스트 하나**. `Target.createBrowserContext` 는 감독자
//      전용 호출이고(연결에는 노출하지 않는다), `browserContextId` 는 공개 자원 모양에 넣지
//      않는다(계약 4.4: "원시 CDP 능력이므로 어댑터 안의 매핑으로 둔다"). 대신 장부 안의
//      매핑으로만 산다. 밖으로 나가는 것은 `{id, mode, ownership, revision}` 뿐이다.
//      벤더 런타임이 읽는 ABI 모양(`taskId`·숫자 `id`·`name`·`ownership`)은 S2a 그대로다.
//  (2) **배타적 타깃 lease**. attach 요청마다 세대(generation)를 올려 예약하고, 같은 타깃에
//      두 연결이 동시에 붙으면 **원자적으로 한 연결만** 승인한다(나머지는 원래 id 로
//      `EGO_TARGET_BUSY`). 예약 중 연결이 끊기면 예약을 철회하고, 그 뒤 도착한 늦은 응답은
//      감독자가 내부적으로 detach 한다. detach 된 sessionId 는 묘비로 남아 같은 값이
//      재사용돼도 옛 세대의 요청·이벤트를 거부한다.
//  (3) **원자적 저장**. `<ADK>/ego-host/spaces.json` 은 임시 파일 + rename 으로만 바뀐다.
//      반쯤 쓰인 장부를 다음 시작이 읽으면 어느 공간이 살아 있는지 모르는 상태가 되고,
//      그 상태에서 안전한 행동은 없다(lease.mjs 와 같은 이유·같은 방식).
//
// 자식 타깃 auto-attach 는 쓰지 않는다. `Target.setAutoAttach` 는 거부 목록이고, 예기치 않은
// 자식 `attachedToTarget` 은 fail-closed 로 감독자가 detach 한다.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODES, hostError } from "../errors.mjs";

/** 헤드리스에서 도달 가능한 유일한 소유권. 벤더 helpers.ts:118 의 세 문자열 중 하나. */
export const HEADLESS_OWNERSHIP = "agent";

/** 공개 자원의 모드. 창 있는 모드는 이번 범위 밖이다(계약 10절). */
export const WORKSPACE_MODE = "headless";

export const LEDGER_FILE_VERSION = 1;

/** 배타 lease 가 이미 남에게 있을 때의 코드. 벤더 런타임은 미지의 코드를 그대로 통과시킨다. */
export const TARGET_BUSY = "EGO_TARGET_BUSY";

export function egoHostDir(adkDir) {
  if (!adkDir) throw hostError(CODES.USAGE, "장부 경로에 adkDir 이 필요하다");
  return join(adkDir, "ego-host");
}

export function spacesPath(adkDir) {
  return join(egoHostDir(adkDir), "spaces.json");
}

/** 공간별 다운로드 디렉터리. 중계기가 `downloadPath` 를 여기로 재작성한다(S2d). */
export function downloadsDir(adkDir, workspaceId) {
  return join(egoHostDir(adkDir), "downloads", String(workspaceId));
}

/**
 * 원자적 저장. 같은 디렉터리 안 임시 파일에 다 쓰고 rename 한다.
 * rename 은 같은 파일 시스템 안에서 원자적이라, 어느 시점에 죽어도 **이전 파일이 온전하다**.
 */
function writeAtomic(path, text) {
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw error;
  }
}

/**
 * 작업 공간·타깃·세션 장부 하나.
 *
 * @param {object} [options]
 * @param {string|null} [options.adkDir]  주면 `<ADK>/ego-host/spaces.json` 에 원자적으로 저장한다.
 *   없으면 인메모리(테스트·S2a 호환 경로).
 * @param {((method:string, params?:object, sessionId?:string)=>Promise<object>)|null} [options.hostRequest]
 *   **감독자 전용** CDP 통로(`mux.hostRequest`). 브라우저 컨텍스트 생성·폐기, 예기치 않은 자식
 *   타깃 detach, `Runtime.runIfWaitingForDebugger` 가 이 통로로만 나간다.
 * @param {(message:string)=>void} [options.log]
 */
export function createLedger({ adkDir = null, hostRequest = null, log = () => {} } = {}) {
  let nextId = 1;
  /** id(number) -> space */
  const spaces = new Map();
  /** idempotencyKey -> spaceId. 같은 키의 재전송은 같은 공간을 돌려준다(S0 리뷰 2번). */
  const idempotency = new Map();
  /** targetId -> spaceId. 영속 매핑. */
  const targetSpace = new Map();
  /** targetId -> {connection, generation, state:"reserved"|"held", sessionId} — 배타 lease */
  const leases = new Map();
  /**
   * targetId -> connection. **lease 가 아니다.** 탭을 만든 연결이 그 탭의 브라우저 수준
   * 이벤트를 받을 주인이라는 표시일 뿐이다. 여기 있다고 남이 attach 하지 못하는 것은 아니다 —
   * 배타는 attach 에만 걸린다(계약 4.3.1). 둘을 섞으면 같은 공간을 공유하는 두 번째 연결이
   * 첫 탭에 영영 못 붙는다.
   */
  const routing = new Map();
  /** targetId -> 마지막으로 발급한 세대 */
  const generations = new Map();
  /** sessionId -> {connection, workspaceId, targetId, generation} — 단일 소유 */
  const sessions = new Map();
  /** 버려진 세션. 같은 값이 재사용돼도 옛 세대의 요청·이벤트를 거부한다. */
  const tombstones = new Set();
  /** 감독자가 fail-closed 로 끊어낸 자식 세션(시험용 관측). */
  const rejectedChildren = [];
  /**
   * **감독자 자신이 붙은 세션.** 스냅샷·캡처는 감독자 내부 CDP 로 도는데(계약 4.4: 승인 없는
   * 관측 연결도 받아야 한다), 그때 오는 `Target.attachedToTarget` 이벤트는 예약도 소유도 없어
   * 예기치 않은 자식으로 보인다. 그대로 두면 감독자가 **자기 세션을 스스로 끊는다**(실측:
   * 두 번째 캡처부터 "Session with given id not found").
   * 그래서 attach 를 보내기 전에 표시해 두고, 그 짝 이벤트는 아무에게도 주지 않고 지나보낸다.
   */
  const hostAttaches = new Map();
  const hostSessions = new Set();

  function persist() {
    if (!adkDir) return;
    const payload = {
      version: LEDGER_FILE_VERSION,
      nextId,
      spaces: [...spaces.values()].map((space) => ({
        id: space.id,
        name: space.name,
        taskId: space.taskId,
        browserContextId: space.browserContextId,
        revision: space.revision,
        createdAt: space.createdAt,
        idempotencyKey: space.idempotencyKey,
        tabs: space.tabs.map((tab) => ({ targetId: tab.targetId, url: tab.url, title: tab.title })),
        activeTargetId: space.activeTargetId,
      })),
      targets: Object.fromEntries([...targetSpace.entries()]),
    };
    mkdirSync(egoHostDir(adkDir), { recursive: true });
    writeAtomic(spacesPath(adkDir), `${JSON.stringify(payload, null, 2)}\n`);
  }

  function load() {
    if (!adkDir) return { loaded: 0 };
    let raw;
    try {
      raw = readFileSync(spacesPath(adkDir), "utf8");
    } catch {
      return { loaded: 0 };
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      // 반쯤 쓰인 장부는 원자적 저장에서는 나올 수 없다. 나왔다면 사람이 건드린 것이고,
      // 그 상태에서 "아마 이랬을 것"으로 추측하는 것이 가장 위험하다. 빈 장부로 시작한다.
      log(`장부 파일을 읽을 수 없어 빈 장부로 시작한다: ${error.message}`);
      return { loaded: 0, unreadable: true };
    }
    for (const record of data.spaces ?? []) {
      spaces.set(record.id, {
        id: record.id,
        name: record.name,
        taskId: record.taskId ?? String(record.id),
        browserContextId: record.browserContextId ?? null,
        revision: record.revision ?? 1,
        createdAt: record.createdAt ?? null,
        idempotencyKey: record.idempotencyKey ?? null,
        tabs: (record.tabs ?? []).map((tab) => ({ ...tab })),
        activeTargetId: record.activeTargetId ?? null,
        restored: true,
      });
      if (record.idempotencyKey) idempotency.set(record.idempotencyKey, record.id);
    }
    for (const [targetId, spaceId] of Object.entries(data.targets ?? {})) {
      targetSpace.set(targetId, spaceId);
    }
    nextId = Number(data.nextId) > 0 ? Number(data.nextId) : spaces.size + 1;
    return { loaded: spaces.size };
  }

  const loadResult = load();

  /**
   * 복원된 공간 중 브라우저에 더는 없는 컨텍스트를 걷어낸다.
   * 감독자가 다시 시작하면 Chromium 도 새 프로세스라 옛 컨텍스트는 존재하지 않는다.
   * 죽은 컨텍스트를 살아 있는 것처럼 들고 있으면 첫 사용에서야 알게 된다.
   */
  async function restore() {
    if (spaces.size === 0 || !hostRequest) return { kept: spaces.size, dropped: 0 };
    let alive = [];
    try {
      const result = await hostRequest("Target.getBrowserContexts", {});
      alive = Array.isArray(result?.browserContextIds) ? result.browserContextIds : [];
    } catch (error) {
      log(`브라우저 컨텍스트 목록을 못 읽었다: ${error.message}`);
      return { kept: spaces.size, dropped: 0, unverified: true };
    }
    let dropped = 0;
    for (const space of [...spaces.values()]) {
      if (space.browserContextId && alive.includes(space.browserContextId)) continue;
      forgetSpace(space.id);
      dropped += 1;
    }
    if (dropped > 0) persist();
    return { kept: spaces.size, dropped };
  }

  function forgetSpace(id) {
    const space = spaces.get(id);
    if (!space) return;
    for (const tab of space.tabs) {
      targetSpace.delete(tab.targetId);
      releaseTarget(tab.targetId);
    }
    for (const [targetId, spaceId] of [...targetSpace]) {
      if (spaceId === id) targetSpace.delete(targetId);
    }
    if (space.idempotencyKey) idempotency.delete(space.idempotencyKey);
    spaces.delete(id);
  }

  /** 벤더 런타임이 읽는 ABI 모양. S2a 와 한 글자도 다르지 않다. */
  function shape(space) {
    return {
      taskId: space.taskId,
      id: space.id,
      name: space.name,
      createdBy: "agent",
      ownership: HEADLESS_OWNERSHIP,
      recentTabTitles: space.tabs.map((t) => t.title).filter(Boolean).slice(-3),
    };
  }

  /** 계약 4.4 의 공개 자원 모양. `browserContextId` 는 여기 없다 — 장부 안에만 있다. */
  function resourceOf(space) {
    return {
      id: space.id,
      mode: WORKSPACE_MODE,
      ownership: HEADLESS_OWNERSHIP,
      revision: space.revision,
    };
  }

  function bumpRevision(space) {
    space.revision += 1;
    persist();
  }

  function releaseTarget(targetId) {
    routing.delete(targetId);
    const lease = leases.get(targetId);
    if (!lease) return;
    if (lease.sessionId) dropSession(lease.sessionId);
    leases.delete(targetId);
  }

  /**
   * attach 응답(또는 attach 이벤트)이 도착했다.
   * 예약이 철회됐거나(연결 종료) 세대가 낡았으면 `{ok:false}` 다 — 그때 감독자는
   * 그 세션을 내부적으로 detach 해야 한다. 그러지 않으면 주인 없는 세션이 남는다.
   */
  function settleAttach({ connection, targetId, generation, sessionId }) {
    const existing = sessions.get(sessionId);
    if (existing && existing.connection === connection && existing.targetId === targetId) {
      return { ok: true, already: true, record: existing };
    }
    const lease = leases.get(targetId);
    if (!lease || lease.connection !== connection || lease.generation !== generation) {
      return { ok: false, reason: lease ? "stale-generation" : "revoked" };
    }
    tombstones.delete(sessionId);
    const workspaceId = targetSpace.get(targetId) ?? null;
    const record = { connection, workspaceId, targetId, generation };
    sessions.set(sessionId, record);
    leases.set(targetId, { connection, generation, state: "held", sessionId });
    return { ok: true, record };
  }

  function dropSession(sessionId) {
    // 감독자 자신의 세션은 장부 밖이다. 묘비를 세우면 같은 값이 재사용될 때 남의 요청까지 막는다.
    if (hostSessions.has(sessionId)) {
      hostSessions.delete(sessionId);
      return null;
    }
    const record = sessions.get(sessionId);
    sessions.delete(sessionId);
    tombstones.add(sessionId);
    if (record?.targetId) {
      const lease = leases.get(record.targetId);
      if (lease && lease.sessionId === sessionId) leases.delete(record.targetId);
    }
    return record ?? null;
  }

  return {
    // ── 진단 ────────────────────────────────────────────────────────────────
    loadResult,
    restore,
    adkDir,

    // ── 작업 공간 (ABI 표면은 S2a 와 동일) ─────────────────────────────────
    list() {
      return [...spaces.values()].map(shape);
    },
    get(id) {
      return spaces.get(Number(id)) ?? null;
    },
    shape,
    resourceOf,
    /** 장부 내부 매핑. 중계기(S2d)만 부른다. 연결에는 절대 나가지 않는다. */
    browserContextOf(space) {
      return space?.browserContextId ?? null;
    },
    findByName(name) {
      for (const space of spaces.values()) if (space.name === name) return space;
      return null;
    },

    /**
     * 작업 공간 하나 = 격리 브라우저 컨텍스트 하나.
     * 같은 `idempotencyKey` 로 다시 부르면 **같은 공간**을 돌려준다(컨텍스트를 또 만들지 않는다).
     */
    async create(name, { idempotencyKey = null } = {}) {
      if (idempotencyKey && idempotency.has(idempotencyKey)) {
        const existing = spaces.get(idempotency.get(idempotencyKey));
        if (existing) return existing;
        idempotency.delete(idempotencyKey);
      }
      let browserContextId = null;
      if (hostRequest) {
        const created = await hostRequest("Target.createBrowserContext", { disposeOnDetach: false });
        browserContextId = created?.browserContextId ?? null;
        if (!browserContextId) {
          throw hostError(
            CODES.BROWSER_GONE,
            "Target.createBrowserContext 가 browserContextId 를 주지 않았다. 격리 없는 공간은 만들지 않는다",
          );
        }
      }
      const id = nextId++;
      const space = {
        id,
        name: String(name),
        taskId: String(id),
        browserContextId,
        revision: 1,
        createdAt: new Date().toISOString(),
        idempotencyKey: idempotencyKey ?? null,
        tabs: [],
        activeTargetId: null,
      };
      spaces.set(id, space);
      if (idempotencyKey) idempotency.set(idempotencyKey, id);
      persist();
      return space;
    },

    /** 공간 닫기 = 컨텍스트 dispose + 장부 정리. 탭·타깃·세션이 전부 따라 나간다. */
    async close(id) {
      const space = spaces.get(Number(id));
      if (!space) return { closed: false };
      const targetIds = space.tabs.map((tab) => tab.targetId);
      if (hostRequest && space.browserContextId) {
        try {
          await hostRequest("Target.disposeBrowserContext", {
            browserContextId: space.browserContextId,
          });
        } catch (error) {
          log(`브라우저 컨텍스트 폐기 실패(장부는 정리한다): ${error.message}`);
        }
      }
      forgetSpace(space.id);
      persist();
      return { closed: true, targetIds };
    },

    addTab(space, tab) {
      space.tabs.push({ targetId: tab.targetId, url: tab.url ?? "", title: tab.title ?? "" });
      space.activeTargetId = tab.targetId;
      targetSpace.set(tab.targetId, space.id);
      bumpRevision(space);
    },
    removeTab(space, targetId) {
      const at = space.tabs.findIndex((t) => t.targetId === targetId);
      if (at >= 0) space.tabs.splice(at, 1);
      if (space.activeTargetId === targetId) {
        space.activeTargetId = space.tabs.at(-1)?.targetId ?? null;
      }
      targetSpace.delete(targetId);
      releaseTarget(targetId);
      bumpRevision(space);
    },
    /**
     * 활성 탭을 바꾼다. `Target.activateTarget` 이 성공한 뒤 부른다.
     *
     * 헤드리스에는 사람이 보는 "앞에 있는 창"이 없으므로, **활성 탭의 정본은 장부**다.
     * 이걸 안 적으면 `Target.activateTarget` 이 성공해도 `listTabs` 의 `active` 가 안 바뀌고,
     * 벤더 `currentTab()` 이 옛 탭을 계속 준다(업스트림 e2e 의 탭 케이스가 잡았다).
     */
    setActiveTarget(targetId) {
      const space = this.workspaceOfTarget(targetId);
      if (!space) return false;
      if (space.activeTargetId === targetId) return true;
      space.activeTargetId = targetId;
      space.revision += 1;
      persist();
      return true;
    },

    /**
     * 브라우저의 실제 타깃 목록과 장부의 탭을 맞춘다.
     *
     * 장부가 탭의 **주소를 만든 시점 그대로** 들고 있으면 두 가지가 깨진다. 벤더
     * `openOrReuseTab` 은 목록의 url 로 재사용할 탭을 고르므로 이동한 탭을 못 찾아 매번 새 탭을
     * 열고, 페이지가 스스로 닫은 탭(`window.close`)은 목록에 유령으로 남는다. 둘 다 업스트림
     * e2e 케이스가 실제로 잡아냈다(navigation helpers, workflow multi-page navigation).
     *
     * @param {object} space
     * @param {Map<string, {url?:string, title?:string}>} live `Target.getTargets` 의 페이지 타깃
     */
    syncTabs(space, live) {
      if (!space) return { updated: 0, dropped: 0 };
      let updated = 0;
      const gone = [];
      for (const tab of space.tabs) {
        const info = live.get(tab.targetId);
        if (!info) {
          gone.push(tab.targetId);
          continue;
        }
        const url = info.url ?? tab.url;
        const title = info.title ?? tab.title;
        if (url !== tab.url || title !== tab.title) {
          tab.url = url;
          tab.title = title;
          updated += 1;
        }
      }
      for (const targetId of gone) this.forgetTarget(targetId);
      if (updated > 0 || gone.length > 0) persist();
      return { updated, dropped: gone.length };
    },

    /** 벤더 nav.ts:112-133 이 읽는 모양. active 가 하나도 없으면 마지막 탭을 활성으로 본다. */
    tabsOf(space) {
      const tabs = space.tabs.map((tab, index) => ({
        targetId: tab.targetId,
        title: tab.title || "",
        url: tab.url || "",
        active: tab.targetId === space.activeTargetId,
        index,
      }));
      if (tabs.length > 0 && !tabs.some((t) => t.active)) tabs[tabs.length - 1].active = true;
      return tabs;
    },

    // ── 타깃 장부 ───────────────────────────────────────────────────────────
    workspaceOfTarget(targetId) {
      const spaceId = targetSpace.get(targetId);
      return spaceId === undefined ? null : (spaces.get(spaceId) ?? null);
    },
    knowsTarget(targetId) {
      return targetSpace.has(targetId);
    },
    bindTarget(targetId, spaceId) {
      targetSpace.set(targetId, Number(spaceId));
      persist();
    },
    targetsOf(connection) {
      const owned = new Set();
      for (const [targetId, lease] of leases) {
        if (lease.connection === connection) owned.add(targetId);
      }
      for (const [targetId, owner] of routing) {
        if (owner === connection) owned.add(targetId);
      }
      return [...owned];
    },
    /** 이벤트 라우팅용 주인. attach 한 연결이 있으면 그 연결, 없으면 탭을 만든 연결이다. */
    targetOwner(targetId) {
      return leases.get(targetId)?.connection ?? routing.get(targetId) ?? null;
    },
    /**
     * 탭을 만든 연결을 그 탭의 이벤트 주인으로 적는다. 배타 lease 는 걸지 않는다.
     * 연결이 공간을 골라 뒀으면 타깃을 그 공간에 묶고 **탭 목록에도 넣는다**.
     *
     * S2d 는 여기서 `targetSpace` 만 채웠다. 그래서 원시 CDP `Target.createTarget` 으로 만든
     * 탭은 `Target.getTargetInfo` 는 통과하는데 `listTabs` 에는 안 보이는 비대칭이 남았다
     * (S2d 증거 5번). 같은 탭이 한 표면에서는 있고 다른 표면에서는 없으면 에이전트는 자기가
     * 만든 탭을 다시 찾지 못한다. 두 표면을 같은 장부에서 뽑는다.
     */
    claimTarget(connection, targetId, { url = "", title = "" } = {}) {
      routing.set(targetId, connection);
      const selected = connection?.selectedSpaceId;
      if (selected === null || selected === undefined) return true;
      const space = spaces.get(Number(selected));
      if (!space) return true;
      if (!targetSpace.has(targetId)) targetSpace.set(targetId, space.id);
      if (targetSpace.get(targetId) !== space.id) {
        // 남의 공간 타깃이면 목록에 넣지 않는다. 소유 판정은 중계기가 따로 한다.
        return true;
      }
      if (!space.tabs.some((tab) => tab.targetId === targetId)) {
        space.tabs.push({ targetId, url: url ?? "", title: title ?? "" });
        space.activeTargetId = targetId;
        space.revision += 1;
      }
      persist();
      return true;
    },
    releaseTarget,
    /**
     * 타깃이 브라우저에서 사라졌다. 라우팅·lease 뿐 아니라 **탭 목록에서도** 뺀다.
     * S2d·S2e 까지는 `releaseTarget` 만 불러서, 원시 CDP `Target.closeTarget` 으로 닫은 탭이
     * `listTabs` 에 유령으로 남았다. 벤더 `closeTab` 은 목록에서 사라질 때까지 기다리므로
     * 그 상태에서 **영원히 기다린다**(헬퍼 행렬 첫 측정에서 실제로 걸렸다).
     */
    forgetTarget(targetId) {
      const space = this.workspaceOfTarget(targetId);
      if (space) {
        this.removeTab(space, targetId);
        return true;
      }
      releaseTarget(targetId);
      return false;
    },

    // ── 타깃 lease (계약 4.3.1) ────────────────────────────────────────────
    /**
     * attach 요청 하나를 예약한다. **동기**이고 원자적이다 — 두 연결이 같은 tick 에 불러도
     * 먼저 들어온 쪽만 예약을 얻는다(Node 는 단일 스레드라 이 함수 안에 선점점이 없다).
     */
    reserveAttach(connection, targetId) {
      const lease = leases.get(targetId);
      if (lease && lease.connection !== connection) {
        return {
          ok: false,
          code: TARGET_BUSY,
          message:
            `타깃 ${targetId} 는 다른 연결이 이미 붙잡고 있다. 한 타깃에 한 연결만 붙는다 ` +
            "(#582 계약 4.3.1). 그 연결이 끝나면 다시 시도한다.",
        };
      }
      const generation = (generations.get(targetId) ?? 0) + 1;
      generations.set(targetId, generation);
      // 같은 연결의 재접속(세션 상실 뒤)은 옛 예약을 대체한다. 옛 세대의 늦은 응답은 묘비가 막는다.
      if (lease?.sessionId) dropSession(lease.sessionId);
      leases.set(targetId, { connection, generation, state: "reserved", sessionId: null });
      return { ok: true, generation };
    },

    /**
     * attach 응답(또는 attach 이벤트)이 도착했다.
     * 예약이 철회됐거나(연결 종료) 세대가 낡았으면 `{ok:false}` 다 — 그때 감독자는
     * 그 세션을 내부적으로 detach 해야 한다. 그러지 않으면 주인 없는 세션이 남는다.
     */
    settleAttach,

    /** attach 가 실패했다(오류 응답·상한 초과). 예약만 걷어낸다. */
    failAttach({ connection, targetId, generation }) {
      const lease = leases.get(targetId);
      if (!lease || lease.connection !== connection || lease.generation !== generation) return false;
      if (lease.state === "reserved") leases.delete(targetId);
      return true;
    },

    /**
     * `Target.attachedToTarget` 이벤트가 왔다. 응답보다 먼저 올 수도, 나중에 올 수도 있다.
     * 예약·소유가 있으면 그 연결의 것이고, 없으면 **예기치 않은 자식**이라 fail-closed 다.
     */
    resolveAttachedEvent({ targetId, sessionId }) {
      if (hostSessions.has(sessionId)) return { ok: true, host: true, connection: null };
      const pendingHost = hostAttaches.get(targetId) ?? 0;
      if (pendingHost > 0) {
        if (pendingHost <= 1) hostAttaches.delete(targetId);
        else hostAttaches.set(targetId, pendingHost - 1);
        hostSessions.add(sessionId);
        return { ok: true, host: true, connection: null };
      }
      const known = sessions.get(sessionId);
      if (known) return { ok: true, connection: known.connection, record: known };
      const lease = targetId ? leases.get(targetId) : null;
      if (!lease) return { ok: false, reason: "unexpected-child" };
      const settled = settleAttach({
        connection: lease.connection,
        targetId,
        generation: lease.generation,
        sessionId,
      });
      if (!settled.ok) return { ok: false, reason: settled.reason };
      return { ok: true, connection: lease.connection, record: settled.record };
    },

    /**
     * 예기치 않은 자식 세션을 감독자가 끊는다. `waitingForDebugger` 로 멈춘 타깃도 detach 하면
     * 함께 풀린다(detach 는 디버거 대기를 해제한다).
     */
    rejectChildSession(sessionId, reason = "unexpected-child") {
      rejectedChildren.push({ sessionId, reason });
      tombstones.add(sessionId);
      if (!hostRequest) return Promise.resolve(false);
      return hostRequest("Target.detachFromTarget", { sessionId })
        .then(() => true)
        .catch(() => false);
    },

    /** 등록된 세션이 디버거 대기 중이면 감독자 전용 통로로 풀어 준다(연결에는 비노출). */
    resumeIfWaiting(sessionId) {
      if (!hostRequest) return Promise.resolve(false);
      return hostRequest("Runtime.runIfWaitingForDebugger", {}, sessionId)
        .then(() => true)
        .catch(() => false);
    },

    // ── 감독자 자신의 세션 ─────────────────────────────────────────────────
    /** 감독자가 attach 를 보내기 직전에 표시한다. 짝 이벤트가 자식으로 오해받지 않게. */
    beginHostAttach(targetId) {
      if (typeof targetId !== "string" || targetId === "") return;
      hostAttaches.set(targetId, (hostAttaches.get(targetId) ?? 0) + 1);
    },
    noteHostSession(sessionId) {
      if (typeof sessionId === "string" && sessionId !== "") hostSessions.add(sessionId);
    },
    endHostSession(sessionId) {
      return hostSessions.delete(sessionId);
    },
    isHostSession(sessionId) {
      return hostSessions.has(sessionId);
    },

    // ── 세션 장부 ───────────────────────────────────────────────────────────
    sessionRecord(sessionId) {
      return sessions.get(sessionId) ?? null;
    },
    sessionOwner(sessionId) {
      return sessions.get(sessionId)?.connection ?? null;
    },
    sessionsOf(connection) {
      return [...sessions.entries()].filter(([, r]) => r.connection === connection).map(([s]) => s);
    },
    isTombstoned(sessionId) {
      return tombstones.has(sessionId);
    },
    dropSession,

    /** 연결이 사라졌다. 그 연결의 예약·세션만 걷어낸다. 다른 연결은 건드리지 않는다. */
    detachConnection(connection) {
      const revoked = [];
      for (const [targetId, lease] of [...leases]) {
        if (lease.connection !== connection) continue;
        leases.delete(targetId);
        revoked.push(targetId);
      }
      for (const [targetId, owner] of [...routing]) {
        if (owner === connection) routing.delete(targetId);
      }
      const gone = [];
      for (const [sessionId, record] of [...sessions]) {
        if (record.connection !== connection) continue;
        sessions.delete(sessionId);
        tombstones.add(sessionId);
        gone.push(sessionId);
      }
      return { revoked, sessions: gone };
    },

    /** 시험용 관측 창. 판정에 쓰지 않는다. */
    inspect() {
      return {
        spaces: [...spaces.keys()],
        contexts: [...spaces.values()].map((s) => s.browserContextId),
        targets: Object.fromEntries([...targetSpace]),
        routing: [...routing.keys()],
        leases: [...leases.entries()].map(([targetId, lease]) => ({
          targetId,
          generation: lease.generation,
          state: lease.state,
          sessionId: lease.sessionId,
        })),
        sessions: [...sessions.keys()],
        tombstones: [...tombstones],
        rejectedChildren: [...rejectedChildren],
      };
    },
  };
}
