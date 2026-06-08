#!/usr/bin/env node
/**
 * 문서 상호링크 상대경로 헬퍼 — "상호링크는 상대경로" 원칙을 쉽게 지키게 한다.
 * 두 문서 간 상대경로(또는 마크다운 링크)를 생성한다. 절대경로를 손으로 쓰지 않게 하는 도구.
 *
 * 사용: node scripts/doc-link.mjs <from-doc> <to-doc> [링크텍스트]
 *   예) node scripts/doc-link.mjs docs/lessons.md docs/glossary.md "용어집"
 *       → [용어집](./glossary.md)
 * ESM.
 */
import path from "path";

export function relativeLink(fromDoc, toDoc) {
	const fromDir = path.dirname(path.resolve(fromDoc));
	let rel = path.relative(fromDir, path.resolve(toDoc)).replace(/\\/g, "/");
	if (!rel.startsWith(".")) rel = "./" + rel;
	return rel;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("doc-link.mjs");
if (isMain) {
	const [, , from, to, text] = process.argv;
	if (!from || !to) {
		console.error("usage: node scripts/doc-link.mjs <from-doc> <to-doc> [link-text]");
		process.exit(1);
	}
	const rel = relativeLink(from, to);
	console.log(text ? `[${text}](${rel})` : rel);
}
