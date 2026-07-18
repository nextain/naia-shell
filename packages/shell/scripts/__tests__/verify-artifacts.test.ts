import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyArtifacts } from "../verify-artifacts.mjs";

const fixtures: string[] = [];
const fixture = () => {
	const dir = mkdtempSync(resolve(tmpdir(), "naia-artifacts-"));
	fixtures.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of fixtures.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("verifyArtifacts (FR-INSTALL.6)", () => {
	it("산출물 부재는 red", () => {
		const bundleDir = fixture();
		expect(() =>
			verifyArtifacts({
				bundleDir,
				artifacts: [{ glob: "nsis/*-setup.exe", minBytes: 10 }],
			}),
		).toThrow(/산출물 없음/);
	});

	it("minBytes 미확정은 명확한 red", () => {
		const bundleDir = fixture();
		expect(() =>
			verifyArtifacts({
				bundleDir,
				artifacts: [{ glob: "nsis/*-setup.exe", minBytes: null }],
			}),
		).toThrow(/minBytes 미확정/);
	});

	it("과소 파일은 red, 임계 이상 파일은 SHA와 크기를 반환", () => {
		const bundleDir = fixture();
		mkdirSync(resolve(bundleDir, "nsis"));
		writeFileSync(resolve(bundleDir, "nsis", "naia-setup.exe"), "tiny");
		const artifacts = [{ glob: "nsis/*-setup.exe", minBytes: 10 }];
		expect(() => verifyArtifacts({ bundleDir, artifacts })).toThrow(
			/산출물 과소/,
		);

		writeFileSync(resolve(bundleDir, "nsis", "naia-setup.exe"), "large-enough");
		const result = verifyArtifacts({ bundleDir, artifacts });
		expect(result).toHaveLength(1);
		expect(result[0].path).toBe("nsis/naia-setup.exe");
		expect(result[0].bytes).toBe(12);
		expect(result[0].sha256).toMatch(/^[0-9a-f]{64}$/);
	});
});
