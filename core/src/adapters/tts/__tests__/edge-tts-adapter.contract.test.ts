import { vi } from "vitest";
import { runTtsPortContract } from "../../../ports/tts/__tests__/tts-port.contract.js";
import { EdgeTtsAdapter } from "../edge-tts-adapter.js";

// Mock msedge-tts → deterministic, no network. Proves the REAL adapter satisfies the SAME contract.
vi.mock("msedge-tts", () => {
	class MsEdgeTTS {
		async setMetadata(): Promise<void> {}
		toStream(text: string): { audioStream: AsyncIterable<Buffer> } {
			async function* gen(): AsyncGenerator<Buffer> {
				yield Buffer.from(`edge-mock:${text}`, "utf8");
			}
			return { audioStream: gen() };
		}
		close(): void {}
	}
	return { MsEdgeTTS, OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: "fmt" } };
});

runTtsPortContract("EdgeTtsAdapter (msedge-tts mocked)", () => new EdgeTtsAdapter());
