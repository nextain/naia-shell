// 시연판 회사 소개 덱의 비공개 장(그림·낭독 원고) 준비.
// 비공개 장의 그림과 원고는 git 에 넣지 않는다(.gitignore). 저장소에는
// src/lib/kiosk-demo/slides/ir-deck-private.manifest.json 이 쪽 번호·파일 이름·
// sha256·바이트 수만 고정한다. 빌드 전에 이 대본이 파일이 있고 값이 맞는지 확인하고,
// 없으면 NAIA_WEB_KIOSK_PRIVATE_SLIDES_SOURCE(절대 경로 디렉터리)에서 가져온다.
// 원본 배치는 <source>/<그림 파일 이름>, <source>/<원고 파일 이름> 이다.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRIVATE_SLIDES_SOURCE_ENV = "NAIA_WEB_KIOSK_PRIVATE_SLIDES_SOURCE";

const IMAGE_NAME = /^[0-9a-f]{16}\.jpg$/;
const SCRIPT_NAME = /^[0-9a-z][0-9a-z.-]*\.json$/;
const SHA256 = /^[0-9a-f]{64}$/;

const shellDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const slidesDir = path.join(shellDir, "src/lib/kiosk-demo/slides");

export const DEFAULT_PRIVATE_SLIDES_PATHS = {
	manifestPath: path.join(slidesDir, "ir-deck-private.manifest.json"),
	imageDir: path.join(shellDir, "public/kiosk-slides/private"),
	scriptFile: path.join(slidesDir, "ir-deck-private.generated.json"),
};

function validRecord(record) {
	return (
		SHA256.test(record?.sha256 ?? "") &&
		Number.isInteger(record?.bytes) &&
		record.bytes > 0
	);
}

export function readPrivateSlidesManifest(manifestPath) {
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	const slides = manifest?.slides;
	const script = manifest?.script;
	if (
		!Array.isArray(slides) ||
		!validRecord(script) ||
		!SCRIPT_NAME.test(script.file ?? "") ||
		slides.some(
			(slide) =>
				!validRecord(slide) ||
				!Number.isInteger(slide.page) ||
				slide.page < 1 ||
				!IMAGE_NAME.test(slide.image ?? ""),
		) ||
		new Set(slides.map((slide) => slide.page)).size !== slides.length ||
		new Set(slides.map((slide) => slide.image)).size !== slides.length
	) {
		throw new Error(`비공개 장 기록이 올바르지 않습니다: ${manifestPath}`);
	}
	return { script, slides };
}

function fileMatches(record, file) {
	if (!fs.existsSync(file)) return false;
	if (fs.statSync(file).size !== record.bytes) return false;
	const digest = createHash("sha256")
		.update(fs.readFileSync(file))
		.digest("hex");
	return digest === record.sha256;
}

function fetchFile(record, name, file, source) {
	const partial = `${file}.partial`;
	try {
		if (!path.isAbsolute(source)) {
			throw new Error(`${PRIVATE_SLIDES_SOURCE_ENV} 는 절대 경로여야 합니다`);
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.copyFileSync(path.join(source, name), partial);
		if (!fileMatches(record, partial)) {
			throw new Error("받은 파일의 sha256·크기가 기록과 다릅니다");
		}
		fs.renameSync(partial, file);
	} catch (error) {
		fs.rmSync(partial, { force: true });
		throw new Error(`비공개 장 파일을 가져오지 못했습니다 (${name})`, {
			cause: error,
		});
	}
}

function assertScriptFollowsManifest(deck, manifest, scriptFile) {
	const slides = deck?.slides;
	const follows =
		Array.isArray(slides) &&
		slides.length === manifest.slides.length &&
		slides.every((slide, index) => {
			const record = manifest.slides[index];
			return (
				slide?.page === record.page &&
				slide.image === record.image &&
				typeof slide.title === "string" &&
				slide.title.trim() !== "" &&
				typeof slide.script === "string" &&
				slide.script.trim() !== ""
			);
		});
	if (!follows) {
		throw new Error(
			`비공개 장 원고의 쪽 번호·그림 이름이 기록과 다릅니다: ${scriptFile}`,
		);
	}
}

/** 비공개 장의 그림과 원고가 기록과 같은지 확인하고, 다르거나 없으면 원천에서 가져온다. */
export function ensureWebKioskPrivateSlides(options = {}) {
	const { manifestPath, imageDir, scriptFile } = {
		...DEFAULT_PRIVATE_SLIDES_PATHS,
		...options,
	};
	const source = options.source ?? "";
	const log = options.log ?? (() => {});
	const manifest = readPrivateSlidesManifest(manifestPath);
	const wanted = [
		...manifest.slides.map((slide) => ({
			record: slide,
			name: slide.image,
			file: path.join(imageDir, slide.image),
		})),
		{ record: manifest.script, name: manifest.script.file, file: scriptFile },
	];
	for (const { record, name, file } of wanted) {
		if (fileMatches(record, file)) {
			log(`[web-kiosk-private-slides] 확인 ${name}`);
			continue;
		}
		if (!source) {
			throw new Error(
				`비공개 장 파일이 없거나 기록과 다릅니다: ${name}. ${PRIVATE_SLIDES_SOURCE_ENV} 에 비공개 장 디렉터리 절대 경로를 주십시오.`,
			);
		}
		log(`[web-kiosk-private-slides] 가져오기 ${name}`);
		fetchFile(record, name, file, source);
	}
	const deck = JSON.parse(fs.readFileSync(scriptFile, "utf8"));
	assertScriptFollowsManifest(deck, manifest, scriptFile);
	return { slides: deck.slides };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	ensureWebKioskPrivateSlides({
		source: process.env[PRIVATE_SLIDES_SOURCE_ENV],
		log: (line) => console.log(line),
	});
}
