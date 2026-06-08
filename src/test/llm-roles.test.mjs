#!/usr/bin/env node
/** LLM-roles — 어댑터를 **실제 실행**으로 검증 (grep 연극 아님):
 *  (1) sanity 게이트(validateTranslation)가 거부/빈출력/왜곡을 throw 하는가 — 미러 조용한 오염 방지
 *  (2) translateViaLightCLI 가 CLI 별 args/input 분기 + r.error(ENOENT)/비정상종료 구분
 *  (3) 결정론 함수(mapToUsers/translateNeeded) 정확
 *  (LLM 실호출은 비결정·비용 → mock spawnFn 주입. 어댑터 분기·게이트 로직 자체를 돌린다.) */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import {
	mapToUsers, translateNeeded, validateTranslation, translateViaLightCLI,
} from "../../scripts/mirror-translate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = readFileSync(resolve(ROOT, "scripts/mirror-translate.mjs"), "utf8");

let pass = 0, fail = 0;
function check(name, cond) { console.log(`${cond ? "✅ PASS" : "❌ FAIL"} — ${name}`); cond ? pass++ : fail++; }
function throws(fn) { try { fn(); return false; } catch { return true; } }

// ── 1) 무거운 모델/엔드포인트 하드코딩 부재 (회귀 가드 — 싼 grep, 1줄씩만 유지) ───────────
check("무거운 모델(gemini-3.5-flash) 하드코딩 없음", !/gemini-3\.5-flash/.test(SRC));
check("Vertex aiplatform / gcloud 직타 없음", !/aiplatform\.googleapis\.com/.test(SRC) && !/gcloud /.test(SRC));

// ── 2) sanity 게이트 — 조용한 오염 방지 (런타임) ──────────────────────────────────────
const SRC_LONG = "x".repeat(300);  // 원문 (길이 기준 통과용)
check("정상 번역 → 통과(트림 반환)", validateTranslation("  잘 번역된 충분히 긴 한국어 본문 " + "내용 ".repeat(50) + " ", SRC_LONG).startsWith("잘 번역"));
check("빈 출력 → throw", throws(() => validateTranslation("   ", SRC_LONG)));
check("과소 출력(절단/거부) → throw", throws(() => validateTranslation("짧음", SRC_LONG)));
check("영어 거부('I can't ...') → throw", throws(() => validateTranslation("I can't help with that request. " + "x".repeat(100), SRC_LONG)));
check("'as an AI' 거부 → throw", throws(() => validateTranslation("As an AI language model, I cannot " + "y".repeat(100), SRC_LONG)));
check("한국어 거부('죄송...') → throw", throws(() => validateTranslation("죄송합니다. 해당 요청은 처리할 수 없습니다 " + "z".repeat(100), SRC_LONG)));
check("'해당 모델' 오류 → throw", throws(() => validateTranslation("해당 모델은 지원되지 않습니다 " + "w".repeat(100), SRC_LONG)));
{ // 코드블록 대폭 손실 → throw (src 6펜스 → out 0)
	const srcCode = "```js\na\n```\n```py\nb\n```\n```sh\nc\n```\n" + "설명 ".repeat(40);
	check("코드블록 대폭 손실 → throw", throws(() => validateTranslation("코드 다 날린 평문 " + "k".repeat(200), srcCode)));
	check("코드블록 보존 → 통과", validateTranslation("```js\na\n```\n```py\nb\n```\n```sh\nc\n``` 설명 " + "m".repeat(200), srcCode).includes("```"));
}

// ── 3) translateViaLightCLI — CLI 분기 + 오류 구분 (mock spawnFn) ─────────────────────
const okOut = "충분히 긴 정상 한국어 번역 결과물 " + "내용 ".repeat(60);
function mockOK(received) { return (cmd, args, opts) => { received.cmd = cmd; received.args = args; received.input = opts.input; return { status: 0, stdout: okOut, stderr: "" }; }; }

{ const rcv = {}; const env = process.env.MIRROR_LLM_CLI; const m = process.env.MIRROR_SUB_MODEL;
  delete process.env.MIRROR_LLM_CLI; delete process.env.MIRROR_SUB_MODEL;
  const out = translateViaLightCLI("원문내용", mockOK(rcv));
  check("claude(기본) — cmd=claude, --model haiku, prompt=stdin", rcv.cmd === "claude" && rcv.args.includes("--model") && rcv.args.includes("haiku") && typeof rcv.input === "string" && rcv.input.includes("원문내용"));
  check("claude 정상 출력 → 번역 반환", out.startsWith("충분히 긴"));
  if (env !== undefined) process.env.MIRROR_LLM_CLI = env; if (m !== undefined) process.env.MIRROR_SUB_MODEL = m;
}
{ const rcv = {}; const prev = process.env.MIRROR_LLM_CLI; process.env.MIRROR_LLM_CLI = "gemini"; delete process.env.MIRROR_SUB_MODEL;
  translateViaLightCLI("원문", mockOK(rcv));
  check("gemini — -m gemini-3.1-flash-lite, input 빈문자(stdin 미사용)", rcv.args.includes("-m") && rcv.args.includes("gemini-3.1-flash-lite") && rcv.input === "");
  prev === undefined ? delete process.env.MIRROR_LLM_CLI : (process.env.MIRROR_LLM_CLI = prev);
}
{ const rcv = {}; const prev = process.env.MIRROR_LLM_CLI; process.env.MIRROR_LLM_CLI = "codex";
  translateViaLightCLI("원문", mockOK(rcv));
  check("codex — exec 서브커맨드 + input 빈문자", rcv.args[0] === "exec" && rcv.input === "");
  prev === undefined ? delete process.env.MIRROR_LLM_CLI : (process.env.MIRROR_LLM_CLI = prev);
}
{ const prev = process.env.MIRROR_LLM_CLI; process.env.MIRROR_LLM_CLI = "ollama";
  check("미지원 CLI → throw", throws(() => translateViaLightCLI("x", mockOK({}))));
  prev === undefined ? delete process.env.MIRROR_LLM_CLI : (process.env.MIRROR_LLM_CLI = prev);
}

// 오류 구분: ENOENT(실행불가) vs 비정상종료 vs status0+거부(조용한 오염)
{ const prev = process.env.MIRROR_LLM_CLI; delete process.env.MIRROR_LLM_CLI;
  const enoent = () => ({ error: { code: "ENOENT", message: "spawn claude ENOENT" }, status: null, stdout: "" });
  check("CLI 부재(ENOENT) → '실행 불가' throw (status null 구분)", throws(() => translateViaLightCLI("x", enoent)));
  const fail1 = () => ({ status: 1, stdout: "", stderr: "boom" });
  check("비정상 종료(status 1) → throw", throws(() => translateViaLightCLI("x", fail1)));
  // ★ 핵심: status 0 인데 거부 텍스트 → 어댑터가 '성공' 오판 않고 throw (미러 오염 차단)
  const refuse = () => ({ status: 0, stdout: "I can't translate this content. " + "x".repeat(100), stderr: "" });
  check("★ status 0 + 거부텍스트 → throw (조용한 오염 차단)", throws(() => translateViaLightCLI("원문", refuse)));
  prev === undefined ? delete process.env.MIRROR_LLM_CLI : (process.env.MIRROR_LLM_CLI = prev);
}

// ── 4) 결정론 함수 (LLM 무) — 경로 매핑 + stale 판정 ─────────────────────────────────
check(".agents/context/x.yaml → .users/context/x.md", mapToUsers(".agents/context/x.yaml") === ".users/context/x.md");
check(".agents/context/agents-rules.json → .users/context/agents-rules.md", mapToUsers(".agents/context/agents-rules.json") === ".users/context/agents-rules.md");
check("비-.agents 경로 → null", mapToUsers("docs/x.md") === null);
function setup(files) {
	const d = mkdtempSync(join(tmpdir(), "llmroles-"));
	for (const [p, c] of Object.entries(files)) { const fp = join(d, p); mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, c); }
	return d;
}
{ const d = setup({ ".agents/context/x.yaml": "A: 1" }); check("미러 없음 → 번역 필요", translateNeeded(".agents/context/x.yaml", d).needed === true); }
{ const d = setup({ ".agents/context/x.yaml": "A: 1", ".users/context/x.md": "<!-- src-sha: deadbeef -->\n옛" }); check("해시 불일치(stale) → 번역 필요", translateNeeded(".agents/context/x.yaml", d).needed === true); }

console.log(`\n${fail === 0 ? "✅" : "❌"} llm-roles.test: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
