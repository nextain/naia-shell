import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { linuxBundleEnv } from "../stage-runtime.mjs";

describe("Linux Vosk dependency discovery", () => {
	it("preserves parent search paths without adding an empty current-directory entry", () => {
		expect(
			linuxBundleEnv("linux", "/staged resources", {
				LD_LIBRARY_PATH: "/custom/lib",
			}),
		).toEqual({ LD_LIBRARY_PATH: "/staged resources:/custom/lib" });
		expect(linuxBundleEnv("linux", "/staged", {})).toEqual({
			LD_LIBRARY_PATH: "/staged",
		});
		expect(linuxBundleEnv("win32", "/staged", {})).toEqual({});
		expect(linuxBundleEnv("darwin", "/staged", {})).toEqual({});
	});
	it.skipIf(process.platform !== "linux")(
		"resolves a real ELF DT_NEEDED libvosk.so for both prod and dev",
		() => {
			const root = mkdtempSync(join(tmpdir(), "r15-vosk-"));
			const resources = join(root, "resources with spaces");
			mkdirSync(resources);
			try {
				writeFileSync(
					join(root, "vosk.c"),
					"int vosk_probe(void) { return 0; }",
				);
				writeFileSync(
					join(root, "main.c"),
					"int vosk_probe(void); int main(void) { return vosk_probe(); }",
				);
				execFileSync("gcc", [
					"-shared",
					"-fPIC",
					join(root, "vosk.c"),
					"-Wl,-soname,libvosk.so",
					"-o",
					join(resources, "libvosk.so"),
				]);
				const binary = join(root, "naia-shell");
				execFileSync("gcc", [
					join(root, "main.c"),
					"-L" + resources,
					"-lvosk",
					"-o",
					binary,
				]);
				const env = { ...process.env, LD_LIBRARY_PATH: "" };
				expect(
					execFileSync("ldd", [binary], { env, encoding: "utf8" }),
				).toContain("libvosk.so => not found");
				for (const instance of ["prod", "dev"]) {
					const bundledEnv = {
						...env,
						NAIA_INSTALLER_INSTANCE: instance,
						...linuxBundleEnv("linux", resources, env),
					};
					const dependencies = execFileSync("ldd", [binary], {
						env: bundledEnv,
						encoding: "utf8",
					});
					expect(dependencies).toContain(
						`libvosk.so => ${resources}/libvosk.so`,
					);
					expect(dependencies).not.toContain("not found");
					execFileSync(binary, [], { env: bundledEnv });
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
