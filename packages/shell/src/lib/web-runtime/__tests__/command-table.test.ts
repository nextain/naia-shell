import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { COMMAND_TABLE, STUB_RESPONSES } from "../command-table";
import { routeCommand } from "../router";

function unwrap(node: ts.Node): ts.Node {
	let curr = node;
	while (curr) {
		if (
			ts.isParenthesizedExpression(curr) ||
			ts.isTypeAssertionExpression(curr) ||
			ts.isAsExpression(curr) ||
			ts.isNonNullExpression(curr)
		) {
			curr = curr.expression;
		} else {
			break;
		}
	}
	return curr;
}

function getLine(sourceFile: ts.SourceFile, node: ts.Node): number {
	const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
	return line + 1;
}

interface ExtractionResult {
	commands: Set<string>;
	uninterpretable: string[];
	directInvokeCallCount: number;
}

interface TopLevelObject {
	isConst: boolean;
	values: string[];
}

interface InvokeBindingCheck {
	isInvoke: boolean;
	isDirect: boolean;
}

function extractFromSource(
	sourceFile: ts.SourceFile,
	filePath = "snippet.ts",
): ExtractionResult {
	const directInvokeIdentifiers = new Set<string>();
	const coreNamespaceIdentifiers = new Set<string>();
	const topLevelObjects = new Map<string, TopLevelObject>();
	const wrappedFunctions = new Map<string, string>(); // fnName -> paramName

	// 1. Static imports & Top-level objects
	for (const stmt of sourceFile.statements) {
		if (ts.isImportDeclaration(stmt)) {
			const moduleSpecifier = unwrap(stmt.moduleSpecifier);
			if (
				ts.isStringLiteral(moduleSpecifier) &&
				moduleSpecifier.text === "@tauri-apps/api/core"
			) {
				const importClause = stmt.importClause;
				if (importClause?.namedBindings) {
					if (ts.isNamedImports(importClause.namedBindings)) {
						for (const elem of importClause.namedBindings.elements) {
							const imported = elem.propertyName
								? elem.propertyName.text
								: elem.name.text;
							if (imported === "invoke") {
								directInvokeIdentifiers.add(elem.name.text);
							}
						}
					} else if (ts.isNamespaceImport(importClause.namedBindings)) {
						coreNamespaceIdentifiers.add(importClause.namedBindings.name.text);
					}
				}
			}
		} else if (ts.isVariableStatement(stmt)) {
			const isConst = Boolean(stmt.declarationList.flags & ts.NodeFlags.Const);
			for (const decl of stmt.declarationList.declarations) {
				if (ts.isIdentifier(decl.name) && decl.initializer) {
					const init = unwrap(decl.initializer);
					if (ts.isObjectLiteralExpression(init)) {
						const values: string[] = [];
						for (const prop of init.properties) {
							if (ts.isPropertyAssignment(prop)) {
								const val = unwrap(prop.initializer);
								if (
									ts.isStringLiteral(val) ||
									ts.isNoSubstitutionTemplateLiteral(val)
								) {
									values.push(val.text);
								}
							}
						}
						topLevelObjects.set(decl.name.text, { isConst, values });
					}
				}
			}
		}
	}

	// 2. Dynamic imports
	function scanDynamicImports(node: ts.Node) {
		if (ts.isVariableDeclaration(node) && node.initializer) {
			let init = unwrap(node.initializer);
			if (ts.isAwaitExpression(init)) {
				init = unwrap(init.expression);
			}
			if (ts.isCallExpression(init)) {
				const callExpr = unwrap(init.expression);
				if (callExpr.kind === ts.SyntaxKind.ImportKeyword) {
					const arg0 = unwrap(init.arguments[0]);
					if (
						arg0 &&
						(ts.isStringLiteral(arg0) ||
							ts.isNoSubstitutionTemplateLiteral(arg0)) &&
						arg0.text === "@tauri-apps/api/core"
					) {
						if (ts.isObjectBindingPattern(node.name)) {
							for (const elem of node.name.elements) {
								const prop = elem.propertyName
									? ts.isIdentifier(elem.propertyName)
										? elem.propertyName.text
										: ""
									: ts.isIdentifier(elem.name)
										? elem.name.text
										: "";
								const local = ts.isIdentifier(elem.name) ? elem.name.text : "";
								if (prop === "invoke" && local) {
									directInvokeIdentifiers.add(local);
								}
							}
						} else if (ts.isIdentifier(node.name)) {
							coreNamespaceIdentifiers.add(node.name.text);
						}
					}
				}
			}
		}
		ts.forEachChild(node, scanDynamicImports);
	}
	scanDynamicImports(sourceFile);

	// Unified invoke binding check
	function isInvoke(
		expr: ts.Node,
		activeParamBindings?: Set<string>,
	): InvokeBindingCheck {
		const unwrapped = unwrap(expr);
		if (ts.isIdentifier(unwrapped)) {
			if (directInvokeIdentifiers.has(unwrapped.text)) {
				return { isInvoke: true, isDirect: true };
			}
			if (wrappedFunctions.has(unwrapped.text)) {
				return { isInvoke: true, isDirect: false };
			}
			if (activeParamBindings?.has(unwrapped.text)) {
				return { isInvoke: true, isDirect: false };
			}
		} else if (ts.isPropertyAccessExpression(unwrapped)) {
			const parentExpr = unwrap(unwrapped.expression);
			if (
				ts.isIdentifier(parentExpr) &&
				coreNamespaceIdentifiers.has(parentExpr.text) &&
				unwrapped.name.text === "invoke"
			) {
				return { isInvoke: true, isDirect: true };
			}
		}
		return { isInvoke: false, isDirect: false };
	}

	// 3. Detect wrapped functions
	function checkWrapper(fnName: string, firstParamName: string, body: ts.Node) {
		if (!firstParamName || !body) return;
		let found = false;
		function walkBody(node: ts.Node) {
			if (found) return;
			if (ts.isCallExpression(node)) {
				const check = isInvoke(node.expression);
				if (check.isInvoke) {
					const firstArg = node.arguments[0] ? unwrap(node.arguments[0]) : null;
					if (
						firstArg &&
						ts.isIdentifier(firstArg) &&
						firstArg.text === firstParamName
					) {
						found = true;
						return;
					}
				}
			}
			ts.forEachChild(node, walkBody);
		}
		walkBody(body);
		if (found) {
			wrappedFunctions.set(fnName, firstParamName);
		}
	}

	for (const stmt of sourceFile.statements) {
		if (
			ts.isFunctionDeclaration(stmt) &&
			stmt.name &&
			stmt.parameters.length > 0 &&
			stmt.body
		) {
			const p0 = stmt.parameters[0].name;
			if (ts.isIdentifier(p0)) {
				checkWrapper(stmt.name.text, p0.text, stmt.body);
			}
		} else if (ts.isVariableStatement(stmt)) {
			for (const decl of stmt.declarationList.declarations) {
				if (ts.isIdentifier(decl.name) && decl.initializer) {
					const init = unwrap(decl.initializer);
					if (
						(ts.isArrowFunction(init) || ts.isFunctionExpression(init)) &&
						init.parameters.length > 0
					) {
						const p0 = init.parameters[0].name;
						if (ts.isIdentifier(p0) && init.body) {
							checkWrapper(decl.name.text, p0.text, init.body);
						}
					}
				}
			}
		}
	}

	const commands = new Set<string>();
	const uninterpretable: string[] = [];
	let directInvokeCallCount = 0;

	function resolveFirstArg(
		firstArgNode: ts.Node,
		enclosingFn: ts.SignatureDeclaration | null,
		callNode: ts.CallExpression,
	): void {
		const arg = unwrap(firstArgNode);
		// 1. 문자열 상수나 치환 없는 템플릿이면 그 값
		if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
			commands.add(arg.text);
			return;
		}

		if (ts.isIdentifier(arg)) {
			const idName = arg.text;

			// 2. 같은 함수 매개변수이고 타입이 문자열 리터럴 합집합이면 그 리터럴들
			if (enclosingFn) {
				for (const param of enclosingFn.parameters) {
					if (
						ts.isIdentifier(param.name) &&
						param.name.text === idName &&
						param.type
					) {
						if (ts.isUnionTypeNode(param.type)) {
							let allLiterals = true;
							const lits: string[] = [];
							for (const elem of param.type.types) {
								if (
									ts.isLiteralTypeNode(elem) &&
									(ts.isStringLiteral(elem.literal) ||
										ts.isNoSubstitutionTemplateLiteral(elem.literal))
								) {
									lits.push(elem.literal.text);
								} else {
									allLiterals = false;
								}
							}
							if (allLiterals && lits.length > 0) {
								for (const lit of lits) commands.add(lit);
								return;
							}
						} else if (
							ts.isLiteralTypeNode(param.type) &&
							(ts.isStringLiteral(param.type.literal) ||
								ts.isNoSubstitutionTemplateLiteral(param.type.literal))
						) {
							commands.add(param.type.literal.text);
							return;
						}
					}
				}
			}

			// 3. const 지역 변수이고 초기값이 OBJ[...] 이며 OBJ 가 같은 파일의 최상위 const 객체 리터럴이면 그 객체의 문자열 값 전부
			let curr: ts.Node | undefined = callNode;
			let varDecl: ts.VariableDeclaration | null = null;
			let isVarConst = false;
			while (curr && curr !== sourceFile) {
				if (
					ts.isBlock(curr) ||
					ts.isSourceFile(curr) ||
					ts.isFunctionDeclaration(curr) ||
					ts.isFunctionExpression(curr) ||
					ts.isArrowFunction(curr)
				) {
					const stmts =
						ts.isBlock(curr) || ts.isSourceFile(curr)
							? curr.statements
							: curr.body && ts.isBlock(curr.body)
								? curr.body.statements
								: [];
					for (const s of stmts) {
						if (ts.isVariableStatement(s)) {
							for (const d of s.declarationList.declarations) {
								if (ts.isIdentifier(d.name) && d.name.text === idName) {
									varDecl = d;
									isVarConst = Boolean(
										s.declarationList.flags & ts.NodeFlags.Const,
									);
									break;
								}
							}
						}
						if (varDecl) break;
					}
				}
				if (varDecl) break;
				curr = curr.parent;
			}

			if (varDecl?.initializer) {
				const init = unwrap(varDecl.initializer);
				if (ts.isElementAccessExpression(init)) {
					const objExpr = unwrap(init.expression);
					if (
						ts.isIdentifier(objExpr) &&
						topLevelObjects.has(objExpr.text)
					) {
						const topObj = topLevelObjects.get(objExpr.text)!;
						if (isVarConst && topObj.isConst) {
							for (const v of topObj.values) commands.add(v);
							return;
						} else {
							uninterpretable.push(
								`${filePath}:${getLine(sourceFile, callNode)}`,
							);
							return;
						}
					}
				}
			}

			// 4. 감싼 함수 안에서 매개변수를 그대로 넘기는 자리는 해석 대상에서 뺀다
			if (enclosingFn) {
				let fnName: string | null = null;
				if (ts.isFunctionDeclaration(enclosingFn) && enclosingFn.name) {
					fnName = enclosingFn.name.text;
				} else if (
					enclosingFn.parent &&
					ts.isVariableDeclaration(enclosingFn.parent) &&
					ts.isIdentifier(enclosingFn.parent.name)
				) {
					fnName = enclosingFn.parent.name.text;
				}
				if (
					fnName &&
					wrappedFunctions.has(fnName) &&
					wrappedFunctions.get(fnName) === idName
				) {
					return;
				}
			}
		}

		// 5. 그 밖은 해석 불가 명령
		uninterpretable.push(`${filePath}:${getLine(sourceFile, callNode)}`);
	}

	function visit(
		node: ts.Node,
		enclosingFn: ts.SignatureDeclaration | null,
		activeParamBindings: Set<string>,
	) {
		let nextEnclosingFn = enclosingFn;
		let nextParamBindings = activeParamBindings;

		if (
			ts.isFunctionDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isArrowFunction(node) ||
			ts.isMethodDeclaration(node)
		) {
			nextEnclosingFn = node;
			let newParams: Set<string> | null = null;
			for (const p of node.parameters) {
				if (p.initializer && ts.isIdentifier(p.name)) {
					const check = isInvoke(p.initializer, activeParamBindings);
					if (check.isInvoke) {
						if (!newParams) newParams = new Set(activeParamBindings);
						newParams.add(p.name.text);
					}
				}
			}
			if (newParams) nextParamBindings = newParams;
		}

		if (ts.isCallExpression(node)) {
			const check = isInvoke(node.expression, nextParamBindings);
			if (check.isInvoke) {
				if (check.isDirect) directInvokeCallCount++;
				if (node.arguments.length > 0) {
					resolveFirstArg(node.arguments[0], nextEnclosingFn, node);
				} else {
					uninterpretable.push(`${filePath}:${getLine(sourceFile, node)}`);
				}
			}
		}

		ts.forEachChild(node, (child) =>
			visit(child, nextEnclosingFn, nextParamBindings),
		);
	}

	visit(sourceFile, null, new Set());

	return { commands, uninterpretable, directInvokeCallCount };
}

function collectSourceFiles(dir: string, fileList: string[] = []): string[] {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "__tests__") {
				continue;
			}
			collectSourceFiles(fullPath, fileList);
		} else if (
			entry.isFile() &&
			(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
		) {
			if (entry.name.includes(".test.") || entry.name.includes(".spec.")) {
				continue;
			}
			fileList.push(fullPath);
		}
	}
	return fileList;
}

describe("command-table", () => {
	it("contains all invoke commands extracted from shell source in the table", () => {
		const srcDir = path.resolve(__dirname, "../../..");
		const sourceFiles = collectSourceFiles(srcDir);
		const allExtracted = new Set<string>();
		const allUninterpretable: string[] = [];
		let totalDirectInvokeCount = 0;
		const egoCommands = new Set<string>();

		for (const file of sourceFiles) {
			const content = fs.readFileSync(file, "utf-8");
			const relPath = path.relative(srcDir, file);
			const sourceFile = ts.createSourceFile(
				file,
				content,
				ts.ScriptTarget.Latest,
				true,
			);
			const result = extractFromSource(sourceFile, relPath);
			totalDirectInvokeCount += result.directInvokeCallCount;
			for (const cmd of result.commands) {
				allExtracted.add(cmd);
			}
			for (const un of result.uninterpretable) {
				allUninterpretable.push(un);
			}
			if (relPath.includes("ego-browser-env-ipc")) {
				for (const cmd of result.commands) {
					egoCommands.add(cmd);
				}
			}
		}

		expect(
			allUninterpretable,
			`Uninterpretable invoke calls: ${allUninterpretable.join(", ")}`,
		).toEqual([]);
		expect(totalDirectInvokeCount).toBe(220);
		expect(egoCommands.size).toBe(22);
		expect(allExtracted.size).toBeGreaterThanOrEqual(100);

		const missing: string[] = [];
		for (const cmd of allExtracted) {
			if (!(cmd in COMMAND_TABLE)) {
				missing.push(cmd);
			}
		}

		expect(
			missing,
			`Missing commands in command table: ${missing.join(", ")}`,
		).toEqual([]);
	});

	it("has exactly 11 keys classified as 'web'", () => {
		const webKeys = Object.entries(COMMAND_TABLE)
			.filter(([_, value]) => value === "web")
			.map(([key]) => key)
			.sort();

		expect(webKeys).toEqual([
			"cancel_stream",
			"plugin:event|emit",
			"plugin:event|listen",
			"plugin:event|unlisten",
			"read_naia_config",
			"read_naia_ui_config",
			"reload_agent_settings",
			"send_to_agent_command",
			"write_naia_config",
			"write_naia_path_cache",
			"write_naia_ui_config",
		]);
	});

	it("classifies secure_store_get as stub returning null", async () => {
		expect(COMMAND_TABLE.secure_store_get).toBe("stub");
		expect(STUB_RESPONSES.secure_store_get).toBeNull();
		await expect(routeCommand("secure_store_get")).resolves.toBeNull();
	});

	it("classifies secure_store_set and secure_store_delete as desktop-only", async () => {
		expect(COMMAND_TABLE.secure_store_set).toBe("desktop-only");
		expect(COMMAND_TABLE.secure_store_delete).toBe("desktop-only");
		await expect(routeCommand("secure_store_set")).rejects.toThrow(
			"desktop_only:secure_store_set",
		);
	});

	describe("AST extraction snippet tests", () => {
		function runSnippet(code: string): ExtractionResult {
			const sf = ts.createSourceFile(
				"snippet.ts",
				code,
				ts.ScriptTarget.Latest,
				true,
			);
			return extractFromSource(sf, "snippet.ts");
		}

		it("extracts single-line call", () => {
			const res = runSnippet(
				'import { invoke } from "@tauri-apps/api/core"; invoke("cmd1");',
			);
			expect(Array.from(res.commands)).toEqual(["cmd1"]);
			expect(res.uninterpretable).toEqual([]);
		});

		it("extracts multi-line call", () => {
			const res = runSnippet(
				'import { invoke } from "@tauri-apps/api/core"; invoke(\n  "a",\n  {}\n);',
			);
			expect(Array.from(res.commands)).toEqual(["a"]);
			expect(res.uninterpretable).toEqual([]);
		});

		it("extracts call with type argument invoke<T>()", () => {
			const res = runSnippet(
				'import { invoke } from "@tauri-apps/api/core"; invoke<string | null>(\n "b");',
			);
			expect(Array.from(res.commands)).toEqual(["b"]);
			expect(res.uninterpretable).toEqual([]);
		});

		it("extracts await invoke() call", () => {
			const res = runSnippet(
				'import { invoke } from "@tauri-apps/api/core"; async function f() { await invoke("c"); }',
			);
			expect(Array.from(res.commands)).toEqual(["c"]);
			expect(res.uninterpretable).toEqual([]);
		});

		it("reports variable argument as uninterpretable (1 error)", () => {
			const res = runSnippet(
				'import { invoke } from "@tauri-apps/api/core"; invoke(name);',
			);
			expect(res.commands.size).toBe(0);
			expect(res.uninterpretable.length).toBe(1);
		});

		it("ignores invoke call in comments (0 commands)", () => {
			const res = runSnippet(
				'import { invoke } from "@tauri-apps/api/core";\n// invoke("d")\n/* invoke("d") */',
			);
			expect(res.commands.size).toBe(0);
			expect(res.uninterpretable).toEqual([]);
		});

		it("ignores invoke inside string literal (0 commands)", () => {
			const res = runSnippet(
				'import { invoke } from "@tauri-apps/api/core"; const s = \'invoke("e")\';',
			);
			expect(res.commands.size).toBe(0);
			expect(res.uninterpretable).toEqual([]);
		});

		it("extracts aliased import: import { invoke as X }", () => {
			const res = runSnippet(
				'import { invoke as X } from "@tauri-apps/api/core"; X("f");',
			);
			expect(Array.from(res.commands)).toEqual(["f"]);
			expect(res.uninterpretable).toEqual([]);
		});

		it("extracts namespace import: import * as core", () => {
			const res = runSnippet(
				'import * as core from "@tauri-apps/api/core"; core.invoke("g");',
			);
			expect(Array.from(res.commands)).toEqual(["g"]);
			expect(res.uninterpretable).toEqual([]);
		});

		it("extracts dynamic import destructuring: const { invoke } = await import()", () => {
			const res = runSnippet(
				'async function f() { const { invoke } = await import("@tauri-apps/api/core"); invoke("h"); }',
			);
			expect(Array.from(res.commands)).toEqual(["h"]);
			expect(res.uninterpretable).toEqual([]);
		});

		it("extracts string literal union parameter", () => {
			const res = runSnippet(
				'import { invoke } from "@tauri-apps/api/core"; const f = (c: "i" | "j") => invoke(c);',
			);
			expect(Array.from(res.commands).sort()).toEqual(["i", "j"]);
			expect(res.uninterpretable).toEqual([]);
		});

		it("extracts wrapped function and default parameter binding", () => {
			const res = runSnippet(
				'import { invoke } from "@tauri-apps/api/core"; const OPS = { a: "m", b: "n" }; function w(c: string) { return invoke(c); } function api(r: string, call = w) { call("k"); const cmd = OPS[r]; call(cmd); }',
			);
			expect(Array.from(res.commands).sort()).toEqual(["k", "m", "n"]);
			expect(res.uninterpretable).toEqual([]);
		});

		it("ignores invoke call when core is not imported (0 commands)", () => {
			const res = runSnippet('invoke("z");');
			expect(res.commands.size).toBe(0);
			expect(res.uninterpretable).toEqual([]);
		});

		it("extracts namespace invoke binding in default parameter: api(call = core.invoke)", () => {
			const res = runSnippet(
				'import * as core from "@tauri-apps/api/core"; function api(call = core.invoke) { call("p"); }',
			);
			expect(Array.from(res.commands)).toEqual(["p"]);
			expect(res.uninterpretable).toEqual([]);
		});

		it("extracts namespace invoke in wrapped function passed to default parameter: api(call = w)", () => {
			const res = runSnippet(
				'import * as core from "@tauri-apps/api/core"; function w(c: string) { return core.invoke(c); } function api(call = w) { call("q"); }',
			);
			expect(Array.from(res.commands)).toEqual(["q"]);
			expect(res.uninterpretable).toEqual([]);
		});

		it("reports uninterpretable when local variable is not const: let cmd = OPS[x]", () => {
			const res = runSnippet(
				'import { invoke } from "@tauri-apps/api/core"; const OPS = { a: "r" }; function f(x: string) { let cmd = OPS[x]; invoke(cmd); }',
			);
			expect(res.commands.size).toBe(0);
			expect(res.uninterpretable.length).toBe(1);
		});

		it("reports uninterpretable when top-level object is not const: let OPS = { a: \"s\" }", () => {
			const res = runSnippet(
				'import { invoke } from "@tauri-apps/api/core"; let OPS = { a: "s" }; function f(x: string) { const cmd = OPS[x]; invoke(cmd); }',
			);
			expect(res.commands.size).toBe(0);
			expect(res.uninterpretable.length).toBe(1);
		});

		it("extracts all commands when both local variable and top-level object are const", () => {
			const res = runSnippet(
				'import { invoke } from "@tauri-apps/api/core"; const OPS = { a: "t", b: "u" }; function f(x: string) { const cmd = OPS[x]; invoke(cmd); }',
			);
			expect(Array.from(res.commands).sort()).toEqual(["t", "u"]);
			expect(res.uninterpretable).toEqual([]);
		});
	});
});
