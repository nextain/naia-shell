import { config as codexConfig } from "./wdio.conf.codex.js";
import { transformRequest } from "./node26-request.js";

// Explicit opt-in: this scenario performs one real Codex parent turn and one
// workspace-bound Codex child run. Keeping it out of the default Codex suite
// prevents routine builds and CI from consuming model quota.
export const config = {
	...codexConfig,
	// After the spread so the shared Node 26 fix (node26-request.ts) is the
	// one in effect, not a copy inherited from the base config.
	transformRequest,
	specs: ["./specs/98-codex-chat-delegation.spec.ts"],
	mochaOpts: { ui: "bdd", timeout: 420_000 },
};
