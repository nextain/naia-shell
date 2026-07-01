import { invoke } from "@tauri-apps/api/core";
import type React from "react";
import type { BehaviorEntry, BehaviorFilter } from "./behavior-log";
import { logBehavior, queryBehavior } from "./behavior-log";
import { getSecretKey, saveSecretKey } from "./secure-store";

export type { BehaviorEntry, BehaviorFilter };

// ??? Context ????????????????????????????????????????????????????????????????

/**
 * Structured context an app pushes to Naia.
 * Each app type defines its own payload shape via the `data` field.
 */
export interface AppContext {
	/** App type identifier; matches AppDescriptor.id */
	type: string;
	/** App-specific payload (arbitrary JSON) */
	data: Record<string, unknown>;
}

// ??? Tools ??????????????????????????????????????????????????????????????????

/**
 * A tool Naia (LLM) can call while this app is active.
 *
 * Serializable descriptor sent to the Agent as a proxy stub.
 * Actual execution happens in the Shell via NaiaContextBridge.onToolCall.
 *
 * name must have "skill_" prefix (e.g. "skill_browse_navigate").
 */
export interface NaiaTool {
	/** Unique skill name with skill_ prefix, e.g. "skill_browse_navigate" */
	name: string;
	description: string;
	/** JSON Schema for parameters */
	parameters?: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
	};
	/** Permission tier (0=auto, 1=notify, 2=confirm, 3=block). Default 1. */
	tier?: number;
}

/** Handler invoked when Naia calls an app tool. Returns a result string or void. */
export type ToolHandler = (
	args: Record<string, unknown>,
) => Promise<string | undefined> | string | undefined;

export interface ShellResult {
	stdout: string;
	stderr: string;
	code: number;
}

// ??? Bridge ?????????????????????????????????????????????????????????????????

/**
 * Narrow bridge between an app and Naia.
 * Panels interact with Naia only through this interface ??never via direct imports.
 *
 * Built-in TypeScript apps receive this bridge directly as a prop.
 * Installed (iframe) panels communicate via postMessage through iframe-bridge.ts.
 */
export interface NaiaContextBridge {
	/** Push updated context to Naia's next message system prompt. */
	pushContext(ctx: AppContext): void;
	/**
	 * Register a handler for a tool Naia may call.
	 * toolName must match NaiaTool.name (with skill_ prefix).
	 * Returns an unsubscribe function.
	 */
	onToolCall(toolName: string, handler: ToolHandler): () => void;

	/** Log a behavior event. Stored in Shell WebView IndexedDB (30-day retention). */
	logBehavior(event: string, data?: Record<string, unknown>): Promise<void>;

	/**
	 * Query behavior log for this app's events.
	 * Returns newest-first.
	 */
	queryBehavior(filter?: BehaviorFilter): Promise<BehaviorEntry[]>;

	/**
	 * Get a secret value stored by this app.
	 * Keys are namespaced per panel ??panels cannot access each other's secrets.
	 */
	getSecret(key: string): Promise<string | null>;

	/** Set a secret value for this app. */
	setSecret(key: string, value: string): Promise<void>;

	/**
	 * Read a file from disk. Restricted to the user's HOME directory.
	 * Returns file contents as a UTF-8 string.
	 */
	readFile(path: string): Promise<string>;

	/**
	 * Run an allowlisted shell command.
	 * The Shell enforces an allowlist on the Rust side ??unknown commands are rejected.
	 */
	runShell(cmd: string, args?: string[]): Promise<ShellResult>;
}

/** No-op bridge used as placeholder until a real bridge is wired. */
export class NoopContextBridge implements NaiaContextBridge {
	pushContext(_ctx: AppContext): void {}
	onToolCall(_toolName: string, _handler: ToolHandler): () => void {
		return () => {};
	}
	logBehavior(_event: string, _data?: Record<string, unknown>): Promise<void> {
		return Promise.resolve();
	}
	queryBehavior(_filter?: BehaviorFilter): Promise<BehaviorEntry[]> {
		return Promise.resolve([]);
	}
	getSecret(_key: string): Promise<string | null> {
		return Promise.resolve(null);
	}
	setSecret(_key: string, _value: string): Promise<void> {
		return Promise.resolve();
	}
	readFile(_path: string): Promise<string> {
		return Promise.resolve("");
	}
	runShell(_cmd: string, _args?: string[]): Promise<ShellResult> {
		return Promise.resolve({ stdout: "", stderr: "", code: 0 });
	}
}

/**
 * Real bridge: forwards pushContext ??panel store (so Naia's system prompt
 * picks it up), and routes onToolCall registrations for app tool execution.
 *
 * App tools execute in the Shell (WebView). When the Agent receives a
 * app tool call from the LLM, it forwards it here via callTool().
 *
 * appId is required for key namespacing in getSecret/setSecret/logBehavior.
 */
export class ActiveAppBridge implements NaiaContextBridge {
	private handlers = new Map<string, ToolHandler>();

	constructor(private readonly appId: string = "__builtin__") {}

	pushContext(ctx: AppContext): void {
		// Dynamic import avoids circular dep (stores/panel ??panel-registry ??stores/panel)
		import("../stores/app").then(({ useAppStore }) => {
			useAppStore.getState().setActiveAppContext(ctx);
		});
	}

	onToolCall(toolName: string, handler: ToolHandler): () => void {
		this.handlers.set(toolName, handler);
		return () => {
			this.handlers.delete(toolName);
		};
	}

	/** Called when Agent forwards a app tool call from the LLM. */
	async callTool(
		toolName: string,
		args: Record<string, unknown>,
	): Promise<string> {
		const handler = this.handlers.get(toolName);
		if (!handler) return `No handler registered for tool: ${toolName}`;
		const result = await handler(args);
		return result ?? "ok";
	}

	logBehavior(event: string, data?: Record<string, unknown>): Promise<void> {
		return logBehavior(this.appId, event, data);
	}

	queryBehavior(filter?: BehaviorFilter): Promise<BehaviorEntry[]> {
		return queryBehavior({ ...filter, appId: this.appId });
	}

	getSecret(key: string): Promise<string | null> {
		return getSecretKey(`app:${this.appId}:${key}`);
	}

	setSecret(key: string, value: string): Promise<void> {
		return saveSecretKey(`app:${this.appId}:${key}`, value);
	}

	readFile(path: string): Promise<string> {
		return invoke<string>("app_read_file", { path });
	}

	runShell(cmd: string, args?: string[]): Promise<ShellResult> {
		return invoke<ShellResult>("app_run_shell", { cmd, args: args ?? [] });
	}
}

// ??? App Props ?????????????????????????????????????????????????????????????

export interface AppCenterProps {
	naia: NaiaContextBridge;
}

// ??? Descriptor ??????????????????????????????????????????????????????????????

// ??? App API ???????????????????????????????????????????????????????????????

/**
 * Built-in apps expose a versioned API for other apps to call without
 * importing internal component modules.
 *
 * Registered via `appRegistry.updateApi(id, api)` when the app mounts,
 * cleared when it unmounts. Callers use `appRegistry.getApi<T>(id)`.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentionally open API contract
export type AppApi = Record<string, (...args: any[]) => unknown>;

/** Full description of an app. Register via `appRegistry.register()`. */
export interface AppDescriptor {
	/** Unique identifier, e.g. "avatar", "browser", "issues" */
	id: string;
	/** Human-readable name shown in AppBar */
	name: string;
	/** Localized names (locale ??label). Falls back to `name` if locale not found. */
	names?: Record<string, string>;
	/** Optional icon ??emoji string (e.g. "?뱷") */
	icon?: string;
	/** Inline SVG content loaded from the panel's icon file. Takes priority over `icon`. */
	iconSvg?: string;
	/** Absolute path to index.html ??if set, panel renders via iframe (asset protocol). */
	htmlEntry?: string;
	/**
	 * Built-in panels (browser, workspace) cannot be deleted by the user.
	 * Installed panels (~/.naia/apps/) should omit this or set false.
	 */
	builtIn?: boolean;
	/**
	 * Keep-alive: panel is always mounted, shown/hidden via CSS opacity.
	 * Native-embed panels (e.g. browser via X11 XReparentWindow) can also use
	 * keepAlive:true when paired with explicit IPC hide/show commands ??CSS
	 * opacity alone cannot hide native windows, but IPC commands can.
	 * Defaults to true for builtIn panels.
	 */
	keepAlive?: boolean;
	/**
	 * "installed" ??loaded from ~/.naia/apps/ at runtime.
	 * Omit or "code" for panels bundled in the shell's source.
	 * AppBar uses this to decide whether to also delete from disk on remove.
	 */
	source?: "installed" | "code";
	/** Center component ??owns the entire right area layout. */
	center: React.ComponentType<AppCenterProps>;
	/**
	 * Tools Naia can call while this panel is active.
	 * Sent to the Agent as proxy stubs; handlers registered via NaiaContextBridge.onToolCall.
	 */
	tools?: NaiaTool[];
	/** Current panel context snapshot for Naia */
	getContext?: () => AppContext;
	/** Called when this panel becomes active */
	onActivate?: () => void;
	/** Called when this panel is deactivated */
	onDeactivate?: () => void;
	/**
	 * Programmatic API exposed to other panels.
	 * Set/cleared by the panel component via `appRegistry.updateApi()`.
	 * Typed via `appRegistry.getApi<MyAppApi>(id)`.
	 */
	api?: AppApi;
}

// ??? Registry ????????????????????????????????????????????????????????????????

class AppRegistryImpl {
	private apps = new Map<string, AppDescriptor>();

	register(app: AppDescriptor): void {
		this.apps.set(app.id, app);
	}

	unregister(id: string): void {
		this.apps.delete(id);
	}

	get(id: string): AppDescriptor | undefined {
		return this.apps.get(id);
	}

	list(): AppDescriptor[] {
		return Array.from(this.apps.values());
	}

	/**
	 * Get the live API exposed by a panel.
	 * Returns undefined if the panel is not registered or has no API mounted.
	 *
	 * @example
	 * const api = appRegistry.getApi<WorkspaceAppApi>("workspace");
	 * api?.openFile("/path/to/file.ts");
	 */
	getApi<T extends AppApi = AppApi>(id: string): T | undefined {
		return this.apps.get(id)?.api as T | undefined;
	}

	/**
	 * Set (or clear) the live API for a panel.
	 * Called by the panel component on mount/unmount.
	 */
	updateApi(id: string, api: AppApi | undefined): void {
		const app = this.apps.get(id);
		if (app) app.api = api;
	}
}

/** Module-level singleton. Import and call `.register()` from each panel module. */
export const appRegistry = new AppRegistryImpl();
