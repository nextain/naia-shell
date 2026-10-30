import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assembleUniversalApp,
	assertUniversalAppMachO,
	classifyFile,
	classifyFileSets,
} from "../assemble-macos-universal.mjs";

function fixture() {
	const root = mkdtempSync(resolve(tmpdir(), "naia-universal-"));
	const x64 = resolve(root, "x64.app");
	const arm64 = resolve(root, "arm64.app");
	for (const app of [x64, arm64]) {
		mkdirSync(resolve(app, "Contents/MacOS"), { recursive: true });
		writeFileSync(resolve(app, "Contents/Info.plist"), "same");
		writeFileSync(resolve(app, "Contents/MacOS/naia-shell"), "binary");
	}
	return { x64, arm64 };
}

const portablePath = (path: string) => path.replaceAll("\\", "/");

describe("macOS Universal Binary assembly", () => {
	it("keeps both architecture builds and runs the Universal app on both runner types", () => {
		const workflow = readFileSync(
			resolve(
				import.meta.dirname,
				"../../../../.github/workflows/build-installers.yml",
			),
			"utf8",
		).replaceAll("\r\n", "\n");
		expect(workflow).toContain("os: macos-15-intel");
		expect(workflow).toContain("uname_arch: x86_64");
		expect(workflow).toContain(
			'test "$(uname -m)" = "${{ matrix.uname_arch }}"',
		);
		expect(workflow).toContain("os: macos-15\n            arch: arm64");
		expect(workflow).toContain("macos-universal-smoke:");
		expect(workflow).toContain("Naia_universal.app.tar.gz");
		expect(workflow).toContain("verify-installed-smoke.mjs");
	});

	it("allows only architecture-scoped differences in relative file sets", () => {
		const { x64, arm64 } = fixture();
		expect(classifyFileSets(x64, arm64).common).toEqual([
			"Contents/Info.plist",
			"Contents/MacOS/naia-shell",
		]);
		mkdirSync(
			resolve(x64, "Contents/Resources/agent/node_modules/vendor-darwin-x64"),
			{
				recursive: true,
			},
		);
		writeFileSync(
			resolve(
				x64,
				"Contents/Resources/agent/node_modules/vendor-darwin-x64/native.node",
			),
			"ok",
		);
		expect(classifyFileSets(x64, arm64).onlyX64).toEqual([
			"Contents/Resources/agent/node_modules/vendor-darwin-x64/native.node",
		]);
		mkdirSync(resolve(x64, "Contents/Resources/foo-macos-x64"), {
			recursive: true,
		});
		writeFileSync(
			resolve(x64, "Contents/Resources/foo-macos-x64/config.json"),
			"bad",
		);
		expect(() => classifyFileSets(x64, arm64)).toThrow(
			"unscoped x86_64-only file",
		);
	});

	it("rejects package names where darwin is not a delimited platform token", () => {
		const { x64, arm64 } = fixture();
		const falsePositive = resolve(
			x64,
			"Contents/Resources/agent/node_modules/vendor-notdarwin-x64/native.node",
		);
		mkdirSync(resolve(falsePositive, ".."), { recursive: true });
		writeFileSync(falsePositive, "bad");
		expect(() => classifyFileSets(x64, arm64)).toThrow(
			"unscoped x86_64-only file",
		);
	});

	it("accepts matching slash-separated prebuild slices in both input apps", () => {
		const { x64, arm64 } = fixture();
		const paths = ["darwin/arm64", "darwin/x64"].map(
			arch => `Contents/Resources/agent/node_modules/onnxruntime-node/bin/napi-v3/${arch}/x.dylib`,
		);
		for (const app of [x64, arm64]) for (const path of paths) {
			const file = resolve(app, path);
			mkdirSync(resolve(file, ".."), { recursive: true });
			writeFileSync(file, path.includes("/arm64/") ? "arm64" : "x86_64");
		}
		const exec = (command: string, args: string[]) => {
			if (command === "file") return Buffer.from(args[1].endsWith(".dylib") ? "Mach-O" : "data");
			if (command === "lipo") return Buffer.from(readFileSync(args[1], "utf8"));
			throw new Error(`unexpected ${command}`);
		};
		const output = resolve(x64, "../scoped.app");
		assembleUniversalApp({ x64App: x64, arm64App: arm64, outputApp: output }, exec as never);
		expect(assertUniversalAppMachO(output, exec as never)).toEqual(expect.arrayContaining(paths));
		writeFileSync(resolve(arm64, paths[0]), "x86_64");
		expect(() => assembleUniversalApp({ x64App: x64, arm64App: arm64, outputApp: output }, exec as never)).toThrow("scoped Mach-O mismatch");
	});

	it("classifies only file(1) Mach-O output as native", () => {
		const exec = (_command: string, args: string[]) =>
			Buffer.from(args[1]?.endsWith("native") ? "Mach-O 64-bit" : "JSON data");
		expect(classifyFile("native", exec as never)).toBe("mach-o");
		expect(classifyFile("data", exec as never)).toBe("data");
	});

	it("rejects any shipped Mach-O missing either architecture", () => {
		const { x64: app } = fixture();
		const exec = (command: string, args: string[]) => {
			if (command === "file") return Buffer.from("Mach-O 64-bit executable");
			if (command === "lipo" && args[0] === "-archs")
				return Buffer.from("x86_64");
			throw new Error(`unexpected ${command}`);
		};
		expect(() => assertUniversalAppMachO(app, exec as never)).toThrow(
			"unscoped or mismatched thin Mach-O",
		);
	});

	it("allows a thin Mach-O only under its matching architecture-scoped path", () => {
		const { x64: app } = fixture();
		const payload = resolve(
			app,
			"Contents/Resources/agent/node_modules/vendor-darwin-x64/native.node",
		);
		mkdirSync(resolve(payload, ".."), { recursive: true });
		writeFileSync(payload, "binary");
		const exec = (command: string, args: string[]) => {
			if (command === "file")
				return Buffer.from(
					args[1]?.endsWith("Info.plist") ? "XML" : "Mach-O 64-bit",
				);
			if (command === "lipo" && args[0] === "-archs")
				return Buffer.from(
					args[1]?.includes("vendor-darwin-x64") ? "x86_64" : "x86_64 arm64",
				);
			throw new Error(`unexpected ${command}`);
		};
		expect(assertUniversalAppMachO(app, exec as never)).toContain(
			"Contents/Resources/agent/node_modules/vendor-darwin-x64/native.node",
		);
	});

	it("executes the production assembly path and merges common Mach-O files", () => {
		const { x64, arm64 } = fixture();
		const output = resolve(x64, "../universal.app");
		writeFileSync(resolve(x64, "Contents/MacOS/naia-shell"), "x86_64");
		writeFileSync(resolve(arm64, "Contents/MacOS/naia-shell"), "arm64");
		const exec = (command: string, args: string[]) => {
			if (command === "file")
				return Buffer.from(
					portablePath(args[1] ?? "").endsWith("Contents/MacOS/naia-shell")
						? "Mach-O 64-bit executable"
						: "data",
				);
			if (command === "lipo" && args[0] === "-archs")
				return Buffer.from(readFileSync(args[1], "utf8"));
			if (command === "lipo" && args[0] === "-create") {
				writeFileSync(args[2], "x86_64 arm64");
				return Buffer.alloc(0);
			}
			throw new Error(`unexpected ${command}`);
		};
		const result = assembleUniversalApp(
			{ x64App: x64, arm64App: arm64, outputApp: output },
			exec as never,
		);
		expect(result.merged).toBe(1);
		expect(
			readFileSync(resolve(output, "Contents/MacOS/naia-shell"), "utf8"),
		).toBe("x86_64 arm64");
	});

	it("rejects swapped input slices before lipo can normalize them", () => {
		const { x64, arm64 } = fixture();
		writeFileSync(resolve(x64, "Contents/MacOS/naia-shell"), "arm64");
		writeFileSync(resolve(arm64, "Contents/MacOS/naia-shell"), "x86_64");
		const exec = (command: string, args: string[]) => {
			if (command === "file")
				return Buffer.from(
					portablePath(args[1] ?? "").endsWith("Contents/MacOS/naia-shell")
						? "Mach-O"
						: "data",
				);
			if (command === "lipo" && args[0] === "-archs")
				return Buffer.from(readFileSync(args[1], "utf8"));
			throw new Error("unexpected command");
		};
		expect(() =>
			assembleUniversalApp(
				{ x64App: x64, arm64App: arm64, outputApp: resolve(x64, "../bad.app") },
				exec as never,
			),
		).toThrow("input Mach-O architecture mismatch");
	});

	it("ignores signature metadata and compares common Mach-O without signatures", () => {
		const { x64, arm64 } = fixture();
		const binary = "Contents/MacOS/naia-shell";
		for (const [app, signature] of [[x64, "one"], [arm64, "two"]] as const) {
			writeFileSync(resolve(app, binary), `payload|${signature}`);
			for (const dir of ["Contents/_CodeSignature", "Contents/Frameworks/F.framework/_CodeSignature"]) {
				mkdirSync(resolve(app, dir), { recursive: true });
				writeFileSync(resolve(app, dir, "CodeResources"), signature);
			}
		}
		writeFileSync(resolve(x64, "Contents/CodeResources"), "legacy signature");
		const output = resolve(x64, "../signed.app");
		const exec = (command: string, args: string[]) => {
			if (command === "file") return Buffer.from(args[1].endsWith("naia-shell") ? "Mach-O" : "data");
			if (command === "lipo") return Buffer.from("x86_64 arm64");
			if (command === "codesign") {
				const file = args[1];
				writeFileSync(file, readFileSync(file, "utf8").split("|")[0]);
				return Buffer.alloc(0);
			}
			throw new Error(`unexpected ${command}`);
		};
		assembleUniversalApp({ x64App: x64, arm64App: arm64, outputApp: output }, exec as never);
		expect(existsSync(resolve(output, "Contents/_CodeSignature"))).toBe(false);
		expect(existsSync(resolve(output, "Contents/Frameworks/F.framework/_CodeSignature"))).toBe(false);
		expect(existsSync(resolve(output, "Contents/CodeResources"))).toBe(false);
		expect(readFileSync(resolve(output, binary), "utf8")).toBe("payload|two");
		writeFileSync(resolve(x64, binary), "different|one");
		expect(() => assembleUniversalApp({ x64App: x64, arm64App: arm64, outputApp: output }, exec as never)).toThrow("common Mach-O differs");
	});

	it("rejects divergent common Mach-O files with identical architecture lists", () => {
		const { x64, arm64 } = fixture();
		writeFileSync(resolve(x64, "Contents/MacOS/naia-shell"), "universal-a");
		writeFileSync(resolve(arm64, "Contents/MacOS/naia-shell"), "universal-b");
		const exec = (command: string, args: string[]) => {
			if (command === "file")
				return Buffer.from(
					portablePath(args[1] ?? "").endsWith("Contents/MacOS/naia-shell")
						? "Mach-O"
						: "data",
				);
			if (command === "lipo" && args[0] === "-archs")
				return Buffer.from("x86_64 arm64");
			if (command === "codesign") {
				throw Object.assign(new Error("unsigned"), { stderr: "code object is not signed at all" });
			}
			throw new Error("unexpected command");
		};
		expect(() =>
			assembleUniversalApp(
				{ x64App: x64, arm64App: arm64, outputApp: resolve(x64, "../bad.app") },
				exec as never,
			),
		).toThrow("common Mach-O differs");
	});

	it("rejects a one-sided scoped Mach-O that is Universal instead of matching thin", () => {
		const { x64, arm64 } = fixture();
		const payload = resolve(
			x64,
			"Contents/Resources/agent/node_modules/vendor-darwin-x64/native.node",
		);
		mkdirSync(resolve(payload, ".."), { recursive: true });
		writeFileSync(payload, "fat");
		const exec = (command: string, args: string[]) => {
			if (command === "file")
				return Buffer.from(
					args[1]?.endsWith("native.node") ? "Mach-O" : "data",
				);
			if (command === "lipo" && args[0] === "-archs")
				return Buffer.from("x86_64 arm64");
			throw new Error("unexpected command");
		};
		expect(() =>
			assembleUniversalApp(
				{ x64App: x64, arm64App: arm64, outputApp: resolve(x64, "../bad.app") },
				exec as never,
			),
		).toThrow("scoped Mach-O must be matching thin");
	});

	it("prunes pnpm install-state metadata instead of failing the neutral-byte contract", () => {
		const { x64, arm64 } = fixture();
		writeFileSync(resolve(x64, "Contents/MacOS/naia-shell"), "x86_64");
		writeFileSync(resolve(arm64, "Contents/MacOS/naia-shell"), "arm64");
		for (const [app, body] of [
			[x64, "state-x64"],
			[arm64, "state-arm64"],
		] as const) {
			mkdirSync(resolve(app, "Contents/Resources/agent/node_modules/.pnpm"), {
				recursive: true,
			});
			writeFileSync(
				resolve(app, "Contents/Resources/agent/node_modules/.modules.yaml"),
				body,
			);
			writeFileSync(
				resolve(
					app,
					"Contents/Resources/agent/node_modules/.pnpm-workspace-state-v1.json",
				),
				body,
			);
			writeFileSync(
				resolve(app, "Contents/Resources/agent/node_modules/.pnpm/lock.yaml"),
				body,
			);
		}
		const output = resolve(x64, "../universal-pnpm.app");
		const exec = (command: string, args: string[]) => {
			if (command === "file")
				return Buffer.from(
					portablePath(args[1] ?? "").endsWith("Contents/MacOS/naia-shell")
						? "Mach-O 64-bit executable"
						: "data",
				);
			if (command === "lipo" && args[0] === "-archs")
				return Buffer.from(readFileSync(args[1], "utf8"));
			if (command === "lipo" && args[0] === "-create") {
				writeFileSync(args[2], "x86_64 arm64");
				return Buffer.alloc(0);
			}
			throw new Error(`unexpected ${command}`);
		};
		const result = assembleUniversalApp(
			{ x64App: x64, arm64App: arm64, outputApp: output },
			exec as never,
		);
		expect(result.merged).toBe(1);
		expect(
			existsSync(resolve(output, "Contents/Resources/agent/node_modules/.modules.yaml")),
		).toBe(false);
		expect(
			existsSync(
				resolve(
					output,
					"Contents/Resources/agent/node_modules/.pnpm-workspace-state-v1.json",
				),
			),
		).toBe(false);
		expect(
			existsSync(resolve(output, "Contents/Resources/agent/node_modules/.pnpm/lock.yaml")),
		).toBe(false);
	});
});
