/**
 * Shared Tauri IPC mock fallback for Playwright e2e specs.
 *
 * Each spec defines its own `TAURI_MOCK_SCRIPT` with scenario-specific
 * behavior; on Linux many specs were missing base IPC handlers (plugin store,
 * window, audio enumeration, workspace defaults), which made the app fail to
 * mount or partially render. Injecting this script after the spec's mock
 * adds safe defaults for any cmd the spec hasn't handled.
 *
 * Spec mocks register `window.__TAURI_INTERNALS__.invoke = <fn>` themselves.
 * We wrap that fn so spec-specific handlers still take precedence, and the
 * fallback runs only when the spec returns `undefined` for an unmocked cmd.
 *
 * Also seeds `localStorage["naia-adk-path"]` so the ADK setup wizard does
 * not block app mount.
 */
export const TAURI_BASE_MOCK_FALLBACK = `
(function() {
	var existing = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
	if (!existing) return;
	window.__TAURI_INTERNALS__.invoke = async function(cmd, args) {
		var r = await existing(cmd, args);
		if (r !== undefined) return r;
		// Plugin store
		if (cmd === "plugin:store|load") return 1;
		if (cmd === "plugin:store|get") return [null, false];
		if (cmd === "plugin:store|set" || cmd === "plugin:store|delete" || cmd === "plugin:store|save" || cmd === "plugin:store|has" || cmd === "plugin:store|entries") return null;
		// Plugin window/app/updater
		if (cmd === "plugin:window|show" || cmd === "plugin:window|inner_size" || cmd === "plugin:window|get_cursor_position" || cmd === "plugin:window|start_resize_dragging") return null;
		if (cmd === "plugin:app|version") return "0.1.3";
		if (cmd === "plugin:updater|check") return null;
		if (cmd === "plugin:dialog|open" || cmd === "plugin:dialog|save" || cmd === "plugin:dialog|message" || cmd === "plugin:dialog|ask" || cmd === "plugin:dialog|confirm") return null;
		if (cmd === "plugin:opener|open_url" || cmd === "plugin:opener|open_path") return null;
		if (cmd === "plugin:deep-link|get_current") return [];
		if (cmd === "plugin:process|exit" || cmd === "plugin:process|restart") return null;
		// Common Rust commands
		if (cmd === "frontend_log") return null;
		if (cmd === "get_log_path") return "/tmp/naia-e2e.log";
		if (cmd === "get_window_state") return { width: 1280, height: 800, x: 0, y: 0 };
		if (cmd === "save_window_state") return null;
		if (cmd === "init_audit_db" || cmd === "init_memory_db") return null;
		if (cmd === "query_events" || cmd === "get_all_facts") return [];
		if (cmd === "upsert_fact") return null;
		if (cmd === "check_gateway_health") return false;
		if (cmd === "restart_gateway") return null;
		if (cmd === "sync_gateway_config") return null;
		if (cmd === "sync_openclaw_config") return null;
		// Lists
		if (cmd === "list_skills" || cmd === "list_stt_models" || cmd === "list_audio_output_devices" || cmd === "list_audio_input_devices" || cmd === "list_naia_assets") return [];
		// Naia/ADK
		if (cmd === "read_naia_config") return null;
		// Panels
		if (cmd === "panel_list_installed") return [];
		// Memory
		if (cmd === "memory_get_all_facts" || cmd === "read_openclaw_memory_files") return [];
		// Workspace
		if (cmd === "workspace_list_dirs" || cmd === "workspace_get_sessions" || cmd === "workspace_classify_dirs" || cmd === "workspace_discover_skills") return [];
		// workspace_set_root returns the canonical root string — echo input so resolvedRoot stays a string
		if (cmd === "workspace_set_root") return (args && args.root) || "";
		if (cmd === "workspace_load_project_index" || cmd === "workspace_get_progress" || cmd === "workspace_start_watch" || cmd === "workspace_stop_watch") return null;
		if (cmd === "workspace_get_git_info") return { branch: "main" };
		if (cmd === "workspace_read_file" || cmd === "workspace_read_skill_content") return "";
		if (cmd === "workspace_detect_adk_root") return null;
		// Browser / browser embed
		if (cmd === "browser_check" || cmd === "browser_wv_hide" || cmd === "browser_wv_show" || cmd === "browser_embed_show" || cmd === "browser_embed_close") return null;
		// Progress
		if (cmd === "get_progress_data") return { events: [], stats: { totalCost: 0, messageCount: 0, toolCount: 0, errorCount: 0 } };
		return undefined;
	};
})();
`;

/** Inline localStorage seeding to bypass the ADK setup wizard. */
export const SEED_ADK_PATH = `
localStorage.setItem("naia-adk-path", "/tmp/mock-naia-adk-workspace");
`;
