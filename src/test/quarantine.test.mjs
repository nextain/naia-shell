#!/usr/bin/env node
/** quarantine — 보류 격리 라이프사이클 순수 코어 검증 (날짜 주입, fs/git 무관).
 *  처분 6번째 방식: 방치 의심 자산 격리 → 만료 시 자동 압축(비파괴) → 사용자 처분 대기.
 *  불변원칙: 백그라운드는 검출·압축·보고만, 삭제는 사용자 의도 호출만 (여기선 상태전이 정합만 검증). */
import {
	monthsAfter,
	todayStr,
	makeEntry,
	computeStatus,
	entriesToArchive,
	pendingEntries,
	findEntry,
	emptyManifest,
	DEFAULT_RETENTION_MONTHS,
} from "../../scripts/quarantine.mjs";

let pass = 0,
	fail = 0;
const check = (n, c) => {
	console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${n}`);
	c ? pass++ : fail++;
};
const D = (s) => new Date(`${s}T00:00:00Z`);

// 1) monthsAfter — 기본 + 연 롤오버 + 말일 보정
check("monthsAfter 기본 +3개월", monthsAfter("2026-05-30", 3) === "2026-08-30");
check("monthsAfter 연 롤오버 (11월+3=익년 2월)", monthsAfter("2026-11-15", 3) === "2027-02-15");
check("monthsAfter 말일 보정 (1/31 +1 = 2/28)", monthsAfter("2026-01-31", 1) === "2026-02-28");
check("monthsAfter 윤년 말일 (2024-01-31 +1 = 2/29)", monthsAfter("2024-01-31", 1) === "2024-02-29");
check("monthsAfter 0개월 = 동일", monthsAfter("2026-05-30", 0) === "2026-05-30");

// 2) makeEntry — 기본 보관기간 + review_by 계산 + compress 기본 true
{
	const e = makeEntry({ name: "api-server", origin: "api-server", reason: "방치 스캐폴드", now: D("2026-05-30") });
	check("makeEntry 기본 보관 = 3개월", e.retention_months === DEFAULT_RETENTION_MONTHS && e.retention_months === 3);
	check("makeEntry review_by = 격리+3개월", e.review_by === "2026-08-30");
	check("makeEntry compress_on_expiry 기본 true", e.compress_on_expiry === true);
	check("makeEntry 초기 status=active, pending=false", e.status === "active" && e.pending_notice === false);
	check("makeEntry 사유 보존", e.reason === "방치 스캐폴드");
}
{
	const e = makeEntry({ name: "x", retention_months: 6, compress_on_expiry: false, now: D("2026-05-30") });
	check("makeEntry 보관기간 지정 반영", e.retention_months === 6 && e.review_by === "2026-11-30");
	check("makeEntry compress_on_expiry=false 반영", e.compress_on_expiry === false);
	check("makeEntry origin 미지정 시 name 으로", e.origin === "x");
}

// 3) computeStatus — active / expired / archived
{
	const e = makeEntry({ name: "y", now: D("2026-05-30") }); // review_by=2026-08-30
	check("review_by 전 = active", computeStatus(e, D("2026-08-29")) === "active");
	check("review_by 당일 = expired", computeStatus(e, D("2026-08-30")) === "expired");
	check("review_by 후 = expired", computeStatus(e, D("2026-09-01")) === "expired");
	const a = { ...e, status: "archived" };
	check("archived 는 만료여부 무관 archived 유지", computeStatus(a, D("2030-01-01")) === "archived");
}

// 4) entriesToArchive — 만료 active 만 골라냄 (archived/active-미만료 제외)
{
	const m = emptyManifest();
	m.quarantined.push(makeEntry({ name: "old", now: D("2026-01-01") })); // review_by 2026-04-01
	m.quarantined.push(makeEntry({ name: "fresh", now: D("2026-05-01") })); // review_by 2026-08-01
	m.quarantined.push({ ...makeEntry({ name: "done", now: D("2026-01-01") }), status: "archived" });
	const arch = entriesToArchive(m, D("2026-05-30"));
	check("entriesToArchive = 만료 active 만 (old)", arch.length === 1 && arch[0].name === "old");
	check("entriesToArchive 미만료 fresh 제외", !arch.some((e) => e.name === "fresh"));
	check("entriesToArchive 이미 archived 제외", !arch.some((e) => e.name === "done"));
}

// 5) pendingEntries / findEntry
{
	const m = emptyManifest();
	m.quarantined.push({ ...makeEntry({ name: "p" }), pending_notice: true });
	m.quarantined.push({ ...makeEntry({ name: "q" }), pending_notice: false });
	check("pendingEntries = pending_notice 만", pendingEntries(m).length === 1 && pendingEntries(m)[0].name === "p");
	check("findEntry 이름 매칭", findEntry(m, "q")?.name === "q");
	check("findEntry 없는 이름 = undefined", findEntry(m, "zzz") === undefined);
}

// 6) 상태전이 시뮬레이션: active → (cron check) → archived+pending → (extend) → active
{
	const e = makeEntry({ name: "scaffold", now: D("2026-05-30") }); // review_by 2026-08-30
	// cron 이 만료 검출 후 하는 일(자동 압축 + 상태전이)을 순수하게 재현:
	const m = emptyManifest();
	m.quarantined.push(e);
	const due = entriesToArchive(m, D("2026-09-01"));
	check("만료 시점에 아카이브 대상 1건", due.length === 1);
	// cron 처리 모사
	due[0].status = "archived";
	due[0].pending_notice = true;
	check("처리 후 computeStatus=archived", computeStatus(e, D("2026-09-01")) === "archived");
	check("처리 후 처분 대기 surface", pendingEntries(m).length === 1);
	// 더 이상 아카이브 대상 아님(중복 압축 방지)
	check("재실행 시 중복 아카이브 안 함", entriesToArchive(m, D("2026-12-01")).length === 0);
	// extend 모사(연장 → 대기 해제)
	e.review_by = monthsAfter(todayStr(D("2026-09-01")), 6);
	e.status = "active";
	e.pending_notice = false;
	check("연장 후 active 복귀 + 대기 해제", computeStatus(e, D("2026-09-01")) === "active" && pendingEntries(m).length === 0);
}

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
