import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	NARRATIONS,
	type NarrationLang,
	TTS_VOICES,
} from "./demo-narrations-i18n";
import { DEMO_SCENES } from "./demo-script";

/**
 * Naia OS Demo — TTS Narration Generator (multilingual)
 *
 * Uses Google Cloud TTS REST API to generate MP3 narration for each scene.
 * Requires gcloud CLI authenticated with a service account that has TTS access.
 *
 * Run:
 *   cd shell && npx tsx e2e/demo-tts.ts              # Korean (default)
 *   cd shell && npx tsx e2e/demo-tts.ts --lang en     # English
 *   cd shell && npx tsx e2e/demo-tts.ts --lang ja     # Japanese
 *
 * Output:
 *   shell/e2e/demo-output/tts/ko/01-intro.mp3   (default)
 *   shell/e2e/demo-output/tts/en/01-intro.mp3   (--lang en)
 */

function parseLang(): NarrationLang {
	const idx = process.argv.indexOf("--lang");
	if (idx !== -1 && process.argv[idx + 1]) {
		const lang = process.argv[idx + 1] as NarrationLang;
		if (!(lang in NARRATIONS)) {
			console.error(`[demo-tts] Unknown language: ${lang}`);
			console.error(`  Supported: ${Object.keys(NARRATIONS).join(", ")}`);
			process.exit(1);
		}
		return lang;
	}
	return "ko";
}

const LANG = parseLang();
const OUTPUT_DIR = path.resolve(import.meta.dirname, `demo-output/tts/${LANG}`);
const TTS_SPEAKING_RATE = 0.95;

interface TtsRequest {
	input: { text: string };
	voice: { languageCode: string; name: string };
	audioConfig: {
		audioEncoding: string;
		speakingRate: number;
		pitch: number;
	};
}

const GCP_PROJECT = "project-a8b18af5-b980-43e7-8ec";

async function getAccessToken(): Promise<string> {
	const gcloudPath = "/home/luke/google-cloud-sdk/bin/gcloud";
	const token = execSync(
		`${gcloudPath} auth print-access-token --project=${GCP_PROJECT}`,
		{ encoding: "utf-8" },
	).trim();
	return token;
}

async function synthesizeSpeech(
	text: string,
	outputPath: string,
	accessToken: string,
): Promise<void> {
	const voice = TTS_VOICES[LANG];
	const request: TtsRequest = {
		input: { text },
		voice: {
			languageCode: voice.languageCode,
			name: voice.voiceName,
		},
		audioConfig: {
			audioEncoding: "MP3",
			speakingRate: TTS_SPEAKING_RATE,
			pitch: 0,
		},
	};

	const response = await fetch(
		"https://texttospeech.googleapis.com/v1/text:synthesize",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"x-goog-user-project": GCP_PROJECT,
			},
			body: JSON.stringify(request),
		},
	);

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`TTS API error (${response.status}): ${errorText}`);
	}

	const data = (await response.json()) as { audioContent: string };
	const audioBuffer = Buffer.from(data.audioContent, "base64");
	fs.writeFileSync(outputPath, audioBuffer);
}

async function main() {
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });

	const narrations = NARRATIONS[LANG];
	const voice = TTS_VOICES[LANG];

	console.log(`[demo-tts] Language: ${LANG}`);
	console.log("[demo-tts] Getting access token...");
	const accessToken = await getAccessToken();

	console.log(`[demo-tts] Generating ${DEMO_SCENES.length} narration files...`);
	console.log(
		`[demo-tts] Voice: ${voice.voiceName}, Rate: ${TTS_SPEAKING_RATE}`,
	);
	console.log(`[demo-tts] Output: ${OUTPUT_DIR}\n`);

	for (let i = 0; i < DEMO_SCENES.length; i++) {
		const scene = DEMO_SCENES[i];
		const filename = `${String(i + 1).padStart(2, "0")}-${scene.id}.mp3`;
		const outputPath = path.join(OUTPUT_DIR, filename);

		const text = narrations[scene.id];
		if (!text) {
			console.log(
				`[${i + 1}/${DEMO_SCENES.length}] SKIP (no narration for ${scene.id})`,
			);
			continue;
		}

		if (fs.existsSync(outputPath)) {
			console.log(
				`[${i + 1}/${DEMO_SCENES.length}] SKIP (exists): ${filename}`,
			);
			continue;
		}

		console.log(`[${i + 1}/${DEMO_SCENES.length}] Generating: ${filename}`);
		console.log(`  "${text}"`);

		let retries = 3;
		while (retries > 0) {
			try {
				await synthesizeSpeech(text, outputPath, accessToken);
				break;
			} catch (err) {
				retries--;
				if (retries === 0) throw err;
				console.log(`  Retrying in 3s... (${retries} left)`);
				await new Promise((r) => setTimeout(r, 3000));
			}
		}

		// Rate limit: ~300 req/min, add small delay
		await new Promise((r) => setTimeout(r, 500));
	}

	console.log(
		`\n[demo-tts] Done! ${DEMO_SCENES.length} files in ${OUTPUT_DIR}`,
	);

	// Print timing summary
	console.log("\n[demo-tts] Scene timing summary:");
	let totalSec = 0;
	for (const scene of DEMO_SCENES) {
		console.log(`  ${scene.id.padEnd(20)} ${scene.duration}s`);
		totalSec += scene.duration;
	}
	console.log(
		`  ${"TOTAL".padEnd(20)} ${totalSec}s (${(totalSec / 60).toFixed(1)}min)`,
	);
}

main().catch((err) => {
	console.error("[demo-tts] Error:", err);
	process.exit(1);
});
