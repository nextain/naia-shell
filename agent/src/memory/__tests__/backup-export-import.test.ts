/**
 * Tests for LocalAdapter export() / import() — E2E encrypted backup (#211)
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalAdapter } from "../adapters/local.js";

function testStorePath(): string {
	return join(tmpdir(), `naia-backup-test-${randomUUID()}.json`);
}

describe("LocalAdapter backup: export() / import()", () => {
	it("export produces a non-empty Uint8Array with NAIA magic header", async () => {
		const path = testStorePath();
		const adapter = new LocalAdapter(path);
		const blob = await adapter.export("test-password");
		expect(blob).toBeInstanceOf(Uint8Array);
		// Header: magic(4) + version(1) + salt(16) + iv(12) + authTag(16) = 49 bytes + ciphertext
		expect(blob.length).toBeGreaterThan(49);

		// Magic: first 4 bytes are ASCII "NAIA"
		const magic = Buffer.from(blob.subarray(0, 4)).toString("ascii");
		expect(magic).toBe("NAIA");

		// Version byte
		expect(blob[4]).toBe(0x01);

		await adapter.close();
		try { rmSync(path); } catch {}
	});

	it("import restores memory from a valid export blob", async () => {
		const srcPath = testStorePath();
		const dstPath = testStorePath();

		// Source adapter with data
		const src = new LocalAdapter(srcPath);
		await src.episode.store({
			id: randomUUID(),
			content: "I prefer TypeScript for all projects",
			summary: "TypeScript preference",
			timestamp: Date.now(),
			role: "user",
			importance: { importance: 0.8, surprise: 0.1, emotion: 0.5, utility: 0.8 },
			encodingContext: { project: "test" },
			consolidated: false,
			recallCount: 0,
			lastAccessed: Date.now(),
			strength: 0.8,
		});
		await src.semantic.upsert({
			id: randomUUID(),
			content: "User prefers TypeScript",
			entities: ["TypeScript"],
			topics: ["tech"],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			importance: 0.8,
			recallCount: 0,
			lastAccessed: Date.now(),
			strength: 0.8,
			sourceEpisodes: [],
		});
		await src.close();

		// Export from source
		const srcForExport = new LocalAdapter(srcPath);
		const blob = await srcForExport.export("my-password");
		await srcForExport.close();

		// Import into destination
		const dst = new LocalAdapter(dstPath);
		await dst.import(blob, "my-password");

		// Verify episodes and facts were restored
		const allEps = await dst.episode.getRecent(10);
		expect(allEps.length).toBeGreaterThan(0);
		expect(allEps[0].content).toContain("TypeScript");

		const facts = await dst.semantic.search("TypeScript", 5);
		expect(facts.length).toBeGreaterThan(0);
		expect(facts[0].content).toContain("TypeScript");

		// Verify KG was re-pointed (entity from upsert should be searchable via KG)
		const kg = dst.getKnowledgeGraph();
		expect(kg).toBeInstanceOf(Object);
		// A semantic search that goes through spreading activation confirms the KG is live
		const kgSearchResults = await dst.semantic.search("TypeScript", 5);
		expect(kgSearchResults.length).toBeGreaterThan(0);

		await dst.close();
		try { rmSync(srcPath); } catch {}
		try { rmSync(dstPath); } catch {}
	});

	it("export and import throw on empty password", async () => {
		const adapterPath = testStorePath();
		const adapter = new LocalAdapter(adapterPath);
		await expect(adapter.export("")).rejects.toThrow(/Password must not be empty/);

		// Need a valid blob to test import path
		const blob = await adapter.export("real-password");
		await expect(adapter.import(blob, "")).rejects.toThrow(/Password must not be empty/);

		await adapter.close();
		try { rmSync(adapterPath); } catch {}
	});

	it("import throws on wrong password", async () => {
		const srcPath = testStorePath();
		const dstPath = testStorePath();
		const src = new LocalAdapter(srcPath);
		const blob = await src.export("correct-password");
		await src.close();

		const dst = new LocalAdapter(dstPath);
		await expect(dst.import(blob, "wrong-password")).rejects.toThrow(
			/Decryption failed|wrong password/,
		);

		await dst.close();
		try { rmSync(srcPath); } catch {}
		try { rmSync(dstPath); } catch {}
	});

	it("import throws on truncated blob", async () => {
		const adapterPath = testStorePath();
		const dstPath = testStorePath();
		const adapter = new LocalAdapter(adapterPath);
		const blob = await adapter.export("password");
		const truncated = blob.subarray(0, 40); // shorter than the 49-byte header

		const dst = new LocalAdapter(dstPath);
		await expect(dst.import(truncated, "password")).rejects.toThrow(
			/too short/,
		);

		await adapter.close();
		await dst.close();
		try { rmSync(adapterPath); } catch {}
		try { rmSync(dstPath); } catch {}
	});

	it("import throws on wrong magic bytes", async () => {
		const adapterPath = testStorePath();
		const dstPath = testStorePath();
		const adapter = new LocalAdapter(adapterPath);
		const blob = await adapter.export("password");
		// Corrupt magic
		const corrupted = new Uint8Array(blob);
		corrupted[0] = 0x00;

		const dst = new LocalAdapter(dstPath);
		await expect(dst.import(corrupted, "password")).rejects.toThrow(
			/bad magic/,
		);

		await adapter.close();
		await dst.close();
		try { rmSync(adapterPath); } catch {}
		try { rmSync(dstPath); } catch {}
	});

	it("same password produces different blobs each time (non-deterministic salt+IV)", async () => {
		const path1 = testStorePath();
		const path2 = testStorePath();
		const adapter1 = new LocalAdapter(path1);
		const adapter2 = new LocalAdapter(path2);

		const blob1 = await adapter1.export("password-a");
		const blob2 = await adapter2.export("password-a");

		// Same password + same (empty) data → blobs should differ due to random salt/IV
		expect(Buffer.from(blob1).toString("hex")).not.toBe(
			Buffer.from(blob2).toString("hex"),
		);

		await adapter1.close();
		await adapter2.close();
		try { rmSync(path1); } catch {}
		try { rmSync(path2); } catch {}
	});

	it("import with wrong password leaves adapter in original state", async () => {
		const srcPath = testStorePath();
		const dstPath = testStorePath();

		// Destination has an episode before the failed import
		const dst = new LocalAdapter(dstPath);
		await dst.episode.store({
			id: randomUUID(),
			content: "original content before failed import",
			summary: "Original",
			timestamp: Date.now(),
			role: "user",
			importance: { importance: 0.8, surprise: 0.1, emotion: 0.5, utility: 0.8 },
			encodingContext: {},
			consolidated: false,
			recallCount: 0,
			lastAccessed: Date.now(),
			strength: 0.8,
		});

		// Export with one password, try to import with wrong one
		const src = new LocalAdapter(srcPath);
		const blob = await src.export("correct");
		await src.close();

		await expect(dst.import(blob, "wrong")).rejects.toThrow(/Decryption failed/);

		// State must be unchanged — original episode still there
		const eps = await dst.episode.getRecent(10);
		expect(eps.some((e) => e.content.includes("original content"))).toBe(true);

		await dst.close();
		try { rmSync(srcPath); } catch {}
		try { rmSync(dstPath); } catch {}
	});

	it("import replaces existing memory completely", async () => {
		const srcPath = testStorePath();
		const dstPath = testStorePath();

		// Source: one episode
		const src = new LocalAdapter(srcPath);
		await src.episode.store({
			id: randomUUID(),
			content: "Source content",
			summary: "Source",
			timestamp: Date.now(),
			role: "user",
			importance: { importance: 0.9, surprise: 0.1, emotion: 0.5, utility: 0.9 },
			encodingContext: {},
			consolidated: false,
			recallCount: 0,
			lastAccessed: Date.now(),
			strength: 0.9,
		});
		const blob = await src.export("pass");
		await src.close();

		// Destination: different existing episode
		const dst = new LocalAdapter(dstPath);
		await dst.episode.store({
			id: randomUUID(),
			content: "Destination content that should be replaced",
			summary: "Dst",
			timestamp: Date.now(),
			role: "user",
			importance: { importance: 0.9, surprise: 0.1, emotion: 0.5, utility: 0.9 },
			encodingContext: {},
			consolidated: false,
			recallCount: 0,
			lastAccessed: Date.now(),
			strength: 0.9,
		});

		await dst.import(blob, "pass");

		// After import, only source content should remain.
		// Use getRecent (no scoring/strength filter) to enumerate all episodes reliably.
		const allEps = await dst.episode.getRecent(100);
		const contents = allEps.map((e) => e.content);
		expect(contents.some((c) => c.includes("Source content"))).toBe(true);
		expect(contents.some((c) => c.includes("Destination content"))).toBe(false);

		await dst.close();
		try { rmSync(srcPath); } catch {}
		try { rmSync(dstPath); } catch {}
	});
});
