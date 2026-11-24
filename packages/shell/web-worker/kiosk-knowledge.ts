/** Same knowledge executor as desktop; only its storage backend changes. */
import { makeKnowledgeSkillsExecutor } from "@naia-agent/adapters/knowledge-skill.js";
import type { ToolExecutorPort } from "@naia-agent/ports/uc1.js";
import { createOpfsWebFs } from "../src/lib/web-runtime/web-fs";
import { readKioskKnowledgeService } from "../src/lib/kiosk-demo/knowledge";
import type { ActiveSlideRequestContext } from "./adk-snapshot-fs";

function buildActiveSlideHit(slide: ActiveSlideRequestContext) {
	const snippet = [slide.title, slide.script].filter(Boolean).join(" ");
	return {
		title: slide.title,
		snippet,
		score: 1,
		sourceUris: [`opfs://naia-adk/${slide.source}`],
	};
}

export function makeKioskKnowledgeTools(base: ToolExecutorPort) {
	const fs = createOpfsWebFs(() => navigator.storage.getDirectory());
	let service: Awaited<ReturnType<typeof readKioskKnowledgeService>> = null;
	let currentSlide: ActiveSlideRequestContext | null = null;
	const isRestrictedSlide = () =>
		Boolean(currentSlide && currentSlide.restrictToSlide !== false);
	const knowledge = makeKnowledgeSkillsExecutor({
		backend: {
			search: async (query, k) => {
				if (isRestrictedSlide() && currentSlide) {
					return [buildActiveSlideHit(currentSlide)];
				}
				return service ? service.search(query, k) : [];
			},
			ask: async (query) => {
				if (isRestrictedSlide() && currentSlide) {
					const hit = buildActiveSlideHit(currentSlide);
					return {
						abstained: false,
						answer: hit.snippet,
						sources: [{ title: hit.title, sourceUris: hit.sourceUris }],
					};
				}
				return service
					? service.ask(query)
					: {
							abstained: true,
							answer: "공개 지식 근거를 찾지 못했습니다.",
							sources: [],
						};
			},
		},
	});
	return {
		async refresh(activeSlide?: ActiveSlideRequestContext | null) {
			currentSlide = activeSlide ?? null;
			service = await readKioskKnowledgeService(fs);
		},
		executor: {
			specs: () => [...base.specs(), ...knowledge.specs()],
			execute: async (call, opts) => {
				if (knowledge.specs().some((spec) => spec.name === call.name)) {
					return knowledge.execute(call, opts);
				}
				if (isRestrictedSlide() && currentSlide && call.name === "read_file") {
					const hit = buildActiveSlideHit(currentSlide);
					return {
						output: JSON.stringify({ abstained: false, hits: [hit] }),
						isError: false,
					};
				}
				const res = await base.execute(call, opts);
				if (res.isError && service && call.name === "read_file") {
					const rawPath =
						typeof (call.args as { path?: unknown })?.path === "string"
							? ((call.args as { path: string }).path ?? "")
							: "";
					const hits = await service.search(rawPath || "넥스테인 나이아", 3);
					if (hits.length > 0) {
						return {
							output: JSON.stringify({ abstained: false, hits }),
							isError: false,
						};
					}
				}
				return res;
			},
		} satisfies ToolExecutorPort,
	};
}
