import { Logger } from "../../lib/logger";
import { parseCharacterCardJsonText } from "./card-parser";
import type { StoredCardRecord } from "./card-store";
import {
	CHARCARD_SAMPLE_CLOCKWORK_TINKER_V3,
	CHARCARD_SAMPLE_GREENHOUSE_KEEPER_V3,
	CHARCARD_SAMPLE_STARLIGHT_ARCHIVIST_V2,
} from "./locales/messages";

const TAG = "CharCardSampleCards";

function createLanternPreviewSvgBlob(): Blob {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fde68a"/>
      <stop offset="60%" stop-color="#34d399"/>
      <stop offset="100%" stop-color="#115e59"/>
    </radialGradient>
  </defs>
  <rect width="160" height="160" rx="24" fill="url(#glow)"/>
  <circle cx="80" cy="76" r="28" fill="#fef3c7" opacity="0.9"/>
  <path d="M56 122c10-18 38-18 48 0" stroke="#ecfdf5" stroke-width="8" stroke-linecap="round" fill="none"/>
</svg>`;
	return new Blob([svg], { type: "image/svg+xml" });
}

export function getBundledSampleCardRecords(): StoredCardRecord[] {
	Logger.debug(TAG, "building bundled sample character cards");
	const entries: Array<{
		id: string;
		fileName: string;
		importedAt: number;
		raw: unknown;
		sourceFormat: "json" | "png";
		chunkKeyword?: "ccv3" | "chara";
		imageBlob: Blob | null;
	}> = [
		{
			id: "sample:greenhouse-keeper-png",
			fileName: "greenhouse-keeper.png",
			importedAt: 3,
			raw: CHARCARD_SAMPLE_GREENHOUSE_KEEPER_V3,
			sourceFormat: "png",
			chunkKeyword: "ccv3",
			imageBlob: createLanternPreviewSvgBlob(),
		},
		{
			id: "sample:clockwork-tinker-v3",
			fileName: "clockwork-tinker-v3.json",
			importedAt: 2,
			raw: CHARCARD_SAMPLE_CLOCKWORK_TINKER_V3,
			sourceFormat: "json",
			imageBlob: null,
		},
		{
			id: "sample:starlight-archivist-v2",
			fileName: "starlight-archivist-v2.json",
			importedAt: 1,
			raw: CHARCARD_SAMPLE_STARLIGHT_ARCHIVIST_V2,
			sourceFormat: "json",
			imageBlob: null,
		},
	];

	const out: StoredCardRecord[] = [];
	for (const item of entries) {
		const parsed = parseCharacterCardJsonText(
			JSON.stringify(item.raw),
			item.sourceFormat,
			item.chunkKeyword,
		);
		if (parsed.ok) {
			out.push({
				id: item.id,
				fileName: item.fileName,
				importedAt: item.importedAt,
				card: parsed.card,
				rawJson: parsed.card.rawJson,
				imageBlob: item.imageBlob,
				builtIn: true,
			});
		}
	}
	return out;
}
