/**
 * Vitest setup — fix Node >= 22 native localStorage conflict with jsdom.
 *
 * Node >= 22 exposes a native `globalThis.localStorage` getter that returns
 * a non-spec stub (no `setItem`, `getItem`, `clear`, etc.).
 *
 * Vitest's `populateGlobal()` only overrides keys already in its hardcoded
 * KEYS list. `localStorage` is not in that list, so when it already exists
 * on `globalThis` (Node 22+), vitest skips it — leaving the broken native
 * stub in place instead of jsdom's spec-compliant Web Storage.
 *
 * Fix: create a fresh JSDOM and copy its Storage to globalThis.
 */

const ls = globalThis.localStorage;
if (
	typeof ls?.setItem !== "function" &&
	typeof globalThis.document !== "undefined"
) {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { JSDOM } = require("jsdom");
		const dom = new JSDOM("", { url: "http://localhost" });

		Object.defineProperty(globalThis, "localStorage", {
			value: dom.window.localStorage,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(globalThis, "sessionStorage", {
			value: dom.window.sessionStorage,
			writable: true,
			configurable: true,
		});
	} catch {
		// Not in jsdom environment — skip
	}
}

/**
 * Polyfill DOMMatrix for jsdom.
 *
 * pdfjs-dist (used by react-pdf) references DOMMatrix at import time.
 * jsdom does not implement DOMMatrix, so we provide a minimal stub.
 */
if (typeof globalThis.DOMMatrix === "undefined") {
	// @ts-expect-error — minimal stub sufficient for pdfjs-dist init
	globalThis.DOMMatrix = class DOMMatrix {
		constructor() {
			// biome-ignore lint/correctness/noConstructorReturn: DOMMatrix polyfill needs to return augmented this
			return Object.assign(this, {
				a: 1,
				b: 0,
				c: 0,
				d: 1,
				e: 0,
				f: 0,
				m11: 1,
				m12: 0,
				m13: 0,
				m14: 0,
				m21: 0,
				m22: 1,
				m23: 0,
				m24: 0,
				m31: 0,
				m32: 0,
				m33: 1,
				m34: 0,
				m41: 0,
				m42: 0,
				m43: 0,
				m44: 1,
				is2D: true,
				isIdentity: true,
			});
		}
		static fromMatrix() {
			return new DOMMatrix();
		}
		static fromFloat32Array() {
			return new DOMMatrix();
		}
		static fromFloat64Array() {
			return new DOMMatrix();
		}
	};
}

/**
 * Polyfill window.matchMedia for jsdom.
 *
 * jsdom does not implement matchMedia. Several components (theme detection,
 * responsive layouts) call window.matchMedia at render time.
 */
if (typeof globalThis.window !== "undefined" && !globalThis.window.matchMedia) {
	globalThis.window.matchMedia = (query: string) =>
		({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}) as MediaQueryList;
}
