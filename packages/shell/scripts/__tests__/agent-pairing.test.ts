import { describe, expect, it } from "vitest";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseGitWorktreePaths,
	REQUIRED_AGENT_COMMIT,
	REQUIRED_PROTO_SHA256,
	resolvePairedAgent,
} from "../agent-pairing.mjs";

describe("parseGitWorktreePaths", () => {
	it("discovers registered worktrees outside the conventional worktree directory", () => {
		const porcelain = [
			"worktree D:/alpha-adk/projects/naia-agent",
			"HEAD c19f166cf655d7375b9a37bb6d2cd70fd008a7e7",
			"branch refs/heads/main",
			"",
			"worktree D:/alpha-adk/projects/naia-agent-voxcpm2-e2e-196fc64",
			"HEAD 196fc64cc01e852bd27dc88675d53f5995f228dd",
			"detached",
			"",
		].join("\n");

		expect(parseGitWorktreePaths(porcelain)).toEqual([
			"D:/alpha-adk/projects/naia-agent",
			"D:/alpha-adk/projects/naia-agent-voxcpm2-e2e-196fc64",
		]);
	});

	it("returns no candidates for a failed or empty git query", () => {
		expect(parseGitWorktreePaths(null)).toEqual([]);
		expect(parseGitWorktreePaths("")).toEqual([]);
	});
});

describe("paired-agent resolver integration", () => {
	it("keeps launcher and staging selection on the shared resolver", () => {
		const launcher = readFileSync(
			new URL("../tauri-with-mode.mjs", import.meta.url),
			"utf8",
		);
		const staging = readFileSync(
			new URL("../stage-runtime.mjs", import.meta.url),
			"utf8",
		);
		const resolver = readFileSync(
			new URL("../agent-pairing.mjs", import.meta.url),
			"utf8",
		);

		for (const source of [launcher, staging]) {
			expect(source).toContain("resolvePairedAgent");
			expect(source).not.toContain("function agentCandidates");
			expect(source).not.toContain("function firstPairedAgentCheckout");
		}
		expect(resolver).toContain(
			'resolve(shellDir, "..", "..", "..", "naia-agent-worktrees")',
		);
	});

	it("selects one valid checkout and rejects invalid or dirty siblings", () => {
		const fixtureRoot = mkdtempSync(
			join(process.cwd(), ".agent-pairing-fixture-"),
		);
		const checkoutNames = [
			"a-valid",
			"z-valid",
			"wrong-pin",
			"dirty-proto",
			"dirty-entrypoint",
			"recovery-only",
			"recovery-and-dirty",
			"proto-mismatch",
		];
		const createCheckout = (root: string, name: string) => {
			mkdirSync(join(root, "scripts", "builds"), { recursive: true });
			mkdirSync(join(root, "src", "main", "adapters", "grpc"), {
				recursive: true,
			});
			writeFileSync(
				join(root, "scripts", "builds", "agent-stdio-entry.mjs"),
				"// fixture entrypoint\n",
			);
			writeFileSync(
				join(root, "src", "main", "adapters", "grpc", "naia_agent.proto"),
				`syntax = "proto3"; // ${name}\n`,
			);
		};
		const checkouts: Record<string, string> = Object.fromEntries(
			checkoutNames.map((name) => {
				const root = join(fixtureRoot, name);
				createCheckout(root, name);
				return [name, root];
			}),
		);
		const temporaryCheckout = mkdtempSync(join(tmpdir(), "naia-agent-pairing-"));
		createCheckout(temporaryCheckout, "temporary");

		const statuses = new Map([
			[checkouts["a-valid"], ""],
			[checkouts["z-valid"], ""],
			[checkouts["wrong-pin"], ""],
			[checkouts["dirty-proto"], " M src/main/adapters/grpc/naia_agent.proto"],
			[
				checkouts["dirty-entrypoint"],
				" M scripts/builds/agent-stdio-entry.mjs",
			],
			[
				checkouts["recovery-only"],
				"?? .agents/session-contracts/.recovery/lease.json",
			],
			[
				checkouts["recovery-and-dirty"],
				"?? .agents/session-contracts/.recovery/lease.json\n M README.md",
			],
			[checkouts["proto-mismatch"], ""],
			[temporaryCheckout, ""],
		]);
		const commits = new Map(
			checkoutNames.map((name) => [
				checkouts[name],
				name === "wrong-pin" ? "deadbeef" : REQUIRED_AGENT_COMMIT,
			]),
		);
		commits.set(temporaryCheckout, REQUIRED_AGENT_COMMIT);
		const protoHashes = new Map(
			checkoutNames.map((name) => [
				join(
					checkouts[name],
					"src",
					"main",
					"adapters",
					"grpc",
					"naia_agent.proto",
				),
				name === "proto-mismatch" ? "bad-proto" : REQUIRED_PROTO_SHA256,
			]),
		);
		protoHashes.set(
			join(
				temporaryCheckout,
				"src",
				"main",
				"adapters",
				"grpc",
				"naia_agent.proto",
			),
			REQUIRED_PROTO_SHA256,
		);

		const resolverOptions = {
			env: {},
			candidates: [
				temporaryCheckout,
				checkouts["z-valid"],
				checkouts["proto-mismatch"],
				checkouts["wrong-pin"],
				checkouts["dirty-entrypoint"],
				checkouts["recovery-only"],
				checkouts["a-valid"],
				checkouts["dirty-proto"],
				checkouts["recovery-and-dirty"],
			],
			gitOutput: (directory: string, args: string[]): string | null => {
				if (args[0] === "rev-parse") return commits.get(directory) ?? null;
				if (args[0] === "status") return statuses.get(directory) ?? null;
				return null;
			},
			hashProto: (path: string): string =>
				protoHashes.get(path) ?? "missing-proto",
		};

		const ambientRoot = process.env.NAIA_E2E_AGENT_ROOT;
		process.env.NAIA_E2E_AGENT_ROOT = temporaryCheckout;
		try {
			expect(() =>
				resolvePairedAgent({
					...resolverOptions,
					candidates: [temporaryCheckout],
				}),
			).toThrow(/No clean paired naia-agent checkout/);
			expect(
				resolvePairedAgent({
					...resolverOptions,
					env: { NAIA_E2E_AGENT_ROOT: temporaryCheckout },
				}),
			).toMatchObject({ pairedAgent: temporaryCheckout });

			const resolved = resolvePairedAgent(resolverOptions);
			expect(resolved.pairedAgent).toBe(checkouts["a-valid"]);
			expect(resolved.agentScript).toBe(
				join(checkouts["a-valid"], "scripts", "builds", "agent-stdio-entry.mjs"),
			);
			expect(resolved.agentProtoDir).toBe(
				join(checkouts["a-valid"], "src", "main", "adapters", "grpc"),
			);

			for (const name of [
				"wrong-pin",
				"dirty-proto",
				"dirty-entrypoint",
				"recovery-and-dirty",
				"proto-mismatch",
			]) {
				expect(() =>
					resolvePairedAgent({
						...resolverOptions,
						candidates: [checkouts[name]],
					}),
				).toThrow(/No clean paired naia-agent checkout/);
			}

			expect(
				resolvePairedAgent({
					...resolverOptions,
					candidates: [checkouts["recovery-only"]],
				}),
			).toMatchObject({ pairedAgent: checkouts["recovery-only"] });
		} finally {
			if (ambientRoot === undefined) delete process.env.NAIA_E2E_AGENT_ROOT;
			else process.env.NAIA_E2E_AGENT_ROOT = ambientRoot;
			rmSync(temporaryCheckout, { recursive: true, force: true });
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});
