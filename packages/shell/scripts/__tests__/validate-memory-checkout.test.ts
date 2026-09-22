import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateMemoryCheckout } from "../validate-memory-checkout.mjs";

const temporaryRepositories: string[] = [];

function git(repository: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repository, ...args], {
		encoding: "utf8",
	}).trim();
}

function createMemoryRepository(version = "0.1.4") {
	const repository = mkdtempSync(join(tmpdir(), "naia-memory-contract-"));
	temporaryRepositories.push(repository);
	git(repository, "init", "--quiet");
	git(repository, "config", "user.name", "Naia Test");
	git(repository, "config", "user.email", "naia-test@example.invalid");
	writeFileSync(
		join(repository, "package.json"),
		`${JSON.stringify({ name: "@nextain/naia-memory", version })}\n`,
	);
	git(repository, "add", "package.json");
	git(repository, "commit", "--quiet", "-m", "fixture");
	return { repository, commit: git(repository, "rev-parse", "HEAD") };
}

afterEach(() => {
	for (const repository of temporaryRepositories.splice(0)) {
		rmSync(repository, { recursive: true, force: true });
	}
});

describe("validateMemoryCheckout", () => {
	it("accepts only the exact clean memory checkout", () => {
		const { repository, commit } = createMemoryRepository();
		expect(validateMemoryCheckout(repository, commit, "0.1.4")).toBeNull();
	});

	it("rejects commit drift and every dirty working-tree change", () => {
		const { repository, commit } = createMemoryRepository();
		expect(validateMemoryCheckout(repository, "0".repeat(40), "0.1.4")).toBe(
			"checkout commit mismatch",
		);
		writeFileSync(join(repository, "recovery-artifact.json"), "{}\n");
		expect(validateMemoryCheckout(repository, commit, "0.1.4")).toBe(
			"checkout must be clean",
		);
	});

	it("rejects a clean checkout with the wrong package identity", () => {
		const { repository } = createMemoryRepository("9.9.9");
		const commit = git(repository, "rev-parse", "HEAD");
		expect(validateMemoryCheckout(repository, commit, "0.1.4")).toBe(
			"package identity mismatch",
		);
	});

	it("uses options.gitOutput when provided", () => {
		const repository = mkdtempSync(join(tmpdir(), "naia-memory-plain-"));
		temporaryRepositories.push(repository);
		writeFileSync(
			join(repository, "package.json"),
			`${JSON.stringify({ name: "@nextain/naia-memory", version: "0.1.4" })}\n`,
		);
		const commit = "a".repeat(40);
		let status = "";
		const gitOutput = (_dir: string, args: string[]) => {
			if (args[0] === "rev-parse" && args.includes("--show-toplevel")) return repository;
			if (args[0] === "rev-parse" && args.includes("HEAD")) return commit;
			if (args[0] === "status") return status;
			return null;
		};

		expect(
			validateMemoryCheckout(repository, commit, "0.1.4", { gitOutput }),
		).toBeNull();

		status = " M x";
		expect(
			validateMemoryCheckout(repository, commit, "0.1.4", { gitOutput }),
		).toBe("checkout must be clean");
	});
});
