import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MAX_CARD_FILE_BYTES,
	MAX_CARD_JSON_CHARS,
	MAX_LOREBOOK_ENTRIES,
	parseCharacterCardBytes,
	parseCharacterCardJsonText,
} from "../card-parser";

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function makeChunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.byteLength);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.byteLength, false);
	for (let i = 0; i < 4; i++) {
		out[4 + i] = type.charCodeAt(i);
	}
	out.set(data, 8);
	// CRC is not verified by the reader, set to 0
	view.setUint32(8 + data.byteLength, 0, false);
	return out;
}

function makeTextChunk(keyword: string, textValue: string): Uint8Array {
	const kw = new TextEncoder().encode(keyword);
	const val = new TextEncoder().encode(textValue);
	const data = new Uint8Array(kw.byteLength + 1 + val.byteLength);
	data.set(kw, 0);
	data[kw.byteLength] = 0;
	data.set(val, kw.byteLength + 1);
	return makeChunk("tEXt", data);
}

function makeITXtChunk(
	keyword: string,
	textValue: string,
	compressed = false,
): Uint8Array {
	const kw = new TextEncoder().encode(keyword);
	const val = new TextEncoder().encode(textValue);
	// keyword + 0x00 + compressionFlag + compressionMethod + lang(empty) + 0x00 + transKw(empty) + 0x00 + text
	const data = new Uint8Array(kw.byteLength + 5 + val.byteLength);
	data.set(kw, 0);
	data[kw.byteLength] = 0;
	data[kw.byteLength + 1] = compressed ? 1 : 0;
	data[kw.byteLength + 2] = 0;
	data[kw.byteLength + 3] = 0;
	data[kw.byteLength + 4] = 0;
	data.set(val, kw.byteLength + 5);
	return makeChunk("iTXt", data);
}

function concatBytes(arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((acc, a) => acc + a.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const a of arrays) {
		out.set(a, offset);
		offset += a.byteLength;
	}
	return out;
}

function buildPngWithChunks(chunks: Uint8Array[]): Uint8Array {
	const ihdr = makeChunk("IHDR", new Uint8Array(13));
	const iend = makeChunk("IEND", new Uint8Array(0));
	return concatBytes([PNG_SIG, ihdr, ...chunks, iend]);
}

function toBase64Utf8(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

describe("card-parser", () => {
	it("parses V2 PNG card with tEXt chara chunk", () => {
		const v2Obj = {
			spec: "chara_card_v2",
			spec_version: "2.0",
			data: {
				name: "아리아",
				description: "바람의 음유시인",
				personality: "자유분방함",
				scenario: "광장 분수대 앞",
				first_mes: "안녕, {{user}}!",
				alternate_greetings: ["반가워요!"],
				mes_example: "<START>\n{{user}}: 노래해줘\n{{char}}: 좋아!",
				creator: "Nextain",
				creator_notes: "메모",
				tags: ["음유시인", "판타지"],
			},
		};
		const png = buildPngWithChunks([
			makeTextChunk("chara", toBase64Utf8(v2Obj)),
		]);
		const res = parseCharacterCardBytes(png, "aria.png");
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.card.specVersion).toBe("v2");
		expect(res.card.sourceFormat).toBe("png");
		expect(res.card.chunkKeyword).toBe("chara");
		expect(res.card.name).toBe("아리아");
		expect(res.card.description).toBe("바람의 음유시인");
		expect(res.card.alternate_greetings).toEqual(["반가워요!"]);
		expect(res.card.tags).toEqual(["음유시인", "판타지"]);
	});

	it("parses V3 PNG card with tEXt ccv3 chunk and preserves unknown fields", () => {
		const v3Obj = {
			spec: "chara_card_v3",
			spec_version: "3.0",
			data: {
				name: "세라핀",
				description: "별자리 관측사",
				first_mes: "별이 밝네요.",
				assets: [{ type: "icon", uri: "ccdefault:", name: "main", ext: "png" }],
			},
			custom_root_field: "keep_me",
		};
		const png = buildPngWithChunks([
			makeTextChunk("ccv3", toBase64Utf8(v3Obj)),
		]);
		const res = parseCharacterCardBytes(png, "seraphine.png");
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.card.specVersion).toBe("v3");
		expect(res.card.chunkKeyword).toBe("ccv3");
		expect(res.card.name).toBe("세라핀");
		expect(res.card.rawJson.custom_root_field).toBe("keep_me");
	});

	it("prioritizes ccv3 over chara when both chunks exist in PNG", () => {
		const v2Obj = {
			spec: "chara_card_v2",
			spec_version: "2.0",
			data: { name: "구버전이름", first_mes: "V2 인사" },
		};
		const v3Obj = {
			spec: "chara_card_v3",
			spec_version: "3.0",
			data: { name: "신버전이름", first_mes: "V3 인사" },
		};
		const png = buildPngWithChunks([
			makeTextChunk("chara", toBase64Utf8(v2Obj)),
			makeTextChunk("ccv3", toBase64Utf8(v3Obj)),
		]);
		const res = parseCharacterCardBytes(png, "dual.png");
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.card.specVersion).toBe("v3");
		expect(res.card.chunkKeyword).toBe("ccv3");
		expect(res.card.name).toBe("신버전이름");
		expect(res.card.first_mes).toBe("V3 인사");
	});

	it("parses uncompressed iTXt chunk in PNG", () => {
		const v3Obj = {
			spec: "chara_card_v3",
			spec_version: "3.0",
			data: { name: "아이텍스트캐릭터", description: "iTXt 테스트" },
		};
		const png = buildPngWithChunks([
			makeITXtChunk("ccv3", toBase64Utf8(v3Obj), false),
		]);
		const res = parseCharacterCardBytes(png, "itxt.png");
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.card.name).toBe("아이텍스트캐릭터");
		expect(res.card.description).toBe("iTXt 테스트");
	});

	it("parses JSON V3, V2, and flat V1 formats", () => {
		const v3 = parseCharacterCardJsonText(
			JSON.stringify({
				spec: "chara_card_v3",
				data: { name: "V3캐릭터", description: "설명3" },
			}),
		);
		expect(v3.ok).toBe(true);
		if (v3.ok) expect(v3.card.specVersion).toBe("v3");

		const v2 = parseCharacterCardJsonText(
			JSON.stringify({
				spec: "chara_card_v2",
				data: { name: "V2캐릭터", description: "설명2" },
			}),
		);
		expect(v2.ok).toBe(true);
		if (v2.ok) expect(v2.card.specVersion).toBe("v2");

		const v1 = parseCharacterCardJsonText(
			JSON.stringify({
				name: "V1평면캐릭터",
				description: "평면 설명",
				first_mes: "첫 마디",
			}),
		);
		expect(v1.ok).toBe(true);
		if (v1.ok) {
			expect(v1.card.specVersion).toBe("v1");
			expect(v1.card.name).toBe("V1평면캐릭터");
			expect(v1.card.first_mes).toBe("첫 마디");
		}
	});

	it("rejects invalid inputs with distinct error codes (8+ rejection cases)", () => {
		// 1. Not PNG or JSON
		const notPngOrJson = parseCharacterCardBytes(
			new TextEncoder().encode("plain text file content"),
			"readme.txt",
		);
		expect(notPngOrJson).toEqual({
			ok: false,
			code: "NOT_PNG_OR_JSON",
		});

		// 2. PNG without card chunk
		const emptyPng = buildPngWithChunks([]);
		const noChunk = parseCharacterCardBytes(emptyPng, "normal-photo.png");
		expect(noChunk).toEqual({
			ok: false,
			code: "PNG_NO_CARD_CHUNK",
		});

		// 3. PNG with out-of-bounds chunk length
		const badChunk = new Uint8Array(20);
		badChunk.set(PNG_SIG, 0);
		const view = new DataView(badChunk.buffer);
		view.setUint32(8, 999999, false); // length points outside file
		const corruptPng = parseCharacterCardBytes(badChunk, "corrupt.png");
		expect(corruptPng.ok).toBe(false);
		if (!corruptPng.ok) expect(corruptPng.code).toBe("PNG_CORRUPT_CHUNK");

		// 4. Corrupted Base64 in PNG chunk
		const badB64Png = buildPngWithChunks([
			makeTextChunk("chara", "!!!not_base64!!!"),
		]);
		const badB64 = parseCharacterCardBytes(badB64Png, "bad-b64.png");
		expect(badB64).toEqual({
			ok: false,
			code: "INVALID_BASE64",
		});

		// 5. Malformed JSON in PNG chunk
		const brokenJsonB64 = Buffer.from("{broken_json:", "utf8").toString(
			"base64",
		);
		const badJsonPng = buildPngWithChunks([
			makeTextChunk("chara", brokenJsonB64),
		]);
		const badJson = parseCharacterCardBytes(badJsonPng, "bad-json.png");
		expect(badJson.ok).toBe(false);
		if (!badJson.ok) expect(badJson.code).toBe("INVALID_JSON");

		// 6. Unknown spec
		const unknownSpec = parseCharacterCardJsonText(
			JSON.stringify({ spec: "chara_card_v99", data: { name: "미래" } }),
		);
		expect(unknownSpec.ok).toBe(false);
		if (!unknownSpec.ok) expect(unknownSpec.code).toBe("UNKNOWN_SPEC");

		// 7. Missing name or missing V2/V3 data envelope
		const missingName = parseCharacterCardJsonText(
			JSON.stringify({ spec: "chara_card_v2", data: { name: "   " } }),
		);
		expect(missingName).toEqual({
			ok: false,
			code: "MISSING_NAME",
		});

		const topLevelOnlyV2 = parseCharacterCardJsonText(
			JSON.stringify({ spec: "chara_card_v2", name: "최상위만있는V2" }),
		);
		expect(topLevelOnlyV2.ok).toBe(false);
		if (!topLevelOnlyV2.ok) expect(topLevelOnlyV2.code).toBe("INVALID_JSON");

		const topLevelOnlyV3 = parseCharacterCardJsonText(
			JSON.stringify({
				spec: "chara_card_v3",
				spec_version: "3.0",
				name: "최상위만있는V3",
			}),
		);
		expect(topLevelOnlyV3.ok).toBe(false);
		if (!topLevelOnlyV3.ok) expect(topLevelOnlyV3.code).toBe("INVALID_JSON");

		// 7b. Invalid spec_version for V2 / V3
		const badV2Version = parseCharacterCardJsonText(
			JSON.stringify({
				spec: "chara_card_v2",
				spec_version: "1.0",
				data: { name: "버전불일치V2" },
			}),
		);
		expect(badV2Version.ok).toBe(false);
		if (!badV2Version.ok)
			expect(badV2Version.code).toBe("INVALID_SPEC_VERSION");

		const badV3Version = parseCharacterCardJsonText(
			JSON.stringify({
				spec: "chara_card_v3",
				spec_version: "2.0",
				data: { name: "버전불일치V3" },
			}),
		);
		expect(badV3Version.ok).toBe(false);
		if (!badV3Version.ok)
			expect(badV3Version.code).toBe("INVALID_SPEC_VERSION");

		// 7c. PNG without IEND chunk (exact byte boundary)
		const ihdrOnly = concatBytes([
			PNG_SIG,
			makeChunk("IHDR", new Uint8Array(13)),
			makeTextChunk(
				"chara",
				toBase64Utf8({ spec: "chara_card_v2", data: { name: "IEND없음" } }),
			),
		]);
		const noIendRes = parseCharacterCardBytes(ihdrOnly, "no-iend.png");
		expect(noIendRes.ok).toBe(false);
		if (!noIendRes.ok) expect(noIendRes.code).toBe("PNG_CORRUPT_CHUNK");

		// 7d. Corrupted ccv3 chunk must NOT fall back to valid chara chunk
		const validCharaChunk = makeTextChunk(
			"chara",
			toBase64Utf8({ spec: "chara_card_v2", data: { name: "하위호환" } }),
		);
		const brokenCcv3Base64Png = buildPngWithChunks([
			validCharaChunk,
			makeTextChunk("ccv3", "%%%invalid_base64%%%"),
		]);
		const brokenCcv3B64Res = parseCharacterCardBytes(
			brokenCcv3Base64Png,
			"broken-ccv3-b64.png",
		);
		expect(brokenCcv3B64Res).toEqual({
			ok: false,
			code: "INVALID_BASE64",
		});

		const brokenCcv3JsonPng = buildPngWithChunks([
			validCharaChunk,
			makeTextChunk("ccv3", Buffer.from("{broken", "utf8").toString("base64")),
		]);
		const brokenCcv3JsonRes = parseCharacterCardBytes(
			brokenCcv3JsonPng,
			"broken-ccv3-json.png",
		);
		expect(brokenCcv3JsonRes.ok).toBe(false);
		if (!brokenCcv3JsonRes.ok)
			expect(brokenCcv3JsonRes.code).toBe("INVALID_JSON");

		const badUtf8ItxtData = new Uint8Array([
			0x63, 0x63, 0x76, 0x33, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfe,
		]);
		const brokenCcv3Utf8Png = buildPngWithChunks([
			validCharaChunk,
			makeChunk("iTXt", badUtf8ItxtData),
		]);
		const brokenCcv3Utf8Res = parseCharacterCardBytes(
			brokenCcv3Utf8Png,
			"broken-ccv3-utf8.png",
		);
		expect(brokenCcv3Utf8Res.ok).toBe(false);
		if (!brokenCcv3Utf8Res.ok)
			expect(brokenCcv3Utf8Res.code).toBe("INVALID_BASE64");

		// 8. CHARX (.charx extension or ZIP magic bytes)
		const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
		const charxByExt = parseCharacterCardBytes(
			new Uint8Array([1, 2, 3]),
			"hero.charx",
		);
		expect(charxByExt).toEqual({
			ok: false,
			code: "CHARX_NOT_SUPPORTED",
		});
		const charxByMagic = parseCharacterCardBytes(zipBytes, "hero.png");
		expect(charxByMagic).toEqual({
			ok: false,
			code: "CHARX_NOT_SUPPORTED",
		});

		// 9. Size limits (file bytes, JSON chars, lorebook entries)
		const hugeFile = new Uint8Array(MAX_CARD_FILE_BYTES + 1);
		expect(parseCharacterCardBytes(hugeFile, "huge.png")).toEqual({
			ok: false,
			code: "FILE_TOO_LARGE",
		});

		const hugeJson = "x".repeat(MAX_CARD_JSON_CHARS + 10);
		expect(parseCharacterCardJsonText(hugeJson)).toEqual({
			ok: false,
			code: "JSON_TOO_LARGE",
		});

		const tooManyEntries = Array.from(
			{ length: MAX_LOREBOOK_ENTRIES + 1 },
			(_, i) => ({
				id: i,
				keys: [`k${i}`],
				content: "c",
			}),
		);
		const manyLoreRes = parseCharacterCardJsonText(
			JSON.stringify({
				spec: "chara_card_v3",
				data: {
					name: "로어북과다",
					character_book: { entries: tooManyEntries },
				},
			}),
		);
		expect(manyLoreRes).toEqual({
			ok: false,
			code: "TOO_MANY_LOREBOOK_ENTRIES",
		});
	});

	it("parses all bundled sample files in package-public/samples", () => {
		const samplesDir = resolve(__dirname, "../package-public/samples");
		const v2Bytes = new Uint8Array(
			readFileSync(resolve(samplesDir, "starlight-archivist-v2.json")),
		);
		const v2Res = parseCharacterCardBytes(
			v2Bytes,
			"starlight-archivist-v2.json",
		);
		expect(v2Res.ok).toBe(true);
		if (v2Res.ok) {
			expect(v2Res.card.specVersion).toBe("v2");
			expect(v2Res.card.name).toBe("서윤하");
		}

		const v3Bytes = new Uint8Array(
			readFileSync(resolve(samplesDir, "clockwork-tinker-v3.json")),
		);
		const v3Res = parseCharacterCardBytes(v3Bytes, "clockwork-tinker-v3.json");
		expect(v3Res.ok).toBe(true);
		if (v3Res.ok) {
			expect(v3Res.card.specVersion).toBe("v3");
			expect(v3Res.card.name).toBe("한도윤");
			expect(v3Res.card.character_book.entries.length).toBeGreaterThanOrEqual(
				2,
			);
		}

		const pngBytes = new Uint8Array(
			readFileSync(resolve(samplesDir, "greenhouse-keeper.png")),
		);
		const pngRes = parseCharacterCardBytes(pngBytes, "greenhouse-keeper.png");
		expect(pngRes.ok).toBe(true);
		if (pngRes.ok) {
			expect(pngRes.card.sourceFormat).toBe("png");
			expect(pngRes.card.specVersion).toBe("v3");
			expect(pngRes.card.name).toBe("온새미");
			expect(pngRes.card.character_book.entries.length).toBeGreaterThanOrEqual(
				1,
			);
		}

		const tinkerPngBytes = new Uint8Array(
			readFileSync(resolve(samplesDir, "clockwork-tinker.png")),
		);
		const tinkerPngRes = parseCharacterCardBytes(
			tinkerPngBytes,
			"clockwork-tinker.png",
		);
		expect(tinkerPngRes.ok).toBe(true);
		if (tinkerPngRes.ok) {
			expect(tinkerPngRes.card.sourceFormat).toBe("png");
			expect(tinkerPngRes.card.specVersion).toBe("v3");
			expect(tinkerPngRes.card.name).toBe("한도윤");
			expect(
				tinkerPngRes.card.character_book.entries.length,
			).toBeGreaterThanOrEqual(2);
		}
	});
});
