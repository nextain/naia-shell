import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { installerInstanceConf, resolveInstallerInstance } from "../installer-instance.mjs";
import { naiaLaunchMode, resolveNaiaInstance } from "../../src/lib/naia-instance-urls";

const base = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
describe("installer instance", () => {
  it("defaults to production", () => {
    expect(resolveInstallerInstance()).toEqual(resolveInstallerInstance("prod"));
    expect(installerInstanceConf(base, resolveInstallerInstance())).toEqual({});
  });
  it.each(["prod", "dev"])("pins %s Vite hosts and matches runtime selection", mode => {
    const selected = resolveInstallerInstance(mode);
    const env = selected.env;
    expect(naiaLaunchMode({ useDevGateway: env.VITE_NAIA_USE_DEV_GATEWAY, webBaseUrl: env.VITE_NAIA_WEB_BASE_URL })).toBe(mode);
    expect(env.VITE_NAIA_WEB_BASE_URL).toBe(resolveNaiaInstance(mode).web);
    expect(env.VITE_NAIA_USE_DEV_GATEWAY).toBe(mode === "dev" ? "1" : "0");
    expect(env.VITE_NAIA_DEV_GATEWAY_URL).toBe(mode === "dev" ? resolveNaiaInstance(mode).api : "");
  });
  it.each(["", "DEV", "staging"])("rejects invalid instance %j", mode => {
    expect(() => resolveInstallerInstance(mode)).toThrow("Invalid installer instance");
  });
  it("marks dev product and every window while preserving options and base", () => {
    const before = JSON.stringify(base);
    const conf = installerInstanceConf(base, resolveInstallerInstance("dev"));
    expect(conf.productName).toBe("Naia-dev");
    expect(conf.app.windows).toEqual(base.app.windows.map(window => ({ ...window, title: "Naia-dev" })));
    expect(JSON.stringify(base)).toBe(before);
    // This slice deliberately makes no claim of data isolation.
    expect(conf.identifier).toBeUndefined();
  });
  it("wires dispatch-only dev selection into build and cross-job artifact references", () => {
    const workflow = readFileSync(new URL("../../../../.github/workflows/build-installers.yml", import.meta.url), "utf8");
    expect(workflow).toContain("default: prod\n        options:\n          - prod\n          - dev");
    expect(workflow).toContain("NAIA_INSTALLER_INSTANCE: ${{ github.event_name == 'workflow_dispatch' && inputs.instance == 'dev' && 'dev' || 'prod' }}");
    for (const line of workflow.split("\n").filter(line => line.includes("name: naia-shell"))) {
      expect(line).toContain("inputs.instance == 'dev' && '-dev' || ''");
    }
    expect(workflow).not.toContain("/Naia.app");
    expect(workflow).not.toContain('LOCALAPPDATA "Naia"');
    const staging = readFileSync(new URL("../stage-runtime.mjs", import.meta.url), "utf8");
    expect(staging).toContain("...interactiveLaunchEnv(process.env), ...instance.env");
    expect(staging).toContain("Object.assign(conf, installerInstanceConf(");
  });
});
