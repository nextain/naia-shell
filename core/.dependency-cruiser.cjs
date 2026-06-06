/**
 * Architecture gate: enforce hexagonal dependency direction (adapters → ports → domain).
 * Run: pnpm arch. A violation is an ERROR (CI red). @see README.md
 */
module.exports = {
	forbidden: [
		{
			name: "domain-stays-pure",
			severity: "error",
			comment: "domain/ is the innermost layer — it must not import ports/ or adapters/.",
			from: { path: "^src/domain", pathNot: "__tests__|\\.(test|spec)\\.ts$" },
			to: { path: "^src/(ports|adapters)" },
		},
		{
			name: "ports-no-adapters",
			severity: "error",
			comment: "ports/ is the boundary — it must not import adapters/. Tests are exempt (they verify adapters against the port contract).",
			from: { path: "^src/ports", pathNot: "__tests__|\\.(test|spec)\\.ts$" },
			to: { path: "^src/adapters" },
		},
		{
			name: "no-orphans",
			severity: "error",
			comment: "Every production module must be reachable — no orphan files (slop ③). Tests/type-decls exempt.",
			from: { orphan: true, pathNot: "__tests__|\\.(test|spec)\\.ts$|\\.d\\.ts$" },
			to: {},
		},
	],
	options: {
		doNotFollow: { path: "node_modules" },
		tsPreCompilationDeps: true,
		tsConfig: { fileName: "tsconfig.json" },
	},
};
