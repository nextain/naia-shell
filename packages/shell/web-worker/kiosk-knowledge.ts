/** Same knowledge executor as desktop; only its storage backend changes. */
import { makeKnowledgeSkillsExecutor } from "@naia-agent/adapters/knowledge-skill.js";
import type { ToolExecutorPort } from "@naia-agent/ports/uc1.js";
import { createOpfsWebFs } from "../src/lib/web-runtime/web-fs";
import { readKioskKnowledgeService } from "../src/lib/kiosk-demo/knowledge";

export function makeKioskKnowledgeTools(base: ToolExecutorPort) {
	const fs = createOpfsWebFs(() => navigator.storage.getDirectory());
	let service: Awaited<ReturnType<typeof readKioskKnowledgeService>> = null;
	const knowledge = makeKnowledgeSkillsExecutor({
		backend: {
			search: async (query, k) => (service ? service.search(query, k) : []),
			ask: async (query) =>
				service
					? service.ask(query)
					: {
							abstained: true,
							answer: "공개 지식 근거를 찾지 못했습니다.",
							sources: [],
						},
		},
	});
	return {
		async refresh() {
			service = await readKioskKnowledgeService(fs);
		},
		executor: {
			specs: () => [...base.specs(), ...knowledge.specs()],
			execute: (call, opts) =>
				knowledge.specs().some((spec) => spec.name === call.name)
					? knowledge.execute(call, opts)
					: base.execute(call, opts),
		} satisfies ToolExecutorPort,
	};
}
