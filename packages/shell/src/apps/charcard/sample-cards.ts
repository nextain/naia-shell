import { Logger } from "../../lib/logger";
import {
	parseCharacterCardBytes,
	parseCharacterCardJsonText,
} from "./card-parser";
import type { StoredCardRecord } from "./card-store";
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
			importedAt: 3,
			inlineDataUrl: greenhouseKeeperPngInline,
		},
		{
			id: "sample:clockwork-tinker-v3",
			fileName: "clockwork-tinker.png",
			importedAt: 2,
			inlineDataUrl: clockworkTinkerPngInline,
		},
	];

	const out: StoredCardRecord[] = [];
	for (const sample of pngSamples) {
		const pngBytes = decodeDataUrlBytes(sample.inlineDataUrl);
		const parsed = parseCharacterCardBytes(pngBytes, sample.fileName);
		if (parsed.ok) {
			out.push({
				id: sample.id,
				fileName: sample.fileName,
				importedAt: sample.importedAt,
				card: parsed.card,
				rawJson: parsed.card.rawJson,
				imageBlob: new Blob([new Uint8Array(pngBytes)], { type: "image/png" }),
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
