import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateConf } from "../stage-runtime.mjs";

const SHELL = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT_PATH = resolve(SHELL, "scripts/sign-windows-binary.ps1");
const MATRIX_PATH = resolve(SHELL, "src-tauri/platform-matrix.json");
const SYSTEM_VCRUNTIME = process.env.SystemRoot
	? `${process.env.SystemRoot}\\System32\\vcruntime140.dll`
	: "C:\\Windows\\System32\\vcruntime140.dll";

describe("sign-windows-binary (#725)", () => {
	it("sign-windows-binary.ps1 exists in packages/shell/scripts", () => {
		expect(existsSync(SCRIPT_PATH)).toBe(true);
	});

	it("win32 conf includes signCommand, linux and darwin do not", () => {
		const matrix = JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
		const winConf = generateConf(matrix, "win32");
		expect(winConf.bundle.windows).toBeDefined();
		expect(winConf.bundle.windows.signCommand).toEqual({
			cmd: "powershell",
			args: [
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				"../scripts/sign-windows-binary.ps1",
				"%1",
			],
		});
		const scriptArg = winConf.bundle.windows.signCommand.args[4];
		expect(scriptArg).toBe("../scripts/sign-windows-binary.ps1");
		expect(existsSync(resolve(SHELL, "src-tauri", scriptArg))).toBe(true);

		const linuxConf = generateConf(matrix, "linux");
		expect(linuxConf.bundle.windows).toBeUndefined();

		const darwinConf = generateConf(matrix, "darwin");
		expect(darwinConf.bundle.windows).toBeUndefined();
	});

	it("sign-windows-binary.ps1 replaces signatures and does not contain AppendSignature $true", () => {
		const script = readFileSync(SCRIPT_PATH, "utf8");
		expect(script).not.toContain("AppendSignature $true");
	});

	describe.skipIf(process.platform !== "win32")("PowerShell execution", () => {
		it("sign-windows-binary.ps1 exits 0 and does nothing when NAIA_WINDOWS_SIGN is not '1'", () => {
			// Run powershell to execute the script against this test file itself
			const output = execFileSync(
				"powershell",
				[
					"-NoProfile",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					SCRIPT_PATH,
					fileURLToPath(import.meta.url),
				],
				{
					encoding: "utf8",
					env: {
						...process.env,
						NAIA_WINDOWS_SIGN: "",
					},
				},
			);
			expect(output).toContain("NAIA_WINDOWS_SIGN is not enabled");
		});

		it.skipIf(!existsSync(SYSTEM_VCRUNTIME))(
			"sign-windows-binary.ps1 skips known third-party binaries even if NAIA_WINDOWS_SIGN is '1'",
			() => {
				const output = execFileSync(
					"powershell",
					[
						"-NoProfile",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						SCRIPT_PATH,
						SYSTEM_VCRUNTIME,
					],
					{
						encoding: "utf8",
						env: {
							...process.env,
							NAIA_WINDOWS_SIGN: "1",
						},
					},
				);
				expect(output).toContain("Skipping known third-party binary");
			},
		);

		it("sign-windows-binary.ps1 throws when target file does not exist", () => {
			expect(() => {
				execFileSync(
					"powershell",
					[
						"-NoProfile",
						"-ExecutionPolicy",
						"Bypass",
						"-File",
						SCRIPT_PATH,
						"non_existent_dummy_binary.exe",
					],
					{
						encoding: "utf8",
						env: {
							...process.env,
							NAIA_WINDOWS_SIGN: "1",
						},
						stdio: "pipe",
					},
				);
			}).toThrow();
		});
	});
});
