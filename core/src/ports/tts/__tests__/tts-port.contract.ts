import { describe, expect, it } from "vitest";
import type { TtsPort } from "../tts-port.js";

/**
 * The TtsPort contract. EVERY adapter (mock, edge, openai, …) must satisfy it.
 * Each adapter's test file calls this with a factory — one contract, many adapters.
 * @see glossary.md#TtsPort
 */
export function runTtsPortContract(name: string, makePort: () => TtsPort): void {
	describe(`TtsPort contract: ${name}`, () => {
		it("returns base64 audio for a valid request", async () => {
			const result = await makePort().synthesize({ text: "안녕하세요" });
			expect(result).not.toBeNull();
			expect(result?.audioBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
		});

		it("returns null when there is nothing to synthesize", async () => {
			expect(await makePort().synthesize({ text: "   " })).toBeNull();
		});
	});
}
