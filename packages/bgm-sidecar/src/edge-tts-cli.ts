/**
 * Edge TTS 일회성 진입점 — 듣는 포트 없이 stdin 글을 받아 stdout 으로 MP3 를 낸다.
 *
 * 맥 앱스토어판은 network.server 권한이 없어(애플 2.4.5) BGM 사이드카의 /edge-tts 를 못 쓴다.
 * Rust(`lib.rs::edge_tts_stdio`)가 문장마다 이 파일을 spawn 한다. 사용: node edge-tts-cli.js <voice>
 */
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

function edgeVoice(v: string | undefined): string {
	return v && /Neural$/.test(v) ? v : "ko-KR-SunHiNeural";
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
	const text = (await readStdin()).slice(0, 5000);
	if (!text.trim()) throw new Error("text required");
	const tts = new MsEdgeTTS();
	await tts.setMetadata(
		edgeVoice(process.argv[2]),
		OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
	);
	const { audioStream } = tts.toStream(text);
	const chunks: Buffer[] = [];
	await new Promise<void>((resolve, reject) => {
		audioStream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
		audioStream.on("end", () => resolve());
		audioStream.on("error", reject);
	});
	process.stdout.write(Buffer.concat(chunks));
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
