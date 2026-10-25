import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	MAX_CARD_FILE_BYTES,
	MAX_CARD_JSON_CHARS,
	MAX_LOREBOOK_ENTRIES,
	computeCrc32,
	parseCharacterCardBytes,
	parseCharacterCardJsonText,
} from "../card-parser";
import { getBundledSampleCardRecords } from "../sample-cards";

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function makeChunk(
	type: string,
	data: Uint8Array,
	corruptCrc = false,
): Uint8Array {
	const out = new Uint8Array(12 + data.byteLength);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.byteLength, false);
	for (let i = 0; i < 4; i++) {
		out[4 + i] = type.charCodeAt(i);
	}
	out.set(data, 8);
	const crc = computeCrc32(out.subarray(4, 8 + data.byteLength));
	view.setUint32(
		8 + data.byteLength,
		corruptCrc ? (crc ^ 0xffffffff) >>> 0 : crc,
		false,
	);
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

interface ZipTestEntry {
	name: string;
	data: Uint8Array;
	method?: 0 | 8 | number;
	flags?: number;
	declaredUncompressedSize?: number;
	declaredCompressedSize?: number;
}

function buildZipArchive(entries: ZipTestEntry[]): Uint8Array {
	const localChunks: Uint8Array[] = [];
	const cdChunks: Uint8Array[] = [];
	let localOffset = 0;

	for (const entry of entries) {
		const nameBytes = new TextEncoder().encode(entry.name);
		const method = entry.method ?? 0;
		const flags = entry.flags ?? 0;
		const rawData = entry.data;
		const compressedData =
			method === 8 ? new Uint8Array(deflateRawSync(rawData)) : rawData;
		const crc = computeCrc32(rawData);
		const compSize = entry.declaredCompressedSize ?? compressedData.byteLength;
		const uncompSize = entry.declaredUncompressedSize ?? rawData.byteLength;

		// Local file header (30 bytes + name)
		const lfh = new Uint8Array(30 + nameBytes.byteLength);
		const lfhView = new DataView(lfh.buffer);
		lfhView.setUint32(0, 0x04034b50, true);
		lfhView.setUint16(4, 20, true);
		lfhView.setUint16(6, flags, true);
		lfhView.setUint16(8, method, true);
		lfhView.setUint16(10, 0, true);
		lfhView.setUint16(12, 0, true);
		lfhView.setUint32(14, crc, true);
		lfhView.setUint32(18, compSize, true);
		lfhView.setUint32(22, uncompSize, true);
		lfhView.setUint16(26, nameBytes.byteLength, true);
		lfhView.setUint16(28, 0, true);
		lfh.set(nameBytes, 30);

		localChunks.push(lfh, compressedData);

		// Central directory header (46 bytes + name)
		const cdh = new Uint8Array(46 + nameBytes.byteLength);
		const cdhView = new DataView(cdh.buffer);
		cdhView.setUint32(0, 0x02014b50, true);
		cdhView.setUint16(4, 20, true);
		cdhView.setUint16(6, 20, true);
		cdhView.setUint16(8, flags, true);
		cdhView.setUint16(10, method, true);
		cdhView.setUint16(12, 0, true);
		cdhView.setUint16(14, 0, true);
		cdhView.setUint32(16, crc, true);
		cdhView.setUint32(20, compSize, true);
		cdhView.setUint32(24, uncompSize, true);
		cdhView.setUint16(28, nameBytes.byteLength, true);
		cdhView.setUint16(30, 0, true);
		cdhView.setUint16(32, 0, true);
		cdhView.setUint16(34, 0, true);
		cdhView.setUint16(36, 0, true);
		cdhView.setUint32(38, 0, true);
		cdhView.setUint32(42, localOffset, true);
		cdh.set(nameBytes, 46);

		cdChunks.push(cdh);
		localOffset += lfh.byteLength + compressedData.byteLength;
	}

	const cdData = concatBytes(cdChunks);
	const eocd = new Uint8Array(22);
	const eocdView = new DataView(eocd.buffer);
	eocdView.setUint32(0, 0x06054b50, true);
	eocdView.setUint16(4, 0, true);
	eocdView.setUint16(6, 0, true);
	eocdView.setUint16(8, entries.length, true);
	eocdView.setUint16(10, entries.length, true);
	eocdView.setUint32(12, cdData.byteLength, true);
	eocdView.setUint32(16, localOffset, true);
	eocdView.setUint16(20, 0, true);

	return concatBytes([...localChunks, cdData, eocd]);
}

describe("card-parser", () => {
	it("parses V2 PNG card with tEXt chara chunk", async () => {
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
		const res = await parseCharacterCardBytes(png, "aria.png");
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

	it("parses V3 PNG card with tEXt ccv3 chunk and preserves unknown fields", async () => {
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
		const res = await parseCharacterCardBytes(png, "seraphine.png");
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.card.specVersion).toBe("v3");
		expect(res.card.chunkKeyword).toBe("ccv3");
		expect(res.card.name).toBe("세라핀");
		expect(res.card.rawJson.custom_root_field).toBe("keep_me");
	});

	it("prioritizes ccv3 over chara when both chunks exist in PNG", async () => {
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
		const res = await parseCharacterCardBytes(png, "dual.png");
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.card.specVersion).toBe("v3");
		expect(res.card.chunkKeyword).toBe("ccv3");
		expect(res.card.name).toBe("신버전이름");
		expect(res.card.first_mes).toBe("V3 인사");
	});

	it("parses uncompressed iTXt chunk in PNG", async () => {
		const v3Obj = {
			spec: "chara_card_v3",
			spec_version: "3.0",
			data: { name: "아이텍스트캐릭터", description: "iTXt 테스트" },
		};
		const png = buildPngWithChunks([
			makeITXtChunk("ccv3", toBase64Utf8(v3Obj), false),
		]);
		const res = await parseCharacterCardBytes(png, "itxt.png");
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

	it("parses CHARX (.charx) archives (method 0 stored, method 8 deflate, embedded icon, ignores unsafe paths & external URLs)", async () => {
		const cardJsonObj = {
			spec: "chara_card_v3",
			spec_version: "3.0",
			data: {
				name: "차르엑스수호자",
				description: "CHARX 압축 아카이브 캐릭터",
				first_mes: "반가워요, {{user}}!",
				assets: [
					{
						type: "icon",
						uri: "https://evil.example.com/icon.png",
						name: "remote",
						ext: "png",
					},
					{
						type: "icon",
						uri: "embeded://assets/icon/images/portrait.png",
						name: "main",
						ext: "png",
					},
				],
			},
		};
		const cardBytes = new TextEncoder().encode(JSON.stringify(cardJsonObj));
		const fakePngIcon = buildPngWithChunks([]);

		// 1) Method 0 (stored) without icon -> ok, imageBytes is undefined
		const zipStored = buildZipArchive([
			{ name: "card.json", data: cardBytes, method: 0 },
		]);
		const resStored = await parseCharacterCardBytes(
			zipStored,
			"guardian-stored.charx",
		);
		expect(resStored.ok).toBe(true);
		if (resStored.ok) {
			expect(resStored.card.sourceFormat).toBe("charx");
			expect(resStored.card.specVersion).toBe("v3");
			expect(resStored.card.name).toBe("차르엑스수호자");
			expect(resStored.imageBytes).toBeUndefined();
		}

		// 2) Method 8 (deflate) with embedded icon & ignored `..` traversal entry
		const zipDeflated = buildZipArchive([
			{
				name: "../outside/card.json",
				data: new TextEncoder().encode('{"bad":true}'),
				method: 8,
			},
			{ name: "card.json", data: cardBytes, method: 8 },
			{
				name: "assets/icon/images/portrait.png",
				data: fakePngIcon,
				method: 8,
			},
		]);
		const resDeflated = await parseCharacterCardBytes(
			zipDeflated,
			"guardian-deflated.charx",
		);
		expect(resDeflated.ok).toBe(true);
		if (resDeflated.ok) {
			expect(resDeflated.card.sourceFormat).toBe("charx");
			expect(resDeflated.card.name).toBe("차르엑스수호자");
			expect(resDeflated.imageMimeType).toBe("image/png");
			expect(resDeflated.imageBytes).toEqual(fakePngIcon);
		}
	});

	it("rejects invalid CHARX archives (missing card.json, corrupt zip, path traversal only, decompression bomb, zip64, encrypted, unsupported env)", async () => {
		// Missing card.json
		const noCardZip = buildZipArchive([
			{
				name: "readme.txt",
				data: new TextEncoder().encode("hello"),
				method: 0,
			},
		]);
		expect(await parseCharacterCardBytes(noCardZip, "no-card.charx")).toEqual({
			ok: false,
			code: "CHARX_MISSING_CARD_JSON",
		});

		// Only `..` path entry for card.json -> ignored -> missing card.json
		const traversalZip = buildZipArchive([
			{
				name: "../card.json",
				data: new TextEncoder().encode(
					JSON.stringify({ spec: "chara_card_v3", data: { name: "탈출" } }),
				),
				method: 0,
			},
		]);
		expect(
			await parseCharacterCardBytes(traversalZip, "traversal.charx"),
		).toEqual({
			ok: false,
			code: "CHARX_MISSING_CARD_JSON",
		});

		// Corrupt zip bytes
		expect(
			await parseCharacterCardBytes(
				new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]),
				"broken.charx",
			),
		).toMatchObject({
			ok: false,
			code: "CHARX_CORRUPT_ZIP",
		});

		// Decompression bomb: declared uncompressed size (10 bytes) < actual decompressed size (500 bytes)
		const realPayload = new TextEncoder().encode(
			JSON.stringify({
				spec: "chara_card_v3",
				spec_version: "3.0",
				data: { name: "폭탄", description: "아".repeat(300) },
			}),
		);
		const bombZip = buildZipArchive([
			{
				name: "card.json",
				data: realPayload,
				method: 8,
				declaredUncompressedSize: 10,
			},
		]);
		expect(await parseCharacterCardBytes(bombZip, "bomb.charx")).toMatchObject({
			ok: false,
			code: "CHARX_DECOMPRESSION_BOMB",
		});

		// Encrypted entry
		const encryptedZip = buildZipArchive([
			{
				name: "card.json",
				data: realPayload,
				method: 0,
				flags: 0x0001,
			},
		]);
		expect(
			await parseCharacterCardBytes(encryptedZip, "encrypted.charx"),
		).toMatchObject({
			ok: false,
			code: "CHARX_ENCRYPTED",
		});

		// ZIP64 sentinel in declared uncompressed size
		const zip64Archive = buildZipArchive([
			{
				name: "card.json",
				data: realPayload,
				method: 0,
				declaredUncompressedSize: 0xffffffff,
			},
		]);
		expect(
			await parseCharacterCardBytes(zip64Archive, "zip64.charx"),
		).toMatchObject({
			ok: false,
			code: "CHARX_ZIP64_NOT_SUPPORTED",
		});

		// Unsupported environment (missing DecompressionStream)
		const origDS = globalThis.DecompressionStream;
		try {
			// @ts-expect-error testing missing DecompressionStream
			globalThis.DecompressionStream = undefined;
			const deflateZip = buildZipArchive([
				{ name: "card.json", data: realPayload, method: 8 },
			]);
			expect(
				await parseCharacterCardBytes(deflateZip, "no-ds.charx"),
			).toMatchObject({
				ok: false,
				code: "CHARX_UNSUPPORTED_ENV",
			});
		} finally {
			globalThis.DecompressionStream = origDS;
		}
	});

	it("rejects invalid inputs with distinct error codes (PNG CRC mismatch, spec_version: null, and 8+ rejection cases)", async () => {
		// 1. Not PNG or JSON
		const notPngOrJson = await parseCharacterCardBytes(
			new TextEncoder().encode("plain text file content"),
			"readme.txt",
		);
		expect(notPngOrJson).toEqual({
			ok: false,
			code: "NOT_PNG_OR_JSON",
		});

		// 2. PNG without card chunk
		const emptyPng = buildPngWithChunks([]);
		const noChunk = await parseCharacterCardBytes(emptyPng, "normal-photo.png");
		expect(noChunk).toEqual({
			ok: false,
			code: "PNG_NO_CARD_CHUNK",
		});

		// 3. PNG with out-of-bounds chunk length or corrupted CRC32
		const badChunk = new Uint8Array(20);
		badChunk.set(PNG_SIG, 0);
		const view = new DataView(badChunk.buffer);
		view.setUint32(8, 999999, false); // length points outside file
		const corruptPng = await parseCharacterCardBytes(badChunk, "corrupt.png");
		expect(corruptPng.ok).toBe(false);
		if (!corruptPng.ok) expect(corruptPng.code).toBe("PNG_CORRUPT_CHUNK");

		const badCrcPng = concatBytes([
			PNG_SIG,
			makeChunk("IHDR", new Uint8Array(13), true),
			makeChunk("IEND", new Uint8Array(0)),
		]);
		const badCrcRes = await parseCharacterCardBytes(badCrcPng, "bad-crc.png");
		expect(badCrcRes).toMatchObject({
			ok: false,
			code: "PNG_CORRUPT_CHUNK",
		});

		// 4. Corrupted Base64 in PNG chunk
		const badB64Png = buildPngWithChunks([
			makeTextChunk("chara", "!!!not_base64!!!"),
		]);
		const badB64 = await parseCharacterCardBytes(badB64Png, "bad-b64.png");
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
		const badJson = await parseCharacterCardBytes(badJsonPng, "bad-json.png");
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

		// 7b. Invalid spec_version for V2 / V3 (including null and non-string)
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

		const nullV3Version = parseCharacterCardJsonText(
			JSON.stringify({
				spec: "chara_card_v3",
				spec_version: null,
				data: { name: "널버전V3" },
			}),
		);
		expect(nullV3Version).toMatchObject({
			ok: false,
			code: "INVALID_SPEC_VERSION",
		});

		const numericV2Version = parseCharacterCardJsonText(
			JSON.stringify({
				spec: "chara_card_v2",
				spec_version: 2,
				data: { name: "숫자버전V2" },
			}),
		);
		expect(numericV2Version).toMatchObject({
			ok: false,
			code: "INVALID_SPEC_VERSION",
		});

		// 7c. PNG without IEND chunk (exact byte boundary)
		const ihdrOnly = concatBytes([
			PNG_SIG,
			makeChunk("IHDR", new Uint8Array(13)),
			makeTextChunk(
				"chara",
				toBase64Utf8({ spec: "chara_card_v2", data: { name: "IEND없음" } }),
			),
		]);
		const noIendRes = await parseCharacterCardBytes(ihdrOnly, "no-iend.png");
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
		const brokenCcv3B64Res = await parseCharacterCardBytes(
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
		const brokenCcv3JsonRes = await parseCharacterCardBytes(
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
		const brokenCcv3Utf8Res = await parseCharacterCardBytes(
			brokenCcv3Utf8Png,
			"broken-ccv3-utf8.png",
		);
		expect(brokenCcv3Utf8Res.ok).toBe(false);
		if (!brokenCcv3Utf8Res.ok)
			expect(brokenCcv3Utf8Res.code).toBe("INVALID_BASE64");

		// 9. Size limits (file bytes, JSON chars, lorebook entries)
		const hugeFile = new Uint8Array(MAX_CARD_FILE_BYTES + 1);
		expect(await parseCharacterCardBytes(hugeFile, "huge.png")).toEqual({
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

	it("parses all 4 bundled sample files (including PNG CRC32 check) and returns 4 distinct sample cards", async () => {
		const samplesDir = resolve(__dirname, "../package-public/samples");
		const v2Bytes = new Uint8Array(
			readFileSync(resolve(samplesDir, "starlight-archivist-v2.json")),
		);
		const v2Res = await parseCharacterCardBytes(
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
		const v3Res = await parseCharacterCardBytes(
			v3Bytes,
			"clockwork-tinker-v3.json",
		);
		expect(v3Res.ok).toBe(true);
		if (v3Res.ok) {
			expect(v3Res.card.specVersion).toBe("v3");
			expect(v3Res.card.name).toBe("백하진");
			expect(v3Res.card.character_book.entries.length).toBeGreaterThanOrEqual(
				2,
			);
		}

		const pngBytes = new Uint8Array(
			readFileSync(resolve(samplesDir, "greenhouse-keeper.png")),
		);
		const pngRes = await parseCharacterCardBytes(
			pngBytes,
			"greenhouse-keeper.png",
		);
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
		const tinkerPngRes = await parseCharacterCardBytes(
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

		const records = getBundledSampleCardRecords();
		expect(records.map((r) => r.card.name)).toEqual([
			"온새미",
			"한도윤",
			"백하진",
			"서윤하",
		]);
	});
});
