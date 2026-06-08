#!/usr/bin/env node
/** M13-link — 경로 헬퍼(상대링크) + 문서그래프(고립·절대경로·깨진링크) 검증. */
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { relativeLink } from "../../scripts/doc-link.mjs";
import { analyze } from "../../scripts/check-doc-graph.mjs";

let pass = 0, fail = 0;
const check = (n, c) => { console.log(`${c ? "✅ PASS" : "❌ FAIL"} — ${n}`); c ? pass++ : fail++; };

// 1) relativeLink 헬퍼
check("같은 디렉토리 → ./glossary.md", relativeLink("docs/lessons.md", "docs/glossary.md") === "./glossary.md");
check("하위 디렉토리 → ./progress/x.md", relativeLink("docs/lessons.md", "docs/progress/x.md") === "./progress/x.md");
check("상위로 → ../README.md", relativeLink("docs/sub/a.md", "docs/README.md").endsWith("../README.md"));

// 2) analyze — fixture docs 구성
function setupDocs(files) {
	const d = mkdtempSync(join(tmpdir(), "docs-"));
	for (const [p, c] of Object.entries(files)) {
		const fp = join(d, p);
		mkdirSync(dirname(fp), { recursive: true });
		writeFileSync(fp, c);
	}
	return d;
}

// 정상: README가 lessons·glossary를 링크, 상호 연결
{
	const d = setupDocs({
		"README.md": "# 진입점\n[교훈](./lessons.md) [용어집](./glossary.md)",
		"lessons.md": "# 교훈\n[용어집](./glossary.md)",
		"glossary.md": "# 용어집\n[교훈으로](./lessons.md)",
	});
	const r = analyze(d, ["README.md"]);
	check("정상 그래프(README 진입점) → 고립·절대·깨짐 0", r.orphans.length === 0 && r.absLinks.length === 0 && r.broken.length === 0);
}

// 고립: orphan.md를 아무도 링크 안 함
{
	const d = setupDocs({
		"README.md": "[교훈](./lessons.md)",
		"lessons.md": "# 교훈",
		"orphan.md": "# 고립된 문서",
	});
	const r = analyze(d, ["README.md"]);
	check("고립 문서(orphan.md) 탐지", r.orphans.includes("orphan.md"));
}

// 절대경로 링크
{
	const d = setupDocs({ "README.md": "[교훈](/abs/lessons.md) [윈](C:\\\\x\\\\y.md)", "lessons.md": "x" });
	const r = analyze(d, ["README.md", "lessons.md"]);
	check("절대경로 링크 탐지(2건)", r.absLinks.length === 2);
}

// 깨진 링크
{
	const d = setupDocs({ "README.md": "[없음](./missing.md)" });
	const r = analyze(d, ["README.md"]);
	check("깨진 링크(missing.md) 탐지", r.broken.length === 1);
}

// http/앵커는 무시
{
	const d = setupDocs({ "README.md": "[웹](https://x.com) [앵커](#sec) [메일](mailto:a@b.c)", "x.md": "[r](./README.md)" });
	const r = analyze(d, ["README.md", "x.md"]);
	check("http·앵커·mailto는 링크검사 제외", r.absLinks.length === 0 && r.broken.length === 0);
}

// 3) 디렉터리 기반 orphan 면제 (작업 기록 ledger) — cross-review 반영
// progress/ 아래 dated 문서는 면제, 단 큐레이트 문서가 파일명에 날짜를 넣어도 면제되면 안 됨.
{
	const d = setupDocs({
		"README.md": "[교훈](./lessons.md)",
		"lessons.md": "# 교훈",
		"progress/work-2026-05-30.md": "# 작업 기록 (아무도 안 링크)",
		"design-2026-05-30.md": "# 큐레이트 설계 (날짜 파일명, progress 밖 — 면제 금지)",
	});
	// 면제 없음: progress 문서도, dated 큐레이트도 둘 다 고립
	const r0 = analyze(d, ["README.md"]);
	check("면제 없음 → progress·dated 큐레이트 둘 다 고립", r0.orphans.includes("progress/work-2026-05-30.md") && r0.orphans.includes("design-2026-05-30.md"));
	// 디렉터리 면제(progress): progress 아래만 면제, dated 큐레이트는 여전히 고립
	const r1 = analyze(d, ["README.md"], ["progress"]);
	check("progress 디렉터리 면제 → progress 문서는 고립 아님", !r1.orphans.includes("progress/work-2026-05-30.md"));
	check("★ progress 밖 dated 큐레이트는 여전히 고립(파일명-날짜 면제 아님)", r1.orphans.includes("design-2026-05-30.md"));
	check("면제 디렉터리 결과에 기록", r1.exemptDirs.includes("progress"));
}

console.log(`\n결과: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
