// #582 UC-ENV-TOOL-BROWSE·CANCEL — 실제 어댑터(감독자 클라이언트)로 #499 계약 전체를 밟는다 (P02 골격, S3a 에서 채운다).
// 계약: docs/progress/issue-582-ego-browser-host.md 9절 S3a. 골격은 todo 로 두어 P02 매핑을 문서가 아니라 러너가 보게 한다.
import { describe, it } from "vitest";

describe("#582 실제 어댑터 계약 (S3a 에서 구현)", () => {
  it.todo("열기·이동·스냅샷·안정 참조 클릭·입력·캡처·닫기가 실제 Chromium 에서 돌고 증거 셋(스냅샷·캡처 파일·주소 개정)이 남는다");
  it.todo("취소와 완료가 경주하면 먼저 종결한 쪽이 남는다(CAS)");
  it.todo("같은 멱등 키의 동시 요청은 포트 호출 1회로 끝난다");
  it.todo("deadline 이 실제 타이머로 작동하고 timeout 은 완료로 승격되지 않는다");
  it.todo("취소 뒤 후속 이벤트·열린 가로채기·스트림·세션이 0 이다");
  it.todo("실행기 강제 종료 뒤 같은 작업 공간에 재접속한다");
  it.todo("낡은 참조(stale ref)와 개정 불일치는 다른 페이지에 작용하지 않고 형식 있는 오류로 끝난다");
  it.todo("작업 id 와 자원 id 가 증거·장부에서 일치한다");
});
