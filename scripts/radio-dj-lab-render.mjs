import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function escapeXml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

const TIMELINE_LANES = [
	"radio.profile",
	"radio.turn",
	"radio.voice",
	"bgm.tool",
	"bgm.playback",
	"bgm.volume",
	"ui.state",
];
export function renderTimelineSvg(events, title = "Radio DJ Lab timeline") {
	const maxMs = Math.max(1, ...events.map((event) => event.elapsed_ms));
	const width = 1240;
	const left = 170;
	const right = 24;
	const top = 82;
	const laneHeight = 48;
	const height = top + TIMELINE_LANES.length * laneHeight + 42;
	const plotWidth = width - left - right;
	const timeX = (ms) => left + (ms / maxMs) * plotWidth;
	const palette = {
		"radio.profile": "#7c3aed",
		"radio.turn": "#2563eb",
		"radio.voice": "#db2777",
		"bgm.tool": "#d97706",
		"bgm.playback": "#059669",
		"bgm.volume": "#64748b",
	};
	const ticks = Array.from({ length: 5 }, (_, index) =>
		Math.round((maxMs * index) / 4),
	);
	const axis = ticks
		.map(
			(tick) =>
				`<g><line x1="${timeX(tick)}" y1="${top - 10}" x2="${timeX(tick)}" y2="${height - 28}" stroke="#dbe2ea"/><text x="${timeX(tick)}" y="${top - 20}" text-anchor="middle" class="axis">${tick} ms</text></g>`,
		)
		.join("");
	const lanes = TIMELINE_LANES.map((name, index) => {
		const y = top + index * laneHeight;
		const markers = events
			.filter((event) => event.event_type === name)
			.map((event) => {
				const x = timeX(event.elapsed_ms);
				const label =
					event.data.status ??
					event.data.phase ??
					event.data.profile ??
					event.data.action ??
					`${event.data.volume}`;
				return `<g><title>${event.elapsed_ms} ms · ${escapeXml(label)}</title><circle cx="${x}" cy="${y + 18}" r="7" fill="${palette[name]}"/><text x="${x + 10}" y="${y + 22}" class="event">${escapeXml(label)}</text></g>`;
			})
			.join("");
		return `<g><text x="18" y="${y + 22}" class="lane">${name}</text><line x1="${left}" y1="${y + 30}" x2="${width - right}" y2="${y + 30}" stroke="#eef1f5"/>${markers}</g>`;
	}).join("");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">${escapeXml(title)}</title><desc id="desc">${events.length} events across ${maxMs} virtual milliseconds.</desc><style>text{font-family:ui-sans-serif,system-ui,sans-serif;fill:#172033}.heading{font-size:21px;font-weight:700}.lane{font-size:13px;font-weight:600}.event{font-size:11px}.axis{font-size:10px;fill:#64748b}</style><rect width="100%" height="100%" rx="14" fill="#fff"/><text x="18" y="34" class="heading">${escapeXml(title)}</text><text x="18" y="55" class="axis">${events.length} events · ${maxMs} ms · ${events[0]?.clock_domain ?? "no events"}</text>${axis}${lanes}</svg>`;
}

export function createFixtureToneWav(durationMs = 350, frequencyHz = 660) {
	const sampleRate = 16_000;
	const samples = Math.round((sampleRate * durationMs) / 1000);
	const dataBytes = samples * 2;
	const buffer = Buffer.alloc(44 + dataBytes);
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataBytes, 4);
	buffer.write("WAVEfmt ", 8);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataBytes, 40);
	for (let index = 0; index < samples; index += 1) {
		const envelope = Math.min(1, index / 400, (samples - index) / 400);
		buffer.writeInt16LE(
			Math.round(
				Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) *
					3600 *
					envelope,
			),
			44 + index * 2,
		);
	}
	return buffer;
}

export function jsonl(events) {
	return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export async function writeEmptyOutputDir(outputDir) {
	await mkdir(outputDir, { recursive: true });
	if ((await readdir(outputDir)).length > 0)
		throw new Error(`output directory is not empty: ${outputDir}`);
}
