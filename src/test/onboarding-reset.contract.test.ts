// 온보딩을 되살리는 길이 실제로 열려 있는지 고정한다 (#564).
//
// 왜 이 파일이 있는가: 스펙 넷(09·13·67·54b)이 `localStorage` 만 비우고
// 새로 고치는 것으로 온보딩을 되살리려 했고, 넷 다 `.onboarding-overlay` 를
// 삼십 초 기다리다 죽었다. 이슈는 하이드레이션을 원인으로 적었지만 코드를 읽어
// 보면 `mergeBootConfig` 는 이미 파일의 `onboardingComplete` 를 지우고 로컬 값을
// 쓴다. 실제로 되돌리는 것은 `App.tsx` 의 **자동 실행 씨앗**이다 — 그 블록이 매
// 렌더마다 `naia-config` 를 통째로 다시 쓰면서 `onboardingComplete: true` 를
// 되살린다.
//
// 그래서 하네스 쪽에 표식을 하나 두고, 그 표식이 있으면 씨앗을 건너뛰게 했다.
// 여기서 재는 것은 그 배선이다 — 표식 이름이 두 파일에서 같은가, 그리고 씨앗이
// 정말 그 표식으로 막히는가. 이름이 어긋나거나 가드가 사라지면 네 스펙이 다시
// 같은 자리에서 삼십 초씩 죽는데, 그것을 알아차리는 데 한 시간짜리 실행이
// 필요해서는 안 된다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const APP_TSX = resolve(ROOT, "packages", "shell", "src", "App.tsx");
const HELPERS = resolve(
	ROOT,
	"packages",
	"shell",
	"e2e-tauri",
	"helpers",
	"settings.ts",
);
const DISPATCH_SPEC = resolve(
	ROOT,
	"packages",
	"shell",
	"e2e-tauri",
	"specs",
	"environment-dispatch.spec.ts",
);

function parse(path: string): ts.SourceFile {
	return ts.createSourceFile(
		path,
		readFileSync(path, "utf8"),
		ts.ScriptTarget.Latest,
		true,
		path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
}

/** `const <이름> = "<값>"` 의 값. 없으면 null. */
function stringConst(tree: ts.SourceFile, name: string): string | null {
	let found: string | null = null;
	const visit = (node: ts.Node): void => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === name &&
			node.initializer &&
			ts.isStringLiteral(node.initializer)
		) {
			found = node.initializer.text;
			return;
		}
		node.forEachChild(visit);
	};
	visit(tree);
	return found;
}

/**
 * `localStorage.setItem("naia-config", …)` 를 감싸는 `if` 의 조건.
 *
 * 글자로 찾지 않는다 — 주석에 조건을 적어 두는 것으로는 통과하지 못해야 한다.
 */
function seedGuardCondition(tree: ts.SourceFile): string | null {
	let condition: string | null = null;
	const writesNaiaConfig = (node: ts.Node): boolean => {
		let hit = false;
		const walk = (n: ts.Node): void => {
			if (hit) return;
			if (
				ts.isCallExpression(n) &&
				ts.isPropertyAccessExpression(n.expression) &&
				n.expression.name.text === "setItem" &&
				ts.isIdentifier(n.expression.expression) &&
				n.expression.expression.text === "localStorage" &&
				n.arguments[0] &&
				ts.isStringLiteral(n.arguments[0]) &&
				(n.arguments[0] as ts.StringLiteral).text === "naia-config"
			) {
				hit = true;
				return;
			}
			n.forEachChild(walk);
		};
		walk(node);
		return hit;
	};
	const visit = (node: ts.Node): void => {
		if (condition) return;
		if (ts.isIfStatement(node) && writesNaiaConfig(node.thenStatement)) {
			condition = node.expression.getText(tree);
			return;
		}
		node.forEachChild(visit);
	};
	visit(tree);
	return condition;
}

describe("온보딩을 되살리는 길 (#564)", () => {
	it("표식 이름이 제품과 하네스에서 같다", () => {
		const app = stringConst(parse(APP_TSX), "E2E_FORCE_ONBOARDING_KEY");
		const helper = stringConst(parse(HELPERS), "FORCE_ONBOARDING_KEY");

		// 이름이 어긋나면 표식은 조용히 아무 일도 하지 않는다. 스펙은 삼십 초를
		// 기다리다 죽고, 화면에는 "오버레이가 안 뜬다" 만 남는다.
		expect(app, "App.tsx 에 표식 상수가 없다").not.toBeNull();
		expect(helper, "helpers/settings.ts 에 표식 상수가 없다").not.toBeNull();
		expect(helper).toBe(app);
	});

	it("자동 실행 씨앗이 그 표식으로 막힌다", () => {
		const condition = seedGuardCondition(parse(APP_TSX));

		// 이 가드가 사라지면 `naia-config` 를 비우고 새로 고쳐도 씨앗이 곧바로
		// `onboardingComplete: true` 를 되돌려, 마법사가 영영 뜨지 않는다.
		expect(condition, "naia-config 를 쓰는 if 문을 찾지 못했다").not.toBeNull();
		expect(condition).toContain("e2eForceOnboarding");
	});

	it("온보딩을 되돌리는 스펙이 저마다 손으로 비우지 않고 같은 헬퍼를 쓴다", () => {
		// 손으로 적힌 세 줄이 남아 있으면 그 스펙만 다시 조용히 실패한다.
		// 13-lab-login·67-onboarding-config-save 는 사라진 화면(랩 카드, API 키
		// 단계)을 재던 것이라 걷고, 그 몫은 09 가 지금 마법사로 잰다.
		for (const name of ["09-onboarding", "54b-settings-locale-prompt"]) {
			const source = readFileSync(
				resolve(ROOT, "packages", "shell", "e2e-tauri", "specs", `${name}.spec.ts`),
				"utf8",
			);
			expect(source, `${name} 이 resetOnboarding 을 쓰지 않는다`).toContain(
				"resetOnboarding(",
			);
			expect(
				manualOnboardingResets(parse(
					resolve(ROOT, "packages", "shell", "e2e-tauri", "specs", `${name}.spec.ts`),
				)),
				`${name} 에 손으로 비우는 옛 줄이 남아 있다`,
			).toEqual([]);
		}
	});

	it("옛 모양은 잡고, 온보딩과 무관한 캐시 비우기는 잡지 않는다", () => {
		const sample = (code: string) =>
			manualOnboardingResets(
				ts.createSourceFile("s.ts", code, ts.ScriptTarget.Latest, true),
			);
		expect(
			sample(`it("x", async () => {
				await browser.execute(() => localStorage.removeItem("naia-config"));
				await safeRefresh();
				await (await $(S.onboardingOverlay)).waitForDisplayed();
			});`),
		).toHaveLength(1);
		expect(
			sample(`async function seed() {
				await browser.execute(() => localStorage.removeItem("naia-config"));
			}`),
		).toEqual([]);
	});
});

/**
 * 손으로 온보딩을 되돌리는 함수들의 이름.
 *
 * 옛 모양은 한 함수 안에서 `naia-config` 를 지우고 온보딩 화면을 기다리는
 * 것이다. 예전 판정은 `removeItem("naia-config")` 글자 하나만 봤다. 그래서
 * 54b 가 설정 이전(migration)을 재려고 캐시를 비우는 자리 — 온보딩과 무관하다 —
 * 까지 옛 줄로 세어, 스펙을 고치지 않고는 초록이 될 수 없었다. 이제 같은 함수가
 * 온보딩을 기다리는지까지 본다.
 */
function manualOnboardingResets(tree: ts.SourceFile): string[] {
	const out: string[] = [];
	const clearsConfig = (node: ts.Node): boolean => {
		let hit = false;
		const walk = (n: ts.Node): void => {
			if (hit) return;
			if (
				ts.isCallExpression(n) &&
				ts.isPropertyAccessExpression(n.expression) &&
				n.expression.name.text === "removeItem" &&
				n.arguments[0] &&
				ts.isStringLiteral(n.arguments[0]) &&
				(n.arguments[0] as ts.StringLiteral).text === "naia-config"
			) {
				hit = true;
				return;
			}
			n.forEachChild(walk);
		};
		walk(node);
		return hit;
	};
	const waitsForOnboarding = (node: ts.Node): boolean => {
		let hit = false;
		const walk = (n: ts.Node): void => {
			if (hit) return;
			if (ts.isIdentifier(n) && /^onboarding(?:Overlay|Step)$/.test(n.text)) {
				hit = true;
				return;
			}
			n.forEachChild(walk);
		};
		walk(node);
		return hit;
	};
	const visit = (node: ts.Node): void => {
		if (
			(ts.isFunctionDeclaration(node) ||
				ts.isArrowFunction(node) ||
				ts.isFunctionExpression(node)) &&
			node.body &&
			// browser.execute 콜백은 페이지 안에서 도는 조각이라 바깥 함수가 판정한다.
			!(
				ts.isCallExpression(node.parent) &&
				ts.isPropertyAccessExpression(node.parent.expression) &&
				node.parent.expression.name.text === "execute"
			)
		) {
			if (clearsConfig(node.body) && waitsForOnboarding(node.body)) {
				out.push(
					ts.isFunctionDeclaration(node) && node.name
						? node.name.text
						: `<line ${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}>`,
				);
			}
		}
		node.forEachChild(visit);
	};
	visit(tree);
	return out;
}

/** 이 파일이 던지는 오류 문구들. 주석은 코드가 아니므로 세지 않는다. */
function thrownMessages(tree: ts.SourceFile): string[] {
	const out: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isThrowStatement(node) && node.expression) {
			out.push(node.expression.getText(tree));
		}
		node.forEachChild(visit);
	};
	visit(tree);
	return out;
}

describe("환경 전달 스펙의 전제 (#502)", () => {
	const source = readFileSync(DISPATCH_SPEC, "utf8");

	it("뇌의 생사에 기대어 던지지 않는다", () => {
		// 자격증명 등급이 살아 있는 공급자를 심게 된 뒤(#547) "뇌가 없다" 는
		// 전제는 영구히 깨졌다. 그 전제로 **던지는** 자리가 남아 있으면 이 스펙은
		// 매 실행마다 제품과 무관한 실패로 남는다. 주석에 그 낱말이 남는 것은
		// 왜 바꿨는지를 적은 것이므로 세지 않는다 — 그래서 글자가 아니라 노드로
		// 본다.
		for (const message of thrownMessages(parse(DISPATCH_SPEC))) {
			expect(message).not.toContain("전제 불성립");
		}
	});

	it("답이 올 수 없는 요청에 확인이 오지 않는지를 잰다", () => {
		// 이것이 없으면 위 단정은 그냥 "느슨해졌다" 는 뜻이 된다. 재는 것이
		// 남아 있어야 한다 — 셸이 확인을 지어내면 이 요청에도 확인이 온다.
		expect(source).toContain("bogusOutcome");
		expect(source).toContain('expect(probe.bogusOutcome).toBe("NO_ACK")');
	});
});
