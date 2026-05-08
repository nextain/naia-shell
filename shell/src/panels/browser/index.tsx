import { TAB_SKILL_DESCRIPTORS } from "../../lib/tab-skills";
import { panelRegistry } from "../../lib/panel-registry";
import { BrowserCenterPanel } from "./BrowserCenterPanel";

panelRegistry.register({
	id: "browser",
	name: "인터넷",
	names: { ko: "인터넷", en: "Internet" },
	icon: "🌐",
	builtIn: true,
	keepAlive: true, // visibility controlled by browser_wv_hide/show on panel switch
	center: BrowserCenterPanel,
	tools: [
		// ── Navigation ──────────────────────────────────────────────────────
		{
			name: "skill_browser_navigate",
			description:
				"Navigate the browser to a URL. Use this when the user asks you to open, visit, or go to a website.",
			parameters: {
				type: "object",
				properties: {
					url: {
						type: "string",
						description: "The URL to navigate to (e.g. https://naver.com)",
					},
				},
				required: ["url"],
			},
			tier: 0,
		},
		{
			name: "skill_browser_back",
			description: "Navigate back to the previous page in the browser history.",
			parameters: { type: "object", properties: {} },
			tier: 0,
		},
		{
			name: "skill_browser_forward",
			description: "Navigate forward to the next page in the browser history.",
			parameters: { type: "object", properties: {} },
			tier: 0,
		},
		{
			name: "skill_browser_reload",
			description: "Reload / refresh the current page.",
			parameters: { type: "object", properties: {} },
			tier: 0,
		},
		// ── Interaction ─────────────────────────────────────────────────────
		{
			name: "skill_browser_click",
			description:
				"Click an element in the browser. Use the @ref ID from a snapshot (e.g. @e3). Use skill_browser_snapshot first to find the right element.",
			parameters: {
				type: "object",
				properties: {
					ref: {
						type: "string",
						description:
							"Element @ref from snapshot (e.g. @e3) or a CSS selector",
					},
				},
				required: ["ref"],
			},
			tier: 0,
		},
		{
			name: "skill_browser_fill",
			description:
				"Clear and fill a text input in the browser. Use the @ref ID from a snapshot. Replaces existing text.",
			parameters: {
				type: "object",
				properties: {
					ref: {
						type: "string",
						description: "Input element @ref from snapshot (e.g. @e5)",
					},
					text: {
						type: "string",
						description: "Text to type into the input",
					},
				},
				required: ["ref", "text"],
			},
			tier: 0,
		},
		{
			name: "skill_browser_scroll",
			description:
				"Scroll the current page. Useful for loading more content or reaching an element that's off-screen.",
			parameters: {
				type: "object",
				properties: {
					direction: {
						type: "string",
						description: "Scroll direction: up, down, left, right",
						enum: ["up", "down", "left", "right"],
					},
					pixels: {
						type: "number",
						description: "Number of pixels to scroll (default 300)",
					},
				},
				required: ["direction"],
			},
			tier: 0,
		},
		{
			name: "skill_browser_press",
			description:
				"Press a keyboard key in the browser. Useful for submitting forms (Enter), navigating (Tab, ArrowDown), or shortcuts (Control+a).",
			parameters: {
				type: "object",
				properties: {
					key: {
						type: "string",
						description:
							"Key to press, e.g. Enter, Tab, Escape, Control+a, ArrowDown, F5",
					},
				},
				required: ["key"],
			},
			tier: 0,
		},
		// ── Reading ─────────────────────────────────────────────────────────
		{
			name: "skill_browser_snapshot",
			description:
				"Get an accessibility tree snapshot of the current browser page. Returns interactive elements with @ref IDs you can use for click and fill commands. Use this to read page content or find elements before interacting.",
			parameters: { type: "object", properties: {} },
			tier: 0,
		},
		{
			name: "skill_browser_get_text",
			description:
				"Get the visible text from an element or the whole page body. Pass a @ref from snapshot for a specific element, or leave empty for the full page.",
			parameters: {
				type: "object",
				properties: {
					ref: {
						type: "string",
						description:
							"Element @ref from snapshot, or empty for full page text",
					},
				},
			},
			tier: 0,
		},
		// ── Tab skills (common to all panels) ───────────────────────────────
		...TAB_SKILL_DESCRIPTORS,
		// ── Advanced ────────────────────────────────────────────────────────
		{
			name: "skill_browser_eval",
			description:
				"Execute JavaScript in the current page and return the result. Use with caution — disabled by default. Useful for extracting data or interacting with the page programmatically.",
			parameters: {
				type: "object",
				properties: {
					js: {
						type: "string",
						description: "JavaScript code to evaluate (e.g. document.title)",
					},
				},
				required: ["js"],
			},
			tier: 0,
		},
	],
});
