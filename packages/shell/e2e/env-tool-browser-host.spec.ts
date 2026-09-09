import { test } from "@playwright/test";

/**
 * #582 UC-ENV-TOOL-SCRIPT — 브라우저 호스트 도구 노출과 승인 (실 UI, browser 등급). P02 골격, S6a 에서 채운다.
 * 계약: docs/progress/issue-582-ego-browser-host.md
 */
test.describe("#582 env_browser_* (S6a 에서 구현)", () => {
  test.fixme("형식 도구 호출이 증거(스냅샷·캡처·주소 개정)를 돌려준다", async () => {});
  test.fixme("승인 없는 env_browser_script 는 거부되고 관측 도구는 영향이 없다", async () => {});
  test.fixme("기존 skill_browser_* 의 이름·권한·동작은 바뀌지 않는다", async () => {});
});
