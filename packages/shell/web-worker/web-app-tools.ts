import {
	type MemoStore,
	makeBuiltinSkillsExecutor,
} from "@naia-agent/adapters/builtin-skills.js";
import { makeCompositeToolExecutor } from "@naia-agent/adapters/composite-tool-executor.js";
import { makeOpenMeteoFetchWeather } from "@naia-agent/adapters/openmeteo-weather.js";
import type { ToolExecutorPort } from "@naia-agent/ports/uc1.js";
import type { OpfsDirectoryHandleLike } from "./opfs-read-fs";

/**
 * Web registration of the app's own model-facing tools (get_time, get_weather, memo_*).
 * Same module, tool names and argument shapes as the app agent
 * (`adapters/builtin-skills.ts`); only the MemoStore backend differs
 * (OPFS file instead of the app's file-memo-store). get_weather is the app's
 * builtin too, fed by the app's own open-meteo fetcher
 * (`adapters/openmeteo-weather.ts`, see compose-agent-deps.mjs).
 */
export const WEB_APP_TOOL_NAMES = [
	"get_time",
	"get_weather",
	"memo_list",
	"memo_get",
	"memo_save",
] as const;

const WEB_APP_TOOL_SET = new Set<string>(WEB_APP_TOOL_NAMES);

export const WEB_PC_ONLY_NOTICE =
	"현재 앱에서는 되고 웹버전 통합 진행중입니다.";

/**
 * Model-facing tools of the app that need a local process / OS API (PC-only)
 * or a not-yet-integrated backend. Not listed in specs(); if the model calls
 * one anyway, answer with the single notice above.
 */
export const WEB_NOT_YET_TOOL_NAMES: ReadonlySet<string> = new Set([
	"skill_memory_recall",
	"skill_memory_save",
	"skill_knowledge_search",
	"skill_knowledge_ask",
	"skill_knowledge_scope",
	"skill_knowledge_graph",
	"skill_knowledge_store",
	"skill_browser_navigate",
	"skill_browser_back",
	"skill_browser_forward",
	"skill_browser_reload",
	"skill_browser_click",
	"skill_browser_fill",
	"skill_browser_scroll",
	"skill_browser_press",
	"skill_browser_snapshot",
	"skill_browser_get_text",
	"skill_browser_eval",
	"skill_tab_screenshot",
	"skill_workspace_get_sessions",
	"skill_workspace_open_file",
	"skill_workspace_get_open_file",
	"skill_workspace_edit_open_file",
	"skill_workspace_close_file",
	"skill_workspace_set_surface",
	"skill_workspace_focus_space",
	"skill_workspace_terminal_exec",
	"skill_workspace_get_terminal_output",
	"delegate_agent",
]);

export const WEB_MEMO_FILE = "naia-memos.json";

interface OpfsWritableLike {
	write(data: string): Promise<void>;
	close(): Promise<void>;
}
interface OpfsRootLike extends OpfsDirectoryHandleLike {
	getFileHandle(
		name: string,
		opts?: { create?: boolean },
	): Promise<
		Awaited<ReturnType<OpfsDirectoryHandleLike["getFileHandle"]>> & {
			createWritable?: () => Promise<OpfsWritableLike>;
		}
	>;
}

/**
 * MemoStore (same interface the app uses) backed by one OPFS JSON file.
 * The interface is synchronous, so the map is the source of truth and writes
 * are queued; `ready` resolves once the stored memos have been loaded.
 */
export function makeOpfsMemoStore(getRoot: () => Promise<OpfsRootLike>): {
	store: MemoStore;
	ready: Promise<void>;
} {
	const m = new Map<string, string>();
	const ready = (async () => {
		try {
			const root = await getRoot();
			const file = await (await root.getFileHandle(WEB_MEMO_FILE)).getFile();
			const parsed: unknown = JSON.parse(await file.text());
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
					if (typeof v === "string") m.set(k, v);
			}
		} catch {
			// no file yet / unreadable → start empty (same degrade as the app store)
		}
	})();
	let queue: Promise<void> = Promise.resolve();
	const persist = () => {
		const body = JSON.stringify(Object.fromEntries(m));
		queue = queue
			.then(async () => {
				const root = await getRoot();
				const handle = await root.getFileHandle(WEB_MEMO_FILE, {
					create: true,
				});
				if (!handle.createWritable) return;
				const w = await handle.createWritable();
				await w.write(body);
				await w.close();
			})
			.catch(() => {});
	};
	return {
		ready,
		store: {
			save: (t, c) => {
				m.set(t, c);
				persist();
			},
			list: () => [...m.keys()],
			get: (t) => m.get(t) ?? null,
		},
	};
}

/** Wrap `base` with get_time / memo_* and the PC-only notice. Not for kiosk. */
export function withWebAppTools(
	base: ToolExecutorPort,
	deps: {
		getRoot: () => Promise<OpfsRootLike>;
		clock?: () => Date;
	},
): ToolExecutorPort {
	const { store, ready } = makeOpfsMemoStore(deps.getRoot);
	const builtin = makeBuiltinSkillsExecutor({
		clock: deps.clock ?? (() => new Date()),
		fetchWeather: makeOpenMeteoFetchWeather(),
		memo: store,
	});
	const app: ToolExecutorPort = {
		specs: () => builtin.specs().filter((s) => WEB_APP_TOOL_SET.has(s.name)),
		execute: async (call, opts) => {
			await ready;
			return builtin.execute(call, opts);
		},
	};
	const composite = makeCompositeToolExecutor([base, app]);
	return {
		specs: () => composite.specs(),
		execute: async (call, opts) =>
			WEB_NOT_YET_TOOL_NAMES.has(call.name)
				? { output: WEB_PC_ONLY_NOTICE }
				: composite.execute(call, opts),
	};
}

export const WEB_WEATHER_TOOL_NAME = "get_weather";

/** The app's get_weather alone (builtin-skills + open-meteo), for the kiosk tool set. */
export function makeWebWeatherExecutor(): ToolExecutorPort {
	const builtin = makeBuiltinSkillsExecutor({
		clock: () => new Date(),
		fetchWeather: makeOpenMeteoFetchWeather(),
	});
	return {
		specs: () => builtin.specs().filter((s) => s.name === WEB_WEATHER_TOOL_NAME),
		execute: (call, opts) => builtin.execute(call, opts),
	};
}

export const WEB_TIME_TOOL_NAME = "get_time";

/** The app's get_time alone (builtin-skills clock), for the kiosk tool set. */
export function makeWebTimeExecutor(): ToolExecutorPort {
	const builtin = makeBuiltinSkillsExecutor({
		clock: () => new Date(),
	});
	return {
		specs: () => builtin.specs().filter((s) => s.name === WEB_TIME_TOOL_NAME),
		execute: (call, opts) => builtin.execute(call, opts),
	};
}
