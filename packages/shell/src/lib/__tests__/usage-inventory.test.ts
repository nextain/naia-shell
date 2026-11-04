import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { usageControlAliases } from "../usage-control-aliases";
import { usageControls } from "../usage-inventory";

it("anchors every fixed native control to an allowlisted name and the planning table", () => {
	const seen = new Set<string>();
	const missing: string[] = [];
	function walk(dir: string) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!entry.name.includes("test")) walk(path);
				continue;
			}
			if (!path.endsWith(".tsx") || path.endsWith(".test.tsx")) continue;
			// Consent controls intentionally never pass through passive click collection.
			if (entry.name === "UsageConsentGate.tsx") continue;
			const source = ts.createSourceFile(
				path,
				readFileSync(path, "utf8"),
				ts.ScriptTarget.Latest,
				true,
				ts.ScriptKind.TSX,
			);
			function visit(node: ts.Node) {
				if (
					(ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
					/^[a-z]/.test(node.tagName.getText(source))
				) {
					const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
					const usage = attrs.find(
						(a) => a.name.getText(source) === "data-usage-event",
					);
					if (usage?.initializer && ts.isStringLiteral(usage.initializer)) {
						const name = usage.initializer.text;
						seen.add(name);
						expect(usageControls).toHaveProperty(name);
					}
					const handler = attrs.find((a) =>
						["onClick", "onChange", "onSubmit", "onContextMenu"].includes(
							a.name.getText(source),
						),
					);
					if (handler) {
						const type = attrs.find(
							(a) => a.name.getText(source) === "type",
						)?.initializer;
						const choice =
							node.tagName.getText(source) === "select" ||
							(type &&
								ts.isStringLiteral(type) &&
								["checkbox", "radio"].includes(type.text));
						if (
							(handler.name.getText(source) !== "onChange" || choice) &&
							!usage
						)
							missing.push(
								`${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
							);
					}
				}
				ts.forEachChild(node, visit);
			}
			visit(source);
		}
	}
	walk("src/components");
	walk("src/apps");
	// Root-level shell controls also belong to the public UI contract.
	for (const file of ["src/App.tsx", "src/studio-nva-apply-root.tsx"]) {
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(/data-usage-event="([^"]+)"/g)) {
			seen.add(match[1]);
			expect(usageControls).toHaveProperty(match[1]);
		}
	}
	for (const name of Object.keys(usageControlAliases))
		expect(
			seen.has(name),
			`semantic alias has no actual control: ${name}`,
		).toBe(true);
	expect(missing).toEqual([]);
	expect([...seen].sort()).toEqual(Object.keys(usageControls).sort());
	const table = readFileSync(
		"../../docs/progress/usage-events/event-inventory.md",
		"utf8",
	);
	for (const name of seen) expect(table).toContain(`\`${name}\``);
	expect(seen.size).toBeGreaterThan(400);
});
