// @testing-library/jest-dom matchers — TYPE augmentation only.
//
// vitest.setup.ts registers the matchers at RUNTIME via `expect.extend(matchers)`
// (it deliberately avoids `import "@testing-library/jest-dom/vitest"` because two
// vitest versions are installed and that entry's runtime `import {expect} from
// "vitest"` would extend the wrong instance). That runtime path gives no compile
// types, so `tsc` did not know about toBeInTheDocument/toHaveAttribute/etc and the
// build (`tsc -b`) failed on test files. This file restores the types without any
// runtime side effect (a .d.ts emits nothing), mirroring jest-dom's own vitest.d.ts.
import "vitest";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
	interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
	interface AsymmetricMatchersContaining
		extends TestingLibraryMatchers<any, any> {}
}
