// #582 UC-ENV-TOOL-RECOVER — 감독자 생명주기 (P04, native). P02 골격, S6b 에서 채운다.
//
// 셸→IPC→Rust→감독자→Chromium 전체를 실 백엔드로 돈다. Reset·재시작·정상 종료 뒤
// 감독자 PID·marker·lease 가 회수됐는지, 다른 프로세스는 건드리지 않았는지 확인한다.
// 계약: docs/progress/issue-582-ego-browser-host.md 4.8·9절 S6b.

describe("브라우저 호스트 생명주기 (#582 UC-ENV-TOOL-RECOVER)", () => {
	it.skip("Reset 뒤 감독자와 Chromium 이 남지 않는다 (S6b 에서 구현)", () => {});
	it.skip("재시작 뒤 이전 lease 가 조정되고 marker 불일치 프로세스는 건드리지 않는다 (S6b 에서 구현)", () => {});
	it.skip("정상 종료 뒤 lease 파일이 정리된다 (S6b 에서 구현)", () => {});
});
