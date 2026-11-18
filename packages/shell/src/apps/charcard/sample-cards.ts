import { Logger } from "../../lib/logger";
import {
	parseCharacterCardJsonText,
	parsePngOrJsonCardBytes,
} from "./card-parser";
import type { StoredCardRecord } from "./card-store";
import clockworkTinkerV3Json from "./package-public/samples/clockwork-tinker-v3.json";
import clockworkTinkerPngInline from "./package-public/samples/clockwork-tinker.png?inline";
import greenhouseKeeperPngInline from "./package-public/samples/greenhouse-keeper.png?inline";
import starlightArchivistV2 from "./package-public/samples/starlight-archivist-v2.json";

const TAG = "CharCardSampleCards";

export function decodeDataUrlBytes(dataUrl: string): Uint8Array {
	const commaIdx = dataUrl.indexOf(",");
	const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
	const binary = atob(base64.trim());
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export function getBundledSampleCardRecords(): StoredCardRecord[] {
	Logger.debug(TAG, "building bundled sample character cards");
	const pngSamples: Array<{
		id: string;
		fileName: string;
		importedAt: number;
		inlineDataUrl: string;
	}> = [
		{
			id: "sample:greenhouse-keeper-png",
			fileName: "greenhouse-keeper.png",
			importedAt: 4,
			inlineDataUrl: greenhouseKeeperPngInline,
		},
		{
			id: "sample:clockwork-tinker-v3",
			fileName: "clockwork-tinker.png",
			importedAt: 3,
			inlineDataUrl: clockworkTinkerPngInline,
		},
	];

	const out: StoredCardRecord[] = [];
	for (const sample of pngSamples) {
		const pngBytes = decodeDataUrlBytes(sample.inlineDataUrl);
		const parsed = parsePngOrJsonCardBytes(pngBytes, sample.fileName);
		if (parsed.ok) {
			out.push({
				id: sample.id,
				fileName: sample.fileName,
				importedAt: sample.importedAt,
				card: parsed.card,
				rawJson: parsed.card.rawJson,
				imageBlob: parsed.imageOmitted
					? null
					: new Blob([new Uint8Array(pngBytes)], { type: "image/png" }),
				imageOmitted: parsed.imageOmitted,
				builtIn: true,
			});
		} else {
			Logger.warn(TAG, "failed to parse bundled sample PNG card", {
				fileName: sample.fileName,
				code: parsed.code,
				detail: parsed.detail,
			});
		}
	}

	const v3JsonSampleParsed = parseCharacterCardJsonText(
		JSON.stringify(clockworkTinkerV3Json),
		"json",
	);
	if (v3JsonSampleParsed.ok) {
		out.push({
			id: "sample:clockwork-tinker-json-v3",
			fileName: "clockwork-tinker-v3.json",
			importedAt: 2,
			card: v3JsonSampleParsed.card,
			rawJson: v3JsonSampleParsed.card.rawJson,
			imageBlob: null,
			builtIn: true,
		});
	}

	const jsonSampleParsed = parseCharacterCardJsonText(
		JSON.stringify(starlightArchivistV2),
		"json",
	);
	if (jsonSampleParsed.ok) {
		out.push({
			id: "sample:starlight-archivist-v2",
			fileName: "starlight-archivist-v2.json",
			importedAt: 1,
			card: jsonSampleParsed.card,
			rawJson: jsonSampleParsed.card.rawJson,
			imageBlob: null,
			builtIn: true,
		});
	}

	return out;
}
