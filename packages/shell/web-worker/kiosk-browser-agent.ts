import { makePortLineIO } from "@naia-agent/adapters/port-line-io.js";
import {
	makeStdioEgress,
	makeStdioIngress,
} from "@naia-agent/adapters/stdio.js";
import type { startBrowserAgent } from "@naia-agent/composition/browser-agent.js";
import { wireAgentUC1 } from "@naia-agent/composition/uc1-wiring.js";
import { createKioskMemory } from "../src/lib/kiosk-demo/memory";

/** Same desktop handler and memory tools, with an OPFS MemoryPort. */
export function startKioskBrowserAgent(
	opts: Parameters<typeof startBrowserAgent>[0],
) {
	const io = makePortLineIO(opts.port);
	opts.diag.debug?.("KioskMemory.start", { storage: "OPFS" });
	const agent = wireAgentUC1({
		...opts,
		ingress: makeStdioIngress(io),
		egress: makeStdioEgress(io),
		memory: createKioskMemory(undefined, opts.diag),
	});
	agent.start?.();
}
