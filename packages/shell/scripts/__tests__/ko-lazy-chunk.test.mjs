import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { setLocale, t, tKo } from "../../src/lib/i18n";

const koLoaded = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/locales/ko", async (importOriginal) => {
	koLoaded();
	return importOriginal();
});

const shellDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const i18nPath = resolve(shellDirectory, "src/lib/i18n.ts");
const koPath = resolve(shellDirectory, "src/lib/locales/ko.ts");

/**
 * ko 표 진입 번들 고정: ko.ts 는 localeLoaders 의 동적 import() 로만 닿는다.
 *
 * 왜 소스 텍스트로 보는가: 진입 index-*.js 바이트는 dist 빌드에서만 재는데,
 * 정적 import/export-from 한 줄이 진입 청크에 ko.ts 전체를 합치는 유일한
 * 길이다. 빌드 없이도 그 길을 막으면 진입에 ko 가 들지 않는다.
 * 동적 `import("...")` 은 지연 chunk 경계라 허용하고, `import type` 은
 * 컴파일 때 지워져 번들에 없으므로 세지 않는다.
 */
function staticKoImports(source) {
	return source.split("\n").filter((line) => {
		const text = line.trim();
		if (/^import\s+type\b/.test(text)) return false;
		if (!/^(import|export)\b/.test(text)) return false;
		if (!/\bfrom\s*['"]/.test(text)) return false;
		return text.includes("locales/ko");
	});
}

function sourceFiles(directory) {
	const out = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "__tests__") continue;
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(path));
		else if (/\.(ts|tsx|mts)$/.test(entry.name)) out.push(path);
	}
	return out;
}

describe("ko table stays out of the entry chunk", () => {
	it("fixed Korean lookup works before the full ko table loads", async () => {
		await setLocale("en");
		expect(tKo("speech.reading.word.ai")).toBe("에이아이");
		expect(tKo("kiosk.sourceLabel")).toBe("넥스테인·나이아 공개 지식");
		expect(koLoaded).not.toHaveBeenCalled();
		expect(() => tKo("toString")).toThrow("missing_ko_translation");

		await setLocale("ko");
		expect(koLoaded).toHaveBeenCalledTimes(1);
		expect(t("chat.outputStage.thinking")).toBe("생각 중…");
		expect(tKo("speech.reading.word.ai")).toBe("에이아이");
	});

	it("i18n.ts loads ko only through a dynamic import()", () => {
		const source = readFileSync(i18nPath, "utf8");
		expect(staticKoImports(source)).toEqual([]);
		expect(source).toMatch(/ko:\s*\(\)\s*=>\s*import\(["']\.\/locales\/ko["']\)/);
	});

	it("no non-test source file statically imports the ko table", () => {
		const offenders = [];
		for (const file of sourceFiles(resolve(shellDirectory, "src"))) {
			if (staticKoImports(readFileSync(file, "utf8")).length > 0)
				offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	it("ko table keeps its shape and wording", () => {
		const ko = readFileSync(koPath, "utf8");
		expect(Buffer.byteLength(ko, "utf8")).toBeGreaterThan(100000);
		expect(ko).toMatch(/export\s+default\s*\{/);
		expect(ko).toContain("chat.outputStage.thinking");
		expect(ko).toContain("생각 중…");
	});
});
