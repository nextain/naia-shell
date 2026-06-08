#!/usr/bin/env node
/**
 * M13-mirror — `.agents/`(AI SoT) 수정 시 `.users/`(사람용 한국어 markdown)에 **비교 번역 동기화**.
 *
 * 구조: `.agents/<path>` → `.users/<path>.md`로 LLM 번역. 원본 해시를 미러에 박아 **변경 시에만** 번역(중복 호출 방지).
 *   LLM = 현재 CLI 의 sub(라이트) 모델. 단일 CLI 환경(claude/codex/gemini) 가정 — 별도 gateway/Vertex 직타 안 함.
 *     기본: claude 코드 환경이면 `claude -p --model haiku`. env 로 변경:
 *       MIRROR_LLM_CLI=claude|codex|gemini  (기본 claude)
 *       MIRROR_SUB_MODEL=<라이트 모델>       (기본 haiku / gemini=gemini-3.1-flash-lite / codex=계정 모델)
 *     (나중 naia-agent 가 다중 CLI·다중 key 로 셋팅 시 이 어댑터를 그 라우터로 교체.)
 *   트리거 = cron 또는 PostToolUse(async) hook.
 *   번역 지침에 "신조어·불친절한 약자 금지, 평이한 용어, 기술용어 (영문) 병기"를 넣어 M13-term과 정합.
 *
 * 사용:
 *   node scripts/mirror-translate.mjs <.agents 파일> --check   # 번역 필요 여부만 (exit 0=최신, 1=필요), LLM 호출 안 함
 *   node scripts/mirror-translate.mjs <.agents 파일>            # 실제 번역 후 .users 기록
 * ESM.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";

export function mapToUsers(agentsRel) {
	const rel = String(agentsRel).replace(/\\/g, "/");
	if (!rel.startsWith(".agents/")) return null;
	const sub = rel.slice(".agents/".length).replace(/\.(json|ya?ml|md|mdx)$/i, ".md");
	return ".users/" + sub;
}

function sha(s) {
	return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

// 미러에 박힌 원본 해시와 비교해 번역 필요 여부 판정 (결정론)
export function translateNeeded(agentsFile, root) {
	const agentsRel = path.relative(root, path.resolve(root, agentsFile)).replace(/\\/g, "/");
	const usersRel = mapToUsers(agentsRel);
	if (!usersRel) return { needed: false, reason: "non-.agents" };
	let src;
	try {
		src = fs.readFileSync(path.join(root, agentsRel), "utf8");
	} catch {
		return { needed: false, reason: "no-source" };
	}
	const hash = sha(src);
	let dst;
	try {
		dst = fs.readFileSync(path.join(root, usersRel), "utf8");
	} catch {
		return { needed: true, usersRel, hash, reason: "no-mirror" };
	}
	const m = dst.match(/<!--\s*src-sha:\s*(\w+)\s*-->/);
	if (m && m[1] === hash) return { needed: false, usersRel, hash, reason: "up-to-date" };
	return { needed: true, usersRel, hash, reason: "stale" };
}

// 번역 = 작은(라이트) 모델의 기계적 변환 작업. 단일 CLI 어댑터.
// ⚠️ 역할 분담: 작은 모델은 "번역·생성" 같은 단순 변환만. 검증이 잡은 오류의 "수정·판단"은
//    큰 모델(메인)이 직접. (작은 모델에 수정 위임 금지 — 정합성 깨짐.)

// 모델 거부/사과/빈출력 마커 — status 0 으로 와도 "조용한 오염" 막는다 (cross-review 최대 risk).
const REFUSAL_MARKERS = [
	/i can'?t /i, /i cannot /i, /as an ai/i, /i'?m (just |an )?(a |an )?(language )?(ai|model)/i,
	/죄송|할 수 없|도와드릴 수 없|지원되지 않|해당 모델/, /not supported|unable to|invalid_request/i,
];

/** 번역 출력 sanity 검증 — 실패 시 throw (미러에 쓰지 않음). 순수함수 — 테스트 대상. */
export function validateTranslation(out, srcContent) {
	const o = (out || "").trim();
	if (!o) throw new Error("빈 출력 — 번역 실패 (미러 미기록)");
	if (o.length < Math.max(20, srcContent.length * 0.15))
		throw new Error(`출력 과소 (${o.length} < ${Math.floor(srcContent.length * 0.15)}) — 거부/절단 의심`);
	const head = o.slice(0, 400);
	for (const re of REFUSAL_MARKERS)
		if (re.test(head)) throw new Error(`거부/오류 응답 감지 (${re}) — 미러 오염 방지로 중단`);
	// 원문 fenced 코드블록 수 보존 (대폭 손실이면 의심)
	const sc = (srcContent.match(/```/g) || []).length, oc = (o.match(/```/g) || []).length;
	if (sc >= 4 && oc < sc / 2) throw new Error(`코드블록 대폭 손실 (src ${sc} → out ${oc}) — 왜곡 의심`);
	return o;
}

export function translateViaLightCLI(content, spawnFn = spawnSync) {
	const cli = process.env.MIRROR_LLM_CLI || "claude";
	const model = process.env.MIRROR_SUB_MODEL || (cli === "gemini" ? "gemini-3.1-flash-lite" : "haiku");
	const prompt =
		"다음 AI 컨텍스트 파일을 사람이 읽기 쉬운 한국어 마크다운으로 번역·정리하라. " +
		"신조어·불친절한 약자 금지, 평이한 용어, 기술용어는 (영문) 병기, 원문 의미 보존. " +
		"설명·머리말 없이 번역 결과만 출력.\n\n---\n" + content;
	let args, input = prompt;
	if (cli === "claude") args = ["-p", "--model", model];           // prompt via stdin
	else if (cli === "gemini") { args = ["-p", prompt, "-m", model]; input = ""; }
	else if (cli === "codex") { args = ["exec", prompt, "-c", `model=${model}`]; input = ""; }
	else throw new Error(`지원 안 함 MIRROR_LLM_CLI=${cli} (claude|codex|gemini)`);
	const r = spawnFn(cli, args, { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
	if (r.error) {  // ENOENT(CLI 부재) / timeout 등 — status null 케이스 구분
		throw new Error(`${cli} 실행 불가: ${r.error.code || r.error.message} (CLI 설치/PATH 확인)`);
	}
	if (r.status !== 0)
		throw new Error(`${cli} 비정상 종료 (status ${r.status}): ${(r.stderr || "").slice(0, 200)}`);
	return validateTranslation(r.stdout, content);   // 거부/빈출력/왜곡 = throw (미러 미기록)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("mirror-translate.mjs");
if (isMain) {
	const [, , file, flag] = process.argv;
	const root = process.env.MIRROR_PROJECT_ROOT || process.cwd();
	if (!file) {
		console.error("usage: node scripts/mirror-translate.mjs <.agents 파일> [--check]");
		process.exit(2);
	}
	const r = translateNeeded(file, root);
	if (flag === "--check") {
		console.log(`[mirror] ${r.reason}` + (r.usersRel ? ` → ${r.usersRel}` : ""));
		process.exit(r.needed ? 1 : 0);
	}
	if (!r.needed) {
		console.log(`[mirror] 최신(${r.reason}) — 번역 생략`);
		process.exit(0);
	}
	const src = fs.readFileSync(path.join(root, file), "utf8");
	let translated;
	try {
		translated = translateViaLightCLI(src);   // 거부/빈출력/ENOENT 시 throw
	} catch (e) {
		// ⚠️ 실패 시 .users 미러를 건드리지 않는다 — 거부/오염 텍스트가 src-sha 와 함께 굳는 것 차단.
		console.error(`[mirror] 번역 실패 — 미러 미기록: ${e.message}`);
		process.exit(1);
	}
	const out = `<!-- src-sha: ${r.hash} -->\n<!-- 자동 번역 미러 (M13-mirror). 원본: ${path.relative(root, path.resolve(root, file)).replace(/\\/g, "/")} -->\n\n${translated}\n`;
	const dst = path.join(root, r.usersRel);
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.writeFileSync(dst, out);
	console.log(`[mirror] 번역 완료 → ${r.usersRel} (src-sha ${r.hash})`);
	process.exit(0);
}
