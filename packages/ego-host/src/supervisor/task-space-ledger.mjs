// #582 S2a — 작업 공간 임시 장부(인메모리).
//
// **이것은 S2c 의 장부가 아니다.** S2c 가 격리 브라우저 컨텍스트·원자적 저장·연결별 선택을
// 갖춘 장부를 만든다. 여기 있는 것은 ABI 표면(모양·숫자 id·ownership 문자열)을 벤더 런타임에
// 실제로 통과시키기 위한 최소 구현이며, 프로세스가 죽으면 사라진다.
//
// 헤드리스 정책(계약 4.4): 소유권은 언제나 "agent" 다. `agentDelegatedToUser`·`user` 는
// 헤드리스에서 도달 불가능하고, 인계·회수·claim 은 EGO_HANDOFF_UNSUPPORTED_HEADLESS 다.

/** 헤드리스에서 도달 가능한 유일한 소유권. 벤더 helpers.ts:118 의 세 문자열 중 하나. */
export const HEADLESS_OWNERSHIP = "agent";

export function createTaskSpaceLedger() {
  let nextId = 1;
  /** id(number) -> space */
  const spaces = new Map();

  function shape(space) {
    return {
      taskId: String(space.id),
      id: space.id,
      name: space.name,
      createdBy: "agent",
      ownership: HEADLESS_OWNERSHIP,
      recentTabTitles: space.tabs.map((t) => t.title).filter(Boolean).slice(-3),
    };
  }

  return {
    list() {
      return [...spaces.values()].map(shape);
    },
    get(id) {
      return spaces.get(Number(id)) ?? null;
    },
    shape,
    findByName(name) {
      for (const space of spaces.values()) if (space.name === name) return space;
      return null;
    },
    create(name) {
      const id = nextId++;
      const space = { id, name: String(name), tabs: [], activeTargetId: null };
      spaces.set(id, space);
      return space;
    },
    remove(id) {
      spaces.delete(Number(id));
    },
    addTab(space, tab) {
      space.tabs.push(tab);
      space.activeTargetId = tab.targetId;
    },
    removeTab(space, targetId) {
      const at = space.tabs.findIndex((t) => t.targetId === targetId);
      if (at >= 0) space.tabs.splice(at, 1);
      if (space.activeTargetId === targetId) {
        space.activeTargetId = space.tabs.at(-1)?.targetId ?? null;
      }
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
  };
}
