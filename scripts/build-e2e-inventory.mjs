/**
 * 실기 e2e 스펙이 무엇을 요구하는지 목록으로 뽑는다.
 *
 * 등급 이름은 새로 짓지 않고 .agents/context/feature-test-coverage.yaml 의
 * 어휘를 그대로 쓴다. 같은 것을 두 이름으로 부르면 두 목록이 서로 다른 말을
 * 하게 된다.
 *
 * 왜 필요한가: 스펙은 129개인데 어느 것이 어디서 돌 수 있는지 아무 데도
 * 적혀 있지 않다. 그 사실이 스펙 안의 환경 변수 조건문과 전용 wdio 설정에
 * 흩어져 있어서, "무엇이 안 돌고 있는가" 를 물어도 셀 수가 없다. 셀 수 없는
 * 것은 나눌 수도 없고, 나눌 수 없으면 여러 기계로 회귀를 돌릴 수 없다.
 *
 * 무엇을 뽑는가: 스펙마다 (1) 어느 wdio 설정이 맡는지 (2) 어떤 환경 변수를
 * 요구하는지 (3) 그래서 어떤 등급인지. 등급은 요구 조건에서 기계로 정한다 —
 * 사람이 붙이는 꼬리표는 곧 낡는다.
 *
 * 등급(feature-test-coverage.yaml 과 같은 어휘):
 *   deterministic_ci   자격증명 없이 돈다
 *   credentialed_live  외부 자격증명이 필요하다(모델 키, 게이트웨이 토큰)
 *   native_local       그 기계의 장치가 필요하다(GPU, 오디오, 데스크톱 세션)
 *
 * ## 대화 자국을 어디서 얻는가 (10회차 지적 9 이후)
 *
 * 예전에는 제공자 **식별자**로 `api.<id>` 꼴 호스트만 만들었다. 그래서 이
 * 저장소가 기본으로 쓰는 로컬 제공자 Ollama 의 실제 주소
 * (`http://localhost:11434`)가 자국에 없었고, 그것을 부르는 스펙이 결정론 칸에
 * 남았다 — 자격증명 없는 기계가 맡았다가 실패하는, 이미 두 번 겪은 그 오분류다.
 *
 * 이제 셸이 **모델에 닿는 모듈 전체**(`src/lib/llm/` 와 `src/lib/config.ts`)를
 * 읽어 주소·포트·경로 리터럴을 통째로 자국으로 삼는다. `http(s)://…`,
 * `localhost:11434`, `:11434`, `/v1/chat/completions`, `/api/tags` 같은 것들이다.
 * 자국 목록을 손으로 적지 않으므로, 제공자를 하나 더 붙이면 자국도 같이 는다.
 *
 * 그리고 주소를 자국으로 못 알아본 경우를 대비해 한 겹 더 둔다 — 헬퍼·스펙이
 * `fetch`/`request` 로 **자기 서버가 아닌 리터럴 주소**를 부르면 결정론 칸에서
 * 뺀다. 바깥 인터넷 호스트면 자격증명이 필요한 것으로, 고정 포트의 로컬
 * 서비스면 그 기계의 것으로 본다. 자기 서버(`http://127.0.0.1:${port}`)는
 * 포트가 변수라 구별된다.
 *
 * `--check` 가 보증하는 것: 저장된 `docs/e2e-inventory.json` 이 **지금 스펙에서
 * 다시 계산한 것과 글자 그대로 같은가**. 분류가 옳은지는 보증하지 않는다 —
 * 틀린 분류라도 목록과 일치하면 초록이다. 분류의 옳고 그름은 위 자국 규칙이
 * 지고, 이 검사는 목록이 낡는 것만 막는다.
 *
 * ## 호출부를 무엇으로 읽는가 (12회차 지적 6 이후)
 *
 * `fetch`/`request` 인지는 **적힌 이름**이 아니라 바인딩으로 읽는다. 자유
 * 식별자 `fetch`, `globalThis.fetch`/`window.fetch`, 그것으로 만든 const 별명과
 * 구조분해가 모두 같은 전역으로 돌아온다 — `const ghostGet = fetch;
 * ghostGet("https://…")` 는 이름만 다른 같은 호출이다. 자세한 것은
 * `outboundAddresses` 머리말에 적어 두었다.
 *
 * ## 이 목록이 따라가지 않는 것 (보증 밖)
 *
 * `scripts/lib/bindings.mjs` 의 보증 밖 목록을 그대로 물려받는다 — 동적 속성
 * 이름(`obj[name]`), `eval`/`new Function`/`Reflect.apply`/`Function.prototype`
 * 을 두 겹 이상 거친 호출, 고차 함수가 돌려준 함수, 배열·객체·`Map` 을 거쳐
 * 흘러간 함수, 동적 `import()`/`require()` 의 결과, 실행할 때 조립되는 문자열.
 * 주소 쪽도 같다 — 함수 매개변수로 받은 주소와 실행할 때 조립되는 템플릿은
 * "바깥 주소가 없다" 가 아니라 **모른다** 이고, 그 수를 세어 함께 적는다.
 * 이 경계 안쪽 형태는 모두 같은 규칙으로 잡히며, 경계 밖은 코드 리뷰의 몫이다.
 *
 * 산출물: docs/e2e-inventory.json (기계가 읽는 것) 과 표준 출력 요약.
 *
 * ## 이 저장소의 린트 경계가 금지하는 형태
 *
 * 아래는 게이트가 읽지 않기로 **선언**한 형태이고, 저장소에 들어오지 못한다 —
 * `scripts/check-lint-boundary.mjs` 가 막는다. 목록의 정본은
 * `scripts/lib/lint-boundary-forms.mjs` 하나이고, 이 머리말·린트 게이트·
 * `docs/quality-reviews/obfuscation-forms.md` 가 같은 목록을 본다. 셋이
 * 어긋나면 `src/test/lint-boundary.contract.test.ts` 가 붉어진다.
 *
 *   - `comma-operator` — 쉼표식 `(a, b)` · `(0, f)()`
 *   - `void-literal` — 리터럴에 씌운 `void` (`void 0`, `void "x"`)
 *   - `void-stacked` — 겹쳐 쌓은 `void` (`void void …`)
 *   - `computed-callee` — 리터럴 키로 곧바로 부르기 (`f["call"](…)`, `el["click"]()`)
 *
 * 이 모듈은 위 형태를 지금도 읽는다(이미 닫힌 자리다). 다만 **읽는 것에
 * 기대지 않는다** — 경계는 린트가 지고, 게이트는 자기가 읽는 범위를 지킨다.
 * 그래서 다음 회차의 도전은 린트를 통과하는 형태여야 한다.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import ts from "typescript";
import { resolveCallee } from "./lib/bindings.mjs";
import { makeEnv, staticStringsIn } from "./lib/jsx-static.mjs";
import { KNOWN_OS } from "./lib/release-target.mjs";

const SPEC_DIR = "packages/shell/e2e-tauri/specs";
const CONF_DIR = "packages/shell/e2e-tauri";
const HELPER_DIR = join(CONF_DIR, "helpers");

/** 주소를 이름 너머로 따라갈 때 쓰는 환경. `../helpers/x.js` 도 같은 값이다. */
function collectTypeScript(dir, out = new Map()) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			collectTypeScript(path, out);
			continue;
		}
		if (entry.isFile() && path.endsWith(".ts")) out.set(path, readFileSync(path, "utf8"));
	}
	return out;
}

const addressEnv = makeEnv(collectTypeScript(CONF_DIR));

// 장치를 요구한다고 보는 신호. 이름이 아니라 무엇을 켜는지로 고른다.
const DEVICE_ENV = /VOICE|AUDIO|VOXCPM2|NVA|SCREENSHOT|GPU|CASCADE/;

/**
 * 장치를 실제로 여는 스펙이 부르는 것들.
 *
 * 마이크·스피커·GPU 는 환경 변수에 드러나지 않는다. 그 스펙이 무엇을 부르는지로
 * 본다 — PipeWire 로 가상 소스를 만들거나, espeak 로 소리를 내거나,
 * nvidia-smi 로 GPU 를 묻는 자리다.
 */
const DEVICE_TOOLS =
	/\bpw-play\b|\bpw-cat\b|\bpactl\b|\bespeak\b|\bnvidia-smi\b|getUserMedia|MediaRecorder/;
// 자격증명으로 보는 신호.
const KEY_ENV = /API_KEY|_KEY$|TOKEN|SECRET|USER_ID/;

/**
 * 실제로 모델과 대화하는 스펙이 쓰는 헬퍼.
 *
 * 왜 이름으로 보는가: 셸은 모델 키를 환경 변수가 아니라 앱 설정에서 읽는다.
 * 그래서 "이 스펙이 진짜 대화를 하는가" 는 환경 변수 참조로는 알 수 없다.
 * 실제로 07-cleanup 은 모델에게 메모 삭제를 시키는데 요구 목록에는
 * 산출물 디렉터리 하나뿐이라 결정론 칸에 들어가 있었고, 자격증명 없는
 * 기계가 맡았다가 실패했다.
 */
/**
 * 예전에는 이 넷을 손으로 적어 두었다. 같은 파일에 있는
 * `verifyWithSubAgent`(부심판 모델을 실제로 부른다)가 목록에 없어서, 그
 * 헬퍼만 쓰는 스펙이 `deterministic_ci` 로 분류됐다 — 자격증명 없는 기계가
 * 맡았다가 실패하는, 이미 두 번 겪은 그 오분류다.
 *
 * 이제 목록을 만들지 않는다. **모델과 말을 섞는 헬퍼 모듈을 통째로** 본다.
 * 그 모듈이 내보내는 이름은 전부 대화 신호다. 새 헬퍼가 늘어도 목록을
 * 고칠 일이 없고, 고치는 것을 잊어 생기는 오분류도 없다.
 */
// 예전에는 모듈 이름 둘을 손으로 적었다. 그래서 다른 헬퍼 모듈에 모델을
// 부르는 함수를 두면 결정론 칸에 들어갔다 — 손 목록을 함수에서 모듈로 옮긴
// 것뿐이었다.
//
// 이제 모듈 목록도 만들지 않는다. 헬퍼 디렉터리를 전부 읽고, **모델과 말을
// 섞는 자국**이 있는 모듈을 대화 모듈로 본다. 자국은 판정 모델 호출, 모델
// 제공자 주소, 자격증명 이름이다.
// 자국은 두 갈래다. 하나는 모델을 직접 부르는 것(주소·자격증명·판정 호출),
// 다른 하나는 **앱의 대화 화면을 통해** 모델과 말하는 것이다. chat.ts 는
// 뒤쪽이라 HTTP 자국이 하나도 없다 — 앞쪽만 보면 그 모듈이 통째로 빠진다.
// 주소 목록을 손으로 적으면 목록에 없는 제공자로 빠져나간다 — 이 저장소가
// 기본으로 쓰는 xAI(`api.x.ai`)가 빠져 있었다. 제공자 주소는 셸의 registry 가
// 이미 알고 있으므로 거기서 뽑는다.
// 셸이 아는 제공자 식별자를 그대로 쓴다. 주소를 손으로 적으면 목록에 없는
// 제공자로 빠져나간다 — 이 저장소가 쓰는 xAI 가 그렇게 빠져 있었다.
// 식별자는 `api.x.ai`, `api.openai.com` 같은 주소 안에 그대로 나타난다.
const registrySource = readFileSync(
	"packages/shell/src/lib/llm/registry.ts",
	"utf8",
);
const providerIds = [
	...new Set(
		[...registrySource.matchAll(/^\t\t?id:\s*["']([a-z0-9-]+)["']/gm)].map(
			(m) => m[1],
		),
	),
].filter((id) => id.length >= 2);
const providerHosts = [
	...new Set([
		// 주소는 식별자를 그대로 쓰지 않는다 — `xai` 가 `api.x.ai` 다. 글자
		// 사이에 점이 끼어도 같은 제공자로 본다. `api.` 로 시작하고 점으로
		// 끝나는 자리에만 쓰므로 넓지 않다.
		...providerIds.map(
			// 뒤는 점이거나 경로 구분자다. 점만 요구하면 `api.x.ai/v1` 처럼
			// 도메인이 거기서 끝나는 주소를 놓친다.
			(id) => `api\\.${id.replace(/-/g, "").split("").join("\\.?")}[./]`,
		),
		...[...registrySource.matchAll(/https?:\/\/([a-z0-9.-]+)/g)]
			.map((m) => m[1])
			.filter((host) => /^api\./.test(host)),
	]),
];
if (providerIds.length < 5) {
	console.error(
		`[e2e-inventory] 제공자를 ${providerIds.length}개밖에 못 찾았다 — registry 경로가 바뀌었는지 보라`,
	);
	process.exit(2);
}
/**
 * 셸이 모델에 닿는 모듈에서 주소·포트·경로 리터럴을 통째로 뽑는다.
 *
 * 식별자로 만든 `api.<id>` 꼴만 보면 로컬 제공자가 통째로 빠진다 — Ollama 의
 * 기본 주소는 `http://localhost:11434` 라서 이름이 주소에 없다.
 */
const ADDRESS_SOURCES = [
	...readdirSync("packages/shell/src/lib/llm")
		.filter((f) => f.endsWith(".ts"))
		.map((f) => join("packages/shell/src/lib/llm", f)),
	"packages/shell/src/lib/config.ts",
];
const addressFootprints = new Set();
for (const path of ADDRESS_SOURCES) {
	let source;
	try {
		source = readFileSync(path, "utf8");
	} catch {
		continue;
	}
	for (const m of source.matchAll(/https?:\/\/([A-Za-z0-9.-]+(?::\d{2,5})?)([^\s"'`)]*)/g)) {
		const authority = m[1];
		addressFootprints.add(authority);
		const port = authority.split(":")[1];
		if (port && port !== "80" && port !== "443") addressFootprints.add(`:${port}`);
	}
	// 스킴 없이 적는 자리(`localhost:11434`, `127.0.0.1:8011`)도 같은 주소다.
	for (const m of source.matchAll(/\b(?:localhost|127\.0\.0\.1):(\d{2,5})\b/g))
		addressFootprints.add(`:${m[1]}`);
	// 모델 API 경로. 템플릿(`${host}/api/tags`)과 주석에 적힌 것도 같은 경로다.
	for (const m of source.matchAll(/\/(?:v\d+|api)\/[A-Za-z0-9/_.:-]+/g))
		addressFootprints.add(m[0]);
}
if (addressFootprints.size < 5) {
	console.error(
		`[e2e-inventory] 모델 주소 자국을 ${addressFootprints.size}개밖에 못 찾았다 — src/lib/llm 경로가 바뀌었는지 보라`,
	);
	process.exit(2);
}

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TALKS_TO_MODEL = new RegExp(
	[
		...providerHosts,
		...[...addressFootprints].map(escapeRe),
		String.raw`\bjudge\w*\s*\(`,
		"API_KEY",
		String.raw`_KEY\b`,
		"GATEWAY",
		String.raw`\.chat-message`,
		String.raw`\bassistant\w*\b`,
		"chat-input",
	].join("|"),
);
const chatHelperNames = new Set(["judge"]);
for (const entry of readdirSync(HELPER_DIR).filter((f) => f.endsWith(".ts"))) {
	let source;
	try {
		source = readFileSync(join(HELPER_DIR, entry), "utf8");
	} catch {
		continue;
	}
	if (!TALKS_TO_MODEL.test(source)) continue;
	for (const m of source.matchAll(
		/^export\s+(?:async\s+)?function\s+(\w+)/gm,
	))
		chatHelperNames.add(m[1]);
	for (const m of source.matchAll(/^export\s+const\s+(\w+)\s*=/gm))
		chatHelperNames.add(m[1]);
}
if (chatHelperNames.size < 5) {
	console.error(
		`[e2e-inventory] 대화 헬퍼를 ${chatHelperNames.size}개밖에 못 찾았다 — helpers 경로가 바뀌었는지 보라`,
	);
	process.exit(2);
}
const CHAT_HELPERS = new RegExp(
	`\\b(?:${[...chatHelperNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*\\(`,
);

/**
 * 전용 설정이 요구하는 환경도 그 스펙의 요구다.
 *
 * 설정은 모듈 최상위에서 그것을 확인하고 없으면 던진다. 그러면 스펙은 한 줄도
 * 돌지 못하는데, 요구 목록에는 그 사실이 없어 "환경이 갖춰졌다" 로 보인다 —
 * 실제로 전용 설정 넷이 그렇게 실패했다.
 */
const confEnv = new Map();

const confOwners = new Map();
for (const name of readdirSync(CONF_DIR).filter((f) => /^wdio\.conf\..+\.ts$/.test(f))) {
	const source = readFileSync(join(CONF_DIR, name), "utf8");
	for (const match of source.matchAll(/"\.\/specs\/([^"]+)"/g)) {
		const list = confOwners.get(match[1]) ?? [];
		list.push(name);
		confOwners.set(match[1], list);
	}
}

// 스펙이 직접 부르지 않아도, 불러 쓰는 헬퍼가 자격증명을 요구하면 그 스펙은
// 자격증명 없이 돌지 않는다. 실측에서 드러났다 — 06-skill-memo 는 env 를 하나도
// 적지 않았는데 helpers/semantic 이 판정 모델 키를 요구해 실패했다. 직접 참조만
// 세면 목록이 "돌 수 있다" 고 거짓말한다.
/**
 * 그 소스가 실제로 **필요로 하는** 환경 변수만 뽑는다.
 *
 * 세 가지를 가린다.
 *
 *   1) 쓸 만한 기본값이 있는 노브는 요구가 아니다. `?? "15000"` 처럼 실제
 *      값을 뒤에 둔 것은 없어도 돈다. 빈 문자열 기본(`?? ""`)은 다르다 —
 *      그것은 "없으면 빈 값으로 죽는다" 는 뜻이므로 요구로 센다.
 *   2) 이름을 변수로 받아 `process.env[name]` 으로 읽는 자리는 직접 참조가
 *      없다. 대신 그 이름이 소스 안에 문자열로 적혀 있으므로(`keyEnv:
 *      "OPENAI_API_KEY"`) 자격증명처럼 생긴 문자열도 함께 본다.
 *   3) 실행 환경이 늘 갖는 것(PATH 계열)은 요구가 아니다.
 */
const AMBIENT =
	/^(?:PATH|HOME|LD_LIBRARY_PATH|RUST_LOG|CI|NODE_ENV|TMPDIR|TAURI_BINARY|NAIA_E2E_TARGET_DIR|NAIA_AGENT_WORKTREES_DIR|NAIA_E2E_AGENT_ROOT)$/;

function requiredEnv(source) {
	const found = new Set();
	for (const m of source.matchAll(
		/process\.env\.([A-Z_0-9]+)\s*(?:(\|\||\?\?)\s*("(?:[^"\\]|\\.)*"|`[^`]*`|'[^']*'))?/g,
	)) {
		const [, name, , fallback] = m;
		if (AMBIENT.test(name)) continue;
		// 뒤에 실제 값이 붙어 있으면 없어도 돈다. 빈 문자열은 값이 아니다.
		if (fallback && fallback.replace(/^["'`]|["'`]$/g, "").length > 0) continue;
		found.add(name);
	}
	// 이름을 문자열로 들고 다니다 `process.env[name]` 으로 읽는 자리.
	if (/process\.env\[/.test(source)) {
		for (const m of source.matchAll(/["'`]([A-Z][A-Z_0-9]{3,})["'`]/g)) {
			if (!AMBIENT.test(m[1]) && KEY_ENV.test(m[1])) found.add(m[1]);
		}
	}
	return [...found];
}

// 전용 설정의 요구는 requiredEnv 가 정의된 뒤에 채운다. 위에서 부르면
// 초기화 전 접근이 된다.
for (const name of readdirSync(CONF_DIR).filter((f) => /^wdio\.conf\..+\.ts$/.test(f))) {
	confEnv.set(name, requiredEnv(readFileSync(join(CONF_DIR, name), "utf8")));
}

const helperEnv = new Map();
for (const name of readdirSync(HELPER_DIR).filter((f) => f.endsWith(".ts"))) {
	const source = readFileSync(join(HELPER_DIR, name), "utf8");
	helperEnv.set(name.replace(/\.ts$/, ""), requiredEnv(source));
}

/**
 * 헬퍼·스펙이 `fetch`/`request` 로 부르는 주소.
 *
 * 자기 서버는 포트를 변수로 만든다(`http://127.0.0.1:${port}/health`). 값이
 * 실행할 때 정해지는 주소는 여기서 보지 않는다. 반대로 값이 고정돼 있으면 그것은
 * 밖에 있는 것이다 — 바깥 인터넷 호스트면 자격증명이, 고정 포트의 로컬 서비스면
 * 그 기계의 서비스가 있어야 돈다. 둘 다 결정론 칸은 아니다.
 *
 * ── 11회차에 고친 것 ──────────────────────────────────────────────
 * 열 번째까지 이 판정은 `fetch(` 바로 뒤에 따옴표가 오는 자리만 봤다. 그래서
 * 주소를 변수에 한 번 담기만 하면(`const url = "https://…"; fetch(url)`) 바깥
 * 모델에 닿는 스펙이 결정론 칸에 남았다 — 자격증명 없는 기계가 맡았다가
 * 실패하는, 이미 세 번 겪은 그 오분류다.
 *
 * 이제 인자를 `staticStringsIn` 으로 푼다. 같은 파일 const, 조건식의 모든 갈래,
 * 템플릿의 고정 조각, import 로 건너간 const 는 물론, **값이 담겨 흘러가는
 * 자리**(호출·`new` 의 인자, 객체 속성값, 배열 요소)까지 따라가 후보를 전부
 * 보고, **하나라도** 바깥 호스트면 대화 자국으로 센다. 값을 한 겹 숨기거나
 * `new Request("…")` 로 감싸는 것으로는 빠져나가지 못한다(15회차 지적 9).
 *
 * ── 12회차에 고친 것 ──────────────────────────────────────────────
 * 열한 번째까지 "이 호출이 fetch 인가" 는 **적힌 이름**이었다. 식별자 글자나
 * 속성 이름이 `"fetch"`/`"request"` 인지만 봤고, 그래서 `const ghostGet = fetch;
 * ghostGet("https://…")` 의 이름은 `ghostGet` 이라 바깥 주소가 없는 것으로
 * 읽혔다(12회차 지적 6). 주소 인자를 변수에 담는 것은 10·11회차가 닫았는데,
 * **fetch 자신을 변수에 담는 것**은 열려 있었다.
 *
 * 이제 호출부는 `scripts/lib/bindings.mjs` 가 푼다. 선언이 없는 자유 식별자
 * `fetch`, `globalThis.fetch`/`window.fetch`, 그것으로 만든 const 별명과
 * 구조분해(`const { fetch: f } = globalThis`)가 모두 같은 전역 바인딩으로
 * 돌아온다. `fetch.call(null, "https://…")` 처럼 인자 자리가 밀리면 `argShift`
 * 만큼 옮겨서 주소를 읽고, 자리를 믿을 수 없으면(`.apply`) 못 푼 것으로 센다.
 * 옛 이름 판정은 그대로 남겨 둔다 — `page.request.get(…)` 처럼 바인딩으로는
 * 풀리지 않지만 이름으로는 드러나는 자리가 있고, 둘 중 하나라도 걸리면 본다.
 *
 * 무엇을 보증하지 않는가: 정적으로 값을 못 정하는 인자다. 함수 매개변수로
 * 받은 주소(`async function hit(url) { await fetch(url); }`), 실행할 때 조립되는
 * 템플릿, 객체·배열을 거쳐 흘러간 주소는 후보가 없다. 그런 자리는 "바깥 주소가
 * 없다" 가 아니라 **모른다** 이고, 이 목록은 그것을 결정론 칸으로 남긴다.
 * 못 푼 인자 수는 생성할 때 표준 출력에 함께 적는다.
 *
 * 호출부 쪽 보증 밖도 같다 — 동적 속성 이름(`obj[name]("…")`),
 * `eval`/`new Function`/`Reflect.apply`/`Function.prototype` 을 두 겹 이상 거친
 * 호출, 고차 함수가 돌려준 함수(`const get = make(); get("…")`), 배열·객체·`Map`
 * 을 거쳐 흘러간 함수, 동적 `import()`/`require()` 로 받아 온 것, 실행할 때
 * 조립되는 문자열. 이 경계 안쪽 형태는 모두 같은 규칙으로 잡히고, 경계 밖은
 * 코드 리뷰의 몫이다.
 */
function outboundAddresses(file) {
	const sf = addressEnv.sourceFile(file);
	const external = [];
	const loopback = [];
	let unresolved = 0;
	if (!sf) return { external, loopback, unresolved };
	const take = (value) => {
		const m = /^https?:\/\/([^/?#\s]*)/.exec(value);
		if (!m) return;
		const authority = m[1];
		if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(authority)) return;
		if (/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(authority)) loopback.push(authority);
		else external.push(authority);
	};
	const visit = (node) => {
		if (ts.isCallExpression(node) && node.arguments.length > 0) {
			// 호출부는 바인딩으로 읽는다. 이름은 그 답의 일부가 아니다.
			const binding = resolveCallee(node, sf, addressEnv);
			const global = binding?.global ?? null;
			const callee = node.expression;
			// 옛 이름 판정. 바인딩으로 풀리지 않는 자리(`page.request.get`)를 위해
			// 남긴다 — 둘 중 하나라도 fetch/request 면 본다.
			const name = ts.isIdentifier(callee)
				? callee.text
				: ts.isPropertyAccessExpression(callee)
					? callee.name.text
					: null;
			const outbound =
				global === "fetch" ||
				global === "request" ||
				name === "fetch" ||
				name === "request";
			if (outbound) {
				// 자리를 믿을 수 없으면(`fetch.apply(null, args)`) 주소를 "없다" 가
				// 아니라 **모른다** 로 센다.
				if (binding?.argsUnknown) unresolved += 1;
				else {
					const at = binding?.argShift ?? 0;
					const arg = node.arguments[at];
					if (!arg) unresolved += 1;
					else {
						// 값이 아니라 **그 안 어딘가에 적힌 주소**를 찾는다.
						// `fetch(new Request("https://…"))` 의 값은 Request 객체이지만
						// 닿는 곳은 생성자에 적힌 그 주소다(15회차 지적 9).
						const resolved = staticStringsIn(arg, sf, addressEnv);
						if (resolved.values.size === 0 && !resolved.complete) unresolved += 1;
						for (const value of resolved.values) take(value);
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return { external, loopback, unresolved };
}

const rows = [];
// 정적으로 값을 못 정한 `fetch`/`request` 인자 수. 보증 밖이라는 사실을 세어 둔다.
let unresolvedArguments = 0;
for (const name of readdirSync(SPEC_DIR).filter((f) => f.endsWith(".spec.ts")).sort()) {
	const source = readFileSync(join(SPEC_DIR, name), "utf8");
	const direct = requiredEnv(source);
	// import 는 확장자를 붙여 쓴다(NodeNext). 빼고 잡으면 하나도 못 만난다.
	const viaHelpers = [...source.matchAll(/from\s+"\.\.\/helpers\/([a-z-]+)(?:\.js)?"/g)]
		.flatMap((m) => helperEnv.get(m[1]) ?? []);
	// 이 스펙을 맡는 전용 설정의 요구도 함께 센다.
	const fromConf = (confOwners.get(name) ?? []).flatMap(
		(conf) => confEnv.get(conf) ?? [],
	);
	const envs = [...new Set([...direct, ...viaHelpers, ...fromConf])].sort();
	const device = envs.some((e) => DEVICE_ENV.test(e));
	// 대화 헬퍼를 부르면 모델이 필요하다 — 환경 변수에 드러나지 않아도.
	// 헬퍼를 거치지 않고 스펙이 직접 모델을 부르는 자리도 있다. 헬퍼 이름만
	// 보면 그 부류가 통째로 결정론 칸에 남는다.
	const outbound = outboundAddresses(join(SPEC_DIR, name));
	unresolvedArguments += outbound.unresolved;
	const talks =
		CHAT_HELPERS.test(source) ||
		TALKS_TO_MODEL.test(source) ||
		outbound.external.length > 0;
	// 장치도 환경 변수로 드러나지 않는다. 마이크를 여는 스펙은 오디오 장치와
	// 그것을 먹이는 도구를 요구하는데, 그 사실이 env 목록에는 없다 — 실제로
	// 마이크 스펙 하나가 결정론 칸에 있다가 장치 없는 기계에서 실패했다.
	// 고정 포트의 로컬 서비스도 그 기계에 그것이 떠 있어야 돈다.
	const usesDevice = DEVICE_TOOLS.test(source) || outbound.loopback.length > 0;
	const keyed = envs.some((e) => KEY_ENV.test(e));
	const requires = requiresCapabilities(source);
	const platforms = declaredPlatforms(name, source);
	rows.push({
		spec: name,
		conf: confOwners.get(name) ?? [],
		env: envs,
		// 아직 이어지지 않은 능력. 스펙이 스스로 선언한다.
		...(requires.length > 0 ? { requires } : {}),
		// 그 운영체제에서만 도는 스펙. 스펙이 스스로 선언한다.
		...(platforms ? { platforms } : {}),
		tier: device || usesDevice
			? "native_local"
			: keyed || talks
				? "credentialed_live"
				: "deterministic_ci",
	});
}

/**
 * 스펙이 선언한 **아직 이어지지 않은 능력**.
 *
 * 형식: `// requires: capability:<이름> (<추적처>)`
 *
 * 왜 필요한가: 어떤 스펙은 제품이 틀려서가 아니라 그 능력이 아직 배선되지
 * 않아서 실패한다(예: `skill_cron` — naia-agent#128). 지우면 배선되는 날 아무도
 * 되살리지 않고, 그대로 두면 매 실행마다 사람이 제품 결함이 아닌 것을
 * 들여다본다. 그래서 요구 환경과 같은 방식으로 다룬다 — 실행에서 빼되 기록과
 * 화면에는 이유와 추적처를 남긴다.
 *
 * 주석에서 읽는 이유: 스펙 파일에 메타를 둘 다른 자리가 없고, 배선되는 날
 * 지워야 할 것이 한 줄이어야 하기 때문이다.
 */
function requiresCapabilities(source) {
	const out = [];
	const pattern =
		/^[ \t]*\/\/[ \t]*requires:[ \t]*capability:([A-Za-z0-9_-]+)[ \t]*\(([^)]+)\)/gm;
	let match = pattern.exec(source);
	while (match) {
		out.push({ capability: match[1], tracker: match[2].trim() });
		match = pattern.exec(source);
	}
	return out;
}

/**
 * 스펙이 선언한 **도는 운영체제**.
 *
 * 형식: `// platforms: linux` 또는 `// platforms: linux, darwin`
 *
 * 왜 필요한가: PipeWire 가상 마이크나 리눅스 음성 프로필을 쓰는 스펙은 윈도우에서
 * 돌 수 없다. 그 사실이 목록에 없으면 윈도우 배포의 회귀가 그 스펙을 요구하고,
 * 윈도우 기계가 맡아 "환경 없음" 으로 붉힌다 — 결함이 아니라 운영체제 차이다.
 * 적힌 운영체제 밖의 배포는 이 스펙을 조건으로 삼지 않는다
 * (`scripts/lib/release-target.mjs`).
 */
function declaredPlatforms(name, source) {
	const match = /^[ \t]*\/\/[ \t]*platforms:[ \t]*([A-Za-z, \t]+)$/m.exec(source);
	if (!match) return null;
	const list = match[1]
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const unknown = list.filter((os) => !KNOWN_OS.includes(os));
	if (unknown.length || list.length === 0) {
		console.error(
			`[e2e-inventory] ${name}: 알 수 없는 platforms 선언 "${match[1].trim()}" (쓸 수 있는 것: ${KNOWN_OS.join(", ")})`,
		);
		process.exit(2);
	}
	return [...new Set(list)].sort();
}

const summary = rows.reduce((acc, row) => {
	acc[row.tier] = (acc[row.tier] ?? 0) + 1;
	return acc;
}, {});

const rendered = `${JSON.stringify({ generatedFrom: SPEC_DIR, total: rows.length, summary, specs: rows }, null, "\t")}\n`;
const OUT = "docs/e2e-inventory.json";

// --check 는 CI 몫이다. 스펙이 늘거나 요구 조건이 바뀌었는데 목록이 그대로면,
// 그 목록을 보고 기계를 나누는 사람이 없는 스펙을 나누게 된다.
if (process.argv.includes("--check")) {
	let current = "";
	try {
		current = readFileSync(OUT, "utf8");
	} catch {
		console.error(`[e2e-inventory] ❌ ${OUT} 이 없다 — node scripts/build-e2e-inventory.mjs 로 만들어라`);
		process.exit(1);
	}
	if (current !== rendered) {
		console.error(`[e2e-inventory] ❌ ${OUT} 이 지금 스펙과 어긋난다 — 다시 생성해 커밋하라`);
		process.exit(1);
	}
	console.log(`[e2e-inventory] ✓ ${OUT} 이 지금 스펙과 일치한다 (${rows.length}개)`);
	process.exit(0);
}

writeFileSync(OUT, rendered);

console.log(`[e2e-inventory] 스펙 ${rows.length}개 → docs/e2e-inventory.json`);
for (const [tier, count] of Object.entries(summary).sort()) console.log(`  ${tier.padEnd(7)} ${count}`);
// 값을 정적으로 못 정한 인자는 "바깥 주소가 없다" 가 아니라 모른다다. 그 수가
// 늘면 이 목록이 보증하지 않는 자리가 늘었다는 뜻이다.
console.log(`  값을 못 푼 fetch/request 인자 ${unresolvedArguments}개 (보증 밖)`);
const owned = rows.filter((r) => r.conf.length).length;
console.log(`  전용 wdio 설정이 맡는 것 ${owned} / 메인 harness 만 맡는 것 ${rows.length - owned}`);
