import { describe, expect, it } from "vitest";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	parseGitWorktreePaths,
	REQUIRED_AGENT_COMMIT,
	REQUIRED_PROTO_SHA256,
	REQUIRED_MEMORY_COMMIT,
	REQUIRED_MEMORY_VERSION,
	PREPARE_PAIRED_AGENT_COMMAND,
	resolvePairedAgent,
	ensurePairedAgentCheckout,
	memoryDistDigest,
	assertNoTrackedChanges,
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

		expect(staging).toContain("resolvePairedAgent");
		expect(launcher).toContain("ensurePairedAgentCheckout({ env: targetEnv })");
		expect(launcher).not.toMatch(
			/mode === "dev"\s*\?\s*ensurePairedAgentCheckout/,
		);
		for (const source of [launcher, staging]) {
			expect(source).not.toContain("function agentCandidates");
			expect(source).not.toContain("function firstPairedAgentCheckout");
		}
		expect(resolver).toContain(
			'resolve(shellDir, "..", "..", "..", "naia-agent-worktrees")',
		);
	});

	it("names the prepare command when no checkout is found", () => {
		expect(() =>
			resolvePairedAgent({ env: {}, candidates: [] }),
		).toThrow(PREPARE_PAIRED_AGENT_COMMAND);

		const pkg = JSON.parse(
			readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
		);
		expect(pkg.scripts["agent:prepare"]).toBe(
			"node scripts/prepare-paired-agent.mjs",
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

describe("ensurePairedAgentCheckout", () => {
	it("preserves explicit NAIA_E2E_AGENT_ROOT and does not auto-prepare", () => {
		expect(() =>
			ensurePairedAgentCheckout({
				explicit: "non-existent-agent-dir",
			}),
		).toThrow(/No clean paired naia-agent checkout/);
	});
});

describe("ensurePairedAgentCheckout memory and install preparation", () => {
	function createFixture() {
		const root = mkdtempSync(join(process.cwd(), ".agent-pairing-prep-"));
		const agentDir = join(root, "agent");
		const memoryDir = join(root, "naia-memory");
		const installedMemoryDir = join(
			agentDir,
			"node_modules",
			"@nextain",
			"naia-memory",
		);

		mkdirSync(join(agentDir, "scripts", "builds"), { recursive: true });
		writeFileSync(
			join(agentDir, "scripts", "builds", "agent-stdio-entry.mjs"),
			"// fixture entrypoint\n",
		);
		mkdirSync(join(agentDir, "src", "main", "adapters", "grpc"), {
			recursive: true,
		});
		writeFileSync(
			join(agentDir, "src", "main", "adapters", "grpc", "naia_agent.proto"),
			'syntax = "proto3";\n',
		);
		mkdirSync(join(agentDir, "node_modules"), { recursive: true });
		mkdirSync(join(agentDir, "dist", "main", "composition"), {
			recursive: true,
		});
		writeFileSync(
			join(agentDir, "dist", "main", "composition", "index.js"),
			"// fixture composition\n",
		);

		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(
			join(memoryDir, "package.json"),
			JSON.stringify({
				name: "@nextain/naia-memory",
				version: REQUIRED_MEMORY_VERSION,
			}),
		);
		mkdirSync(join(memoryDir, "node_modules"), { recursive: true });

		return { root, agentDir, memoryDir, installedMemoryDir };
	}

	interface HarnessInitial {
		memoryHead: string | null;
		memoryStatus?: string;
		memoryBranch?: string | null;
		agentTracked?: string;
		installedDigest?: string;
		forceFixesInstalled?: boolean;
	}

	function makeHarness(
		fixture: ReturnType<typeof createFixture>,
		initial: HarnessInitial,
	) {
		const state = {
			memoryHead: initial.memoryHead,
			memoryStatus: initial.memoryStatus ?? "",
			memoryBranch: initial.memoryBranch ?? null,
			agentTracked: initial.agentTracked ?? "",
			installedDigest: initial.installedDigest ?? "new",
			forceFixesInstalled: initial.forceFixesInstalled ?? true,
		};

		const gitCalls: { dir: string; args: string[] }[] = [];
		const pnpmCalls: { args: string[]; cwd: string }[] = [];

		const options = {
			env: {},
			candidates: [fixture.agentDir],
			primaryRoots: [],
			worktreeRoots: [fixture.root],
			gitOutput: (dir: string, args: string[]) => {
				if (resolve(dir) === resolve(fixture.agentDir)) {
					if (args[0] === "rev-parse" && args[1] === "HEAD") {
						return REQUIRED_AGENT_COMMIT;
					}
					if (args[0] === "status") {
						if (args.includes("--untracked-files=no")) {
							return state.agentTracked;
						}
						return "";
					}
					return null;
				}
				if (resolve(dir) === resolve(fixture.memoryDir)) {
					if (args[0] === "rev-parse") {
						if (args[1] === "HEAD") return state.memoryHead;
						if (args.includes("--show-toplevel")) return fixture.memoryDir;
					}
					if (args[0] === "status") return state.memoryStatus;
					if (args[0] === "symbolic-ref") return state.memoryBranch;
					if (args[0] === "cat-file") return "";
					return null;
				}
				return null;
			},
			runGit: (dir: string, args: string[]) => {
				gitCalls.push({ dir, args });
				if (args[0] === "checkout" && args[1] === "--detach" && args[2]) {
					state.memoryHead = args[2];
				}
				return { status: 0, stdout: "", stderr: "" };
			},
			runProjectPnpm: (args: string[], cwd: string) => {
				pnpmCalls.push({ args, cwd });
				if (
					resolve(cwd) === resolve(fixture.agentDir) &&
					args.includes("--force")
				) {
					if (state.forceFixesInstalled) {
						state.installedDigest = "new";
					}
				}
			},
			memoryDigest: (path: string) => {
				if (resolve(path) === resolve(fixture.memoryDir)) return "new";
				if (resolve(path) === resolve(fixture.installedMemoryDir)) {
					return state.installedDigest;
				}
				return null;
			},
			hashProto: () => REQUIRED_PROTO_SHA256,
		};

		return { options, gitCalls, pnpmCalls, state };
	}

	it("a. memory already at pin, installed digest new", () => {
		const fixture = createFixture();
		try {
			const { options, gitCalls, pnpmCalls } = makeHarness(fixture, {
				memoryHead: REQUIRED_MEMORY_COMMIT,
				installedDigest: "new",
			});

			const res = ensurePairedAgentCheckout(options);
			expect(res.pairedAgent).toBe(fixture.agentDir);
			expect(gitCalls).toEqual([]);
			expect(pnpmCalls).toEqual([
				{
					args: ["--ignore-workspace", "run", "build"],
					cwd: fixture.memoryDir,
				},
			]);
			expect(pnpmCalls.some((c) => c.args.includes("install"))).toBe(false);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("b. memory at 0*40, clean, detached, installed old", () => {
		const fixture = createFixture();
		try {
			const { options, gitCalls, pnpmCalls } = makeHarness(fixture, {
				memoryHead: "0".repeat(40),
				installedDigest: "old",
			});

			const res = ensurePairedAgentCheckout(options);
			expect(res.pairedAgent).toBe(fixture.agentDir);
			expect(gitCalls).toContainEqual({
				dir: fixture.memoryDir,
				args: ["checkout", "--detach", REQUIRED_MEMORY_COMMIT],
			});
			expect(pnpmCalls).toContainEqual({
				args: ["--ignore-workspace", "install", "--frozen-lockfile"],
				cwd: fixture.memoryDir,
			});
			expect(pnpmCalls).toContainEqual({
				args: ["--ignore-workspace", "run", "build"],
				cwd: fixture.memoryDir,
			});
			expect(pnpmCalls).toContainEqual({
				args: [
					"--ignore-workspace",
					"install",
					"--frozen-lockfile",
					"--force",
				],
				cwd: fixture.agentDir,
			});
			for (const call of pnpmCalls) {
				if (call.args.includes("install")) {
					expect(call.args).toContain("--frozen-lockfile");
				}
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("c. memory dirty", () => {
		const fixture = createFixture();
		try {
			const { options, gitCalls, pnpmCalls } = makeHarness(fixture, {
				memoryHead: "0".repeat(40),
				memoryStatus: " M src/memory/index.ts",
			});

			let thrown: unknown = null;
			try {
				ensurePairedAgentCheckout(options);
			} catch (err: unknown) {
				thrown = err;
			}
			expect(thrown).not.toBeNull();
			expect((thrown as Error).message).toMatch(/local changes/);
			expect((thrown as Error).message).toContain(
				`checkout --detach ${REQUIRED_MEMORY_COMMIT}`,
			);
			expect(gitCalls).toEqual([]);
			expect(pnpmCalls).toEqual([]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("d. memory on branch", () => {
		const fixture = createFixture();
		try {
			const { options, gitCalls } = makeHarness(fixture, {
				memoryHead: "0".repeat(40),
				memoryBranch: "refs/heads/main",
			});

			expect(() => ensurePairedAgentCheckout(options)).toThrowError(
				/only a detached checkout/,
			);
			expect(gitCalls).toEqual([]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("e. installed copy still different after forced reinstall", () => {
		const fixture = createFixture();
		try {
			const { options, pnpmCalls } = makeHarness(fixture, {
				memoryHead: REQUIRED_MEMORY_COMMIT,
				installedDigest: "old",
				forceFixesInstalled: false,
			});

			expect(() => ensurePairedAgentCheckout(options)).toThrowError(
				/Installed naia-memory does not match/,
			);
			for (const call of pnpmCalls) {
				if (call.args.includes("install")) {
					expect(call.args).toContain("--frozen-lockfile");
				}
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("f. tracked change after install", () => {
		const fixture = createFixture();
		try {
			const { options, pnpmCalls } = makeHarness(fixture, {
				memoryHead: REQUIRED_MEMORY_COMMIT,
				agentTracked: " M pnpm-lock.yaml",
			});

			let thrown: unknown = null;
			try {
				ensurePairedAgentCheckout(options);
			} catch (err: unknown) {
				thrown = err;
			}
			expect(thrown).not.toBeNull();
			expect((thrown as Error).message).toContain("pnpm-lock.yaml");
			expect((thrown as Error).message).toContain("checkout --");

			for (const call of pnpmCalls) {
				if (call.args.includes("install")) {
					expect(call.args).toContain("--frozen-lockfile");
				}
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("g. memory not a git checkout", () => {
		const fixture = createFixture();
		try {
			const { options, gitCalls, pnpmCalls } = makeHarness(fixture, {
				memoryHead: null,
			});

			expect(() => ensurePairedAgentCheckout(options)).toThrowError(
				/not a git checkout/,
			);
			expect(gitCalls).toEqual([]);
			expect(pnpmCalls).toEqual([]);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("memoryDistDigest", () => {
	it("computes deterministic digest of dist/memory and detects changes or absence", () => {
		const fixtureRoot = mkdtempSync(
			join(process.cwd(), ".agent-pairing-digest-"),
		);
		try {
			const rootA = join(fixtureRoot, "pkg-a");
			const rootB = join(fixtureRoot, "pkg-b");
			const rootEmpty = join(fixtureRoot, "pkg-empty");

			mkdirSync(join(rootA, "dist", "memory", "sub"), { recursive: true });
			writeFileSync(
				join(rootA, "dist", "memory", "index.js"),
				"console.log('main');\n",
			);
			writeFileSync(
				join(rootA, "dist", "memory", "sub", "a.js"),
				"export const val = 1;\n",
			);

			mkdirSync(join(rootB, "dist", "memory", "sub"), { recursive: true });
			writeFileSync(
				join(rootB, "dist", "memory", "index.js"),
				"console.log('main');\n",
			);
			writeFileSync(
				join(rootB, "dist", "memory", "sub", "a.js"),
				"export const val = 1;\n",
			);

			mkdirSync(rootEmpty, { recursive: true });

			const digestA = memoryDistDigest(rootA);
			const digestB = memoryDistDigest(rootB);
			expect(digestA).not.toBeNull();
			expect(digestA).toBe(digestB);

			writeFileSync(
				join(rootB, "dist", "memory", "sub", "a.js"),
				"export const val = 2;\n",
			);
			const digestBChanged = memoryDistDigest(rootB);
			expect(digestBChanged).not.toBeNull();
			expect(digestBChanged).not.toBe(digestA);

			expect(memoryDistDigest(rootEmpty)).toBeNull();
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});

describe("assertNoTrackedChanges", () => {
	it("ignores recovery lease files and does not throw", () => {
		expect(() =>
			assertNoTrackedChanges("/mock/dir", "test-stage", {
				gitOutput: () => "?? .agents/session-contracts/.recovery/lease.json",
			}),
		).not.toThrow();
	});

	it("throws error with file name and restore command when tracked files are modified", () => {
		let thrown: unknown = null;
		try {
			assertNoTrackedChanges("/mock/dir", "test-stage", {
				gitOutput: () => " M pnpm-lock.yaml",
			});
		} catch (err: unknown) {
			thrown = err;
		}
		expect(thrown).not.toBeNull();
		expect((thrown as Error).message).toContain("pnpm-lock.yaml");
		expect((thrown as Error).message).toContain('git -C "');
	});

	it("throws error when git status cannot be read", () => {
		expect(() =>
			assertNoTrackedChanges("/mock/dir", "test-stage", {
				gitOutput: () => null,
			}),
		).toThrowError(/Cannot read git status/);
	});
});

