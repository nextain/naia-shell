// 웹판 NVA 말하기 아틀라스(speech/atlas.bin) 준비.
// atlas.bin 은 묶음당 60~150MB 라 git 에 넣지 않는다(.gitignore). 각 묶음의
// speech/generation-result.json 이 sha256·바이트 수를 고정하므로, 빌드 전에
// 이 대본이 파일이 있고 값이 맞는지 확인하고, 없으면 NAIA_WEB_NVA_ATLAS_SOURCE
// (스튜디오 묶음 디렉터리 절대 경로 또는 http(s) 기준 주소)에서 가져온다.
// 원본 배치는 <source>/<묶음>/speech/atlas.bin 이다.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ATLAS_ROLE = "speech_atlas";

export function listWebNvaAtlases(nvaDir) {
	if (!fs.existsSync(nvaDir)) return [];
	const atlases = [];
	for (const bundle of fs.readdirSync(nvaDir).sort()) {
		const resultPath = path.join(
			nvaDir,
			bundle,
			"speech",
			"generation-result.json",
		);
		if (!fs.existsSync(resultPath)) continue;
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
		const asset = result.assets?.find((a) => a.role === ATLAS_ROLE);
		if (!asset) continue;
		if (
			typeof asset.path !== "string" ||
			path.isAbsolute(asset.path) ||
			asset.path.split(/[\\/]/).includes("..") ||
			!/^[0-9a-f]{64}$/.test(asset.sha256 ?? "") ||
			!Number.isInteger(asset.bytes)
		) {
			throw new Error(`NVA 아틀라스 기록이 올바르지 않습니다: ${resultPath}`);
		}
		atlases.push({
			bundle,
			relPath: `${bundle}/${asset.path}`,
			file: path.join(nvaDir, bundle, asset.path),
			sha256: asset.sha256,
			bytes: asset.bytes,
		});
	}
	return atlases;
}

async function sha256File(file) {
	const hash = createHash("sha256");
	await pipeline(fs.createReadStream(file), hash);
	return hash.digest("hex");
}

export async function atlasMatches(atlas, file = atlas.file) {
	if (!fs.existsSync(file)) return false;
	if (fs.statSync(file).size !== atlas.bytes) return false;
	return (await sha256File(file)) === atlas.sha256;
}

async function fetchAtlas(atlas, source) {
	const partial = `${atlas.file}.partial`;
	try {
		if (/^https?:\/\//.test(source)) {
			const url = `${source.replace(/\/+$/, "")}/${atlas.relPath}`;
			const response = await fetch(url);
			if (!response.ok || !response.body) {
				throw new Error(`${url} 응답 ${response.status}`);
			}
			await pipeline(
				Readable.fromWeb(response.body),
				fs.createWriteStream(partial),
			);
		} else {
			if (!path.isAbsolute(source)) {
				throw new Error(
					"NAIA_WEB_NVA_ATLAS_SOURCE 는 절대 경로나 http(s) 주소여야 합니다",
				);
			}
			fs.copyFileSync(path.join(source, atlas.relPath), partial);
		}
		if (!(await atlasMatches(atlas, partial))) {
			throw new Error("받은 파일의 sha256·크기가 기록과 다릅니다");
		}
		fs.renameSync(partial, atlas.file);
	} catch (error) {
		fs.rmSync(partial, { force: true });
		throw new Error(`NVA 아틀라스를 가져오지 못했습니다 (${atlas.relPath})`, {
			cause: error,
		});
	}
}

export async function ensureWebNvaAtlases(options = {}) {
	const nvaDir = options.nvaDir;
	const source = options.source ?? "";
	const log = options.log ?? (() => {});
	const ready = [];
	for (const atlas of listWebNvaAtlases(nvaDir)) {
		if (await atlasMatches(atlas)) {
			log(`[web-nva-atlas] 확인 ${atlas.relPath}`);
		} else {
			if (!source) {
				throw new Error(
					`NVA 아틀라스가 없거나 기록과 다릅니다: ${atlas.relPath}. NAIA_WEB_NVA_ATLAS_SOURCE 에 스튜디오 묶음 디렉터리 절대 경로나 http(s) 기준 주소를 주십시오.`,
				);
			}
			log(`[web-nva-atlas] 가져오기 ${atlas.relPath}`);
			await fetchAtlas(atlas, source);
		}
		ready.push(atlas.relPath);
	}
	return ready;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await ensureWebNvaAtlases({
		nvaDir: path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../public/nva",
		),
		source: process.env.NAIA_WEB_NVA_ATLAS_SOURCE,
		log: (line) => console.log(line),
	});
}
