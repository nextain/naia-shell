import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { test } from "vitest";
import { getLocale, setLocale, t } from "../i18n";
import type { TranslationKey } from "../locales/keys";

type Site = readonly [
	name: string,
	key: TranslationKey,
	location: string,
	params?: Readonly<Record<string, string>>,
	legacy?: string,
];

// Locations run from the call outwards. Each step names the AST slot that
// consumes the value. JSX steps can use a class, a stable attribute or an action.
const editorButtons = [
	["reload from disk", "ReloadDisk", "editor.button-4.click"],
	["switch to edit title", "SwitchToEdit", "editor.set-view-mode-5.click"],
	["show preview only title", "ShowPreviewOnly", "editor.set-view-mode-6.click"],
	["show editor only title", "ShowEditorOnly", "editor.set-view-mode-7.click"],
	["switch to preview title", "SwitchToPreview", "editor.set-view-mode-8.click"],
	["print title", "Print", "editor.set-view-mode-9.click"],
	["zoom fit title", "ZoomFitTitle", "editor.set-image-zoom-11.click"],
	["zoom original title", "ZoomOriginalTitle", "editor.set-image-zoom-12.click"],
	["zoom out title", "ZoomOut", "editor.set-image-zoom-13.click"],
	["zoom in title", "ZoomIn", "editor.set-image-zoom-14.click"],
] as const;

const workspaceTools = [
	["get_sessions", "wsSessions"],
	["open_file", "wsOpenFile"],
	["get_open_file", "wsGetOpenFile"],
	["edit_open_file", "wsEditOpenFile"],
	["close_file", "wsCloseFile"],
	["set_surface", "wsSetSurface"],
	["focus_space", "wsFocusSpace"],
	["terminal_exec", "wsTermExec"],
	["get_terminal_output", "wsTermOutput"],
] as const;

const browserTools = [
	["create_workspace", "hostToolCreate"],
	["list_workspaces", "hostToolList"],
	["close_workspace", "hostToolCloseWorkspace"],
	["open", "hostToolOpen"],
	["navigate", "hostToolNavigate"],
	["snapshot", "hostToolSnapshot"],
	["click", "hostToolClick"],
	["fill", "hostToolFill"],
	["evaluate", "hostToolEvaluate"],
	["screenshot", "hostToolScreenshot"],
	["close", "hostToolCloseTab"],
	["script", "hostToolScript"],
] as const;

const recoveryHints = [
	["approval missing", "approval-missing", "hostRecApproval"],
	["capability denied", "capability-denied", "hostRecCapability"],
	["timeout", "timeout", "hostRecTimeout"],
	["cancelled", "cancelled", "hostRecCancelled"],
	["disconnected", "disconnected", "hostRecDisconnected"],
	["stale ref", "stale-ref", "hostRecStaleRef"],
	["method denied", "method-denied", "hostRecMethodDenied"],
	["workspace escape", "workspace-escape", "hostRecWorkspaceEscape"],
	["default", null, "hostRecDefault"],
] as const;

const calls: Record<string, readonly Site[]> = {
	"apps/workspace/Editor.tsx": [
		["pdf load failed (read)", "g1b.editorPdfLoadFailed", "arg:setLoadError:0 → callback:e → arg:.catch:0", { error: "String(e)" }, "PDF 로드 실패:"],
		["pdf load failed (document)", "g1b.editorPdfLoadFailed", "arg:setLoadError:0 → callback:err → @onLoadError → Document", { error: "String(err?.message ?? err)" }, "PDF 로드 실패:"],
		["markdown size limit", "g1b.editorMarkdownLimit", 'new:Error:0 → throw → if:typeof size === "number" && size > 5 * 1024 * 1024'],
		["copy path title (load error)", "g1b.editorCopyPath", "@title → button#editor.button-1.click"],
		["copy path title (header)", "g1b.editorCopyPath", "@title → button#editor.button-3.click"],
		["open failed", "g1b.editorOpenFailed", "p → div.workspace-editor__load-error", { error: "loadError" }, "파일을 열 수 없습니다:"],
		...editorButtons.map(([name, key, event]): Site => [name, `g1b.editor${key}`, `@title → button#${event}`]),
		["saving", "settings.saving", "span.workspace-editor__saving → rhs:saving &&", undefined, "저장 중…"],
		["save failed", "g1b.editorSaveFailed", "span.workspace-editor__error → rhs:saveError &&"],
		["read only", "g1b.editorReadOnly", "span.workspace-editor__readonly → rhs:readOnly &&"],
		["edit button", "g1b.editorEdit", "button#editor.set-view-mode-5.click"],
		["preview only button", "g1b.editorPreviewOnly", "button#editor.set-view-mode-6.click"],
		["editor only button", "g1b.editorEditorOnly", "button#editor.set-view-mode-7.click"],
		["preview button", "g1b.editorPreview", "button#editor.set-view-mode-8.click"],
		["playback rate", "g1b.editorPlaybackRate", "label.workspace-editor__media-rate"],
		["zoom fit button label", "g1b.editorZoomFit", "button#editor.set-image-zoom-11.click"],
		["zoom fit indicator", "g1b.editorZoomFit", 'then:imageZoom === "fit" → span.workspace-editor__image-zoom-label'],
		["image loading", "g1b.editorImageLoading", "div.workspace-editor__image-loading → else:imageBlobUrl"],
		["pdf loading", "g1b.editorPdfLoading", "div.workspace-editor__pdf-loading → @loading → Document"],
		["hwp extracting", "g1b.editorHwpExtracting", "div.workspace-editor__hwp-placeholder-text → div.workspace-editor__hwp-placeholder → then:hwpLoading"],
		["hwp unavailable", "g1b.editorHwpUnavailable", "div.workspace-editor__hwp-placeholder-text → div.workspace-editor__hwp-placeholder → else:hwpSidecar !== null"],
		["hwp sidecar hint", "g1b.editorHwpSidecarHint", "div.workspace-editor__hwp-placeholder-hint"],
		["csv empty", "g1b.editorCsvEmpty", "div.workspace-editor__empty-hint → else:csvResult && csvResult.data.length > 0"],
	],
	"apps/workspace/WebWorkspace.tsx": [
		["reverted notice", "g1b.webwsReverted", "arg:setRevertNotice:0 → try → fn:revertToOriginal"],
		["revert failed notice", "g1b.webwsRevertFailed", "arg:setRevertNotice:0 → catch → fn:revertToOriginal"],
		["close explorer label", "g1b.webwsCloseExplorer", "@aria-label → button#web-workspace-tree-collapse"],
		["collapse button", "g1b.webwsCollapse", "button#web-workspace-tree-collapse"],
		["resize explorer label", "g1b.webwsResizeExplorer", "@aria-label → div#web-workspace-resizer"],
		["revert button", "g1b.webwsRevert", "button#web-workspace-revert"],
		["edit hint fallback", "g1b.webwsEditHint", "rhs:revertNotice || → p.web-workspace-edit-hint"],
	],
	"apps/workspace/DocTabBar.tsx": [
		["tab list label", "g1b.docOpenDocs", "@aria-label → div.doc-tab-bar"],
		["empty tabs", "g1b.docEmpty", "span.doc-tab-bar__empty"],
		["ask ai title", "g1b.docAskAiTitle", "@title → button.doc-tab__ask"],
		["ask ai label", "g1b.docAskAiLabel", "@aria-label → button.doc-tab__ask", { name: "basename(path)" }, "AI에게 질의:"],
		["close label", "g1b.docCloseLabel", "@aria-label → button.doc-tab__close", { name: "basename(path)" }, "문서 닫기:"],
	],
	"apps/workspace/MarkdownPreview.tsx": [
		["image error", "g1b.mdImageError", "output.workspace-markdown__image-error → return", { detail: 'alt || src || t("g1b.mdUnknownImage")' }, "이미지를 열 수 없습니다:"],
		["unknown image fallback", "g1b.mdUnknownImage", "rhs:alt || src || → prop:detail → arg:t:1 → output.workspace-markdown__image-error"],
		["image loading", "g1b.mdImageLoading", "output → else:blobUrl → return"],
		["preview label", "g1b.mdPreviewLabel", "@aria-label → article.workspace-editor__preview"],
		["external link", "g1b.mdExternalLink", "then:external → @aria-label → a#markdown-preview.open-url-1.click", { label: "String(children)" }, "(외부 링크)"],
	],
	"apps/workspace/QuickOpen.tsx": [
		["search placeholder", "g1b.qoSearch", "@placeholder → input.quick-open__input"],
		["loading", "g1b.qoLoading", "div.quick-open__empty → rhs:loading &&"],
		["empty", "g1b.qoEmpty", "div.quick-open__empty → rhs:!loading && results.length === 0 && query.trim() &&"],
	],
	"apps/slides/SlidesControls.tsx": [
		["kiosk previous", "g1b.slidesKioskPrev", '@aria-label → button#onAction("previous") → footer.slides-app__controls--kiosk'],
		["kiosk previous label", "g1b.slidesKioskPrev", 'button#onAction("previous") → footer.slides-app__controls--kiosk'],
		["kiosk pause", "g1b.slidesKioskPause", 'then:state.mode === "presenting" → button.slides-app__primary → footer.slides-app__controls--kiosk'],
		["kiosk resume", "g1b.slidesKioskResume", 'then:state.mode === "paused" || state.mode === "answering" → else:state.mode === "presenting" → button.slides-app__primary → footer.slides-app__controls--kiosk'],
		["kiosk next", "g1b.slidesKioskNext", '@aria-label → button#onAction("next") → footer.slides-app__controls--kiosk'],
		["kiosk next label", "g1b.slidesKioskNext", 'button#onAction("next") → footer.slides-app__controls--kiosk'],
		["kiosk stop", "g1b.slidesKioskStop", '@aria-label → button#onAction("stop") → footer.slides-app__controls--kiosk'],
		["kiosk stop label", "g1b.slidesKioskStop", 'button#onAction("stop") → footer.slides-app__controls--kiosk'],
	],
	"apps/generic-installed/GenericInstalledApp.tsx": [
		["not loaded", "g1b.genericNotLoaded", "p.generic-installed-app__msg → div.generic-installed-app"],
		["add index", "g1b.genericAddIndex", "p.generic-installed-app__hint → div.generic-installed-app"],
	],
	"apps/sample-note/SampleNoteCenterArea.tsx": [
		["hint", "g1b.noteHint", "span.sample-note-app__hint → div.sample-note-app__header"],
		["placeholder", "g1b.notePlaceholder", "@placeholder → textarea.sample-note-app__editor"],
	],
	"apps/workspace/index.tsx": workspaceTools.map(([name, key]) => [
		`${name.replaceAll("_", " ")} description`,
		`g1b.${key}`,
		`return → get:description → object:skill_workspace_${name}`,
	]),
	"components/BrowserHostResult.tsx": [
		...recoveryHints.map(([name, code, key]): Site => [
			`${name} hint`, `g1b.${key}`,
			`return → ${code === null ? "default" : `case:"${code}"`} → fn:recoveryHint`,
		]),
		["workspace title", "g1b.hostWorkspaceTitle", "@title → span.browser-host-space"],
		["no workspace", "g1b.hostNoWorkspace", "rhs:card.workspaceId || → span.browser-host-space"],
		["status running", "g1b.hostStatusRunning", 'then:status === "running" || card.status === "pending" → span.browser-host-badge'],
		["status done", "g1b.hostStatusDone", 'then:card.status === "success" → else:status === "running" || card.status === "pending" → span.browser-host-badge'],
		["status refused", "g1b.hostStatusRefused", 'then:card.status === "refused" → else:card.status === "success" → else:status === "running" || card.status === "pending" → span.browser-host-badge'],
		["status error", "chat.error", 'else:card.status === "refused" → else:card.status === "success" → else:status === "running" || card.status === "pending" → span.browser-host-badge', undefined, "오류"],
		["progress", "g1b.hostProgress", 'output.browser-host-progress → rhs:status === "running" &&'],
		["address label", "g1b.hostAddrLabel", "dt → evidence:evidence.url → dl.browser-host-evidence"],
		["revision", "g1b.hostRevisionLabel", "span.browser-host-revision → dd.browser-host-url", { revision: "evidence.urlRevision" }, "개정"],
		["snapshot label", "g1b.hostSnapshotLabel", "dt → evidence:evidence.snapshotRef → dl.browser-host-evidence"],
		["snapshot missing", "g1b.hostNone", "rhs:evidence.snapshotRef || → dd → evidence:evidence.snapshotRef"],
		["capture label", "g1b.hostCaptureLabel", "dt → evidence:evidence.screenshotRef → dl.browser-host-evidence"],
		["capture missing", "g1b.hostNone", "rhs:evidence.screenshotRef || → dd → evidence:evidence.screenshotRef"],
		["empty workspaces", "g1b.hostEmptyWorkspaces", "p.browser-host-empty → then:workspaces.length === 0"],
		["headless mode", "g1b.hostHeadlessMode", 'then:space.mode === "headless" → span.browser-host-space-meta'],
		["workspace revision", "g1b.hostRevisionLabel", "span.browser-host-space-meta", { revision: "space.revision" }, "· 개정"],
	],
	"lib/browser-host-skill.ts": [
		...browserTools.map(([name, key]): Site => [
			`${name.replaceAll("_", " ")} description`, `g1b.${key}`,
			`return → get:description → object:env_browser_${name}`,
		]),
		["element target ref or coords", "g1b.hostTargetRefOrCoords", "return → if:x === null || y === null → fn:elementTarget"],
		["element target why", "g1b.hostTargetWhyNeeded", "return → if:!why → fn:elementTarget"],
		["not a browser host tool", "g1b.hostNotBrowserHost", "arg:failed:2 → return → if:!isBrowserHostTool(toolName) → fn:executeBrowserHostSkill", { tool: "toolName" }, "브라우저 호스트 도구가 아니다:"],
		...([
			["open", "url", "url 이 필요하다"],
			["navigate", "url", "url 이 필요하다"],
			["evaluate", "expression", "expression 이 필요하다"],
			["script", "code", "code 가 필요하다"],
		] as const).map(([rpc, arg, legacy]): Site => [
			`missing ${arg} argument (${rpc})`, "g1b.hostArgNeeded",
			`prop:detail → arg:refused:2 → return → if:!${arg} → case:"env_browser_${rpc}"`,
			{ arg: JSON.stringify(arg) }, legacy,
		]),
		["not an evidence rpc", "g1b.hostNotEvidenceRpc", "arg:failed:2 → return → default → fn:runEvidenceRpc", { tool: "toolName" }, "증거 RPC 가 아니다:"],
	],
};

function jsxAttribute(node: ts.JsxElement | ts.JsxSelfClosingElement, name: string) {
	const element = ts.isJsxElement(node) ? node.openingElement : node;
	return element.attributes.properties.find((attr): attr is ts.JsxAttribute =>
		ts.isJsxAttribute(attr) && attr.name.getText() === name,
	)?.initializer;
}

function jsxLocations(node: ts.JsxElement | ts.JsxSelfClosingElement): string[] {
	const tag = (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText();
	const locations = [tag];
	const className = jsxAttribute(node, "className");
	if (className && ts.isStringLiteral(className)) {
		for (const name of className.text.split(/\s+/)) locations.push(`${tag}.${name}`);
	}
	for (const attribute of ["data-usage-event", "data-testid"]) {
		const value = jsxAttribute(node, attribute);
		if (value && ts.isStringLiteral(value)) locations.push(`${tag}#${value.text}`);
	}
	const click = jsxAttribute(node, "onClick");
	if (click && ts.isJsxExpression(click) && click.expression && ts.isArrowFunction(click.expression)) {
		locations.push(`${tag}#${formatExpression(click.expression.body)}`);
	}
	if (ts.isJsxElement(node) && tag === "div" && locations.includes("div.browser-host-evidence-row")) {
		const detail = node.children.find((child): child is ts.JsxElement =>
			ts.isJsxElement(child) && child.openingElement.tagName.getText() === "dd",
		);
		const value = detail?.children.find(ts.isJsxExpression)?.expression;
		if (value) {
			const reference = ts.isBinaryExpression(value) ? value.left : value;
			locations.push(`evidence:${formatExpression(reference)}`);
		}
	}
	return locations;
}

const printer = ts.createPrinter({ removeComments: true });

function formatExpression(node: ts.Node): string {
	return printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()).trim();
}

function parentLocation(node: ts.Node, parent: ts.Node): string[] {
	if (ts.isJsxAttribute(parent) && parent.initializer === node) return [`@${parent.name.getText()}`];
	if (ts.isJsxElement(parent) || ts.isJsxSelfClosingElement(parent)) return jsxLocations(parent);
	if (ts.isConditionalExpression(parent)) {
		if (node === parent.whenTrue) return [`then:${formatExpression(parent.condition)}`];
		if (node === parent.whenFalse) return [`else:${formatExpression(parent.condition)}`];
	}
	if (ts.isBinaryExpression(parent) && node === parent.right) {
		return [`rhs:${formatExpression(parent.left)} ${parent.operatorToken.getText()}`];
	}
	if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
		const index = parent.arguments?.findIndex((argument) => argument === node) ?? -1;
		if (index >= 0) {
			const callee = parent.expression;
			const name = ts.isPropertyAccessExpression(callee)
				? `.${callee.name.getText()}`
				: formatExpression(callee);
			return [`${ts.isCallExpression(parent) ? "arg" : "new"}:${name}:${index}`];
		}
	}
	if (ts.isReturnStatement(parent) && node === parent.expression) return ["return"];
	if (ts.isThrowStatement(parent) && node === parent.expression) return ["throw"];
	if (ts.isIfStatement(parent) && node === parent.thenStatement) return [`if:${formatExpression(parent.expression)}`];
	if (ts.isCaseClause(parent)) return [`case:${formatExpression(parent.expression)}`];
	if (ts.isDefaultClause(parent)) return ["default"];
	if (ts.isSwitchStatement(parent) && node === parent.caseBlock) return [];
	if (ts.isTryStatement(parent) && node === parent.tryBlock) return ["try"];
	if (ts.isTryStatement(parent) && node === parent.catchClause) return [];
	if (ts.isCatchClause(parent) && node === parent.block) return ["catch"];
	if (ts.isGetAccessorDeclaration(parent) && node === parent.body) return [`get:${parent.name.getText()}`];
	if (ts.isMethodDeclaration(parent) && node === parent.body) return [`method:${parent.name.getText()}`];
	if (ts.isFunctionDeclaration(parent) && node === parent.body) return [`fn:${parent.name?.getText()}`];
	if (ts.isArrowFunction(parent) && node === parent.body) {
		return [`callback:${parent.parameters.map((parameter) => parameter.name.getText()).join(",")}`];
	}
	if (ts.isPropertyAssignment(parent) && node === parent.initializer) return [`prop:${parent.name.getText()}`];
	if (ts.isVariableDeclaration(parent) && node === parent.initializer) return [`var:${parent.name.getText()}`];
	if (ts.isObjectLiteralExpression(parent)) {
		const name = parent.properties.find(
			(property): property is ts.PropertyAssignment =>
				ts.isPropertyAssignment(property) && property.name.getText() === "name",
		)?.initializer;
		return name && ts.isStringLiteral(name) ? [`object:${name.text}`] : [];
	}
	if (
		ts.isBlock(parent) ||
		ts.isCaseBlock(parent) ||
		ts.isExpressionStatement(parent) ||
		ts.isParenthesizedExpression(parent) ||
		ts.isJsxExpression(parent) ||
		ts.isJsxAttributes(parent) ||
		ts.isJsxOpeningElement(parent) ||
		ts.isArrayLiteralExpression(parent)
	) {
		return [];
	}
	return [ts.SyntaxKind[parent.kind]];
}

function locationOf(node: ts.Node): string[][] {
	const steps: string[][] = [];
	for (let child = node; child.parent; child = child.parent) {
		const step = parentLocation(child, child.parent);
		if (step.length > 0) steps.push(step);
	}
	return steps;
}

function usesLocation(node: ts.Node, location: string): boolean {
	const steps = locationOf(node);
	return location.split(" → ").every((step, index) => steps[index]?.includes(step));
}

function translationKey(node: ts.CallExpression): string | undefined {
	const [key] = node.arguments;
	return ts.isIdentifier(node.expression) && node.expression.text === "t" && key && ts.isStringLiteral(key)
		? key.text
		: undefined;
}

function assertTranslation(node: ts.CallExpression, key: TranslationKey, params: Site[3]) {
	assert.equal(translationKey(node), key);
	assert.equal(node.arguments.length, params ? 2 : 1, `Argument count for ${key}`);
	if (params) {
		const object = node.arguments[1];
		assert.ok(ts.isObjectLiteralExpression(object), `Expected interpolation object for ${key}`);
		const properties = object.properties.map((property) => {
			assert.ok(ts.isPropertyAssignment(property), `Expected interpolation property for ${key}`);
			const { name } = property;
			assert.ok(ts.isIdentifier(name) || ts.isStringLiteral(name));
			return [name.text, formatExpression(property.initializer)];
		});
		assert.equal(properties.length, Object.keys(params).length);
		assert.deepEqual(Object.fromEntries(properties), params);
	}
}

function sourceNodes(file: string) {
	const text = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
	const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const translations: ts.CallExpression[] = [];
	const literals: ts.Node[] = [];
	function visit(node: ts.Node) {
		if (ts.isCallExpression(node) && translationKey(node)) translations.push(node);
		if (literalText(node) !== undefined) literals.push(node);
		ts.forEachChild(node, visit);
	}
	visit(tree);
	return { translations, literals };
}

function literalText(node: ts.Node): string | undefined {
	if (
		ts.isStringLiteralLike(node) ||
		ts.isTemplateLiteralToken(node) ||
		ts.isJsxText(node)
	) {
		return node.text.trim().replace(/\s+/g, " ");
	}
	return undefined;
}

for (const [file, rows] of Object.entries(calls)) {
	const { translations, literals } = sourceNodes(file);
	for (const [name, key, location, params, legacy] of rows) {
		test(`${file} · ${name}`, () => {
			const oldText = legacy ?? STRINGS[key]?.[0];
			assert.ok(oldText, `Missing legacy text fixture for ${key}`);
			for (const literal of literals) {
				assert.notEqual(literalText(literal), oldText, `Found legacy text: ${oldText}`);
			}
			const matches = translations.filter((call) => usesLocation(call, location));
			const found = matches.map(translationKey).join(", ") || "none";
			assert.equal(matches.length, 1, `Expected one translation at ${location}; found ${found}`);
			assertTranslation(matches[0], key, params);
		});
	}
}

test("the development-only terminal port keeps its original diagnostic", () => {
	const { literals, translations } = sourceNodes("lib/browser-host-skill.ts");
	const location = "new:Error:0 → throw → method:exec → var:NO_TERMINAL";
	assert.ok(literals.some((literal) =>
		usesLocation(literal, location) && literalText(literal) === "이 조립에는 터미널 포트가 없다",
	), "Missing original terminal-port diagnostic in NO_TERMINAL.exec");
	assert.ok(!translations.some((call) => usesLocation(call, location)));
});

const STRINGS: Record<string, readonly [ko: string, en: string]> = {
	"g1b.slidesAppName": ["슬라이드", "Slides"],
	"g1b.editorPdfLoadFailed": ["PDF 로드 실패: {error}", "PDF load failed: {error}"],
	"g1b.editorMarkdownLimit": ["Markdown 파일이 5 MiB 미리보기 한도를 초과했습니다", "Markdown file exceeds the 5 MiB preview limit"],
	"g1b.editorCopyPath": ["경로 복사", "Copy path"],
	"g1b.editorOpenFailed": ["파일을 열 수 없습니다: {error}", "Cannot open file: {error}"],
	"g1b.editorReloadDisk": ["디스크에서 다시 읽기", "Reload from disk"],
	"g1b.editorSaveFailed": ["저장 실패", "Save failed"],
	"g1b.editorReadOnly": ["읽기 전용", "Read-only"],
	"g1b.editorSwitchToEdit": ["편집 모드로 전환", "Switch to edit mode"],
	"g1b.editorEdit": ["편집", "Edit"],
	"g1b.editorShowPreviewOnly": ["미리보기만 표시", "Show preview only"],
	"g1b.editorPreviewOnly": ["미리보기만", "Preview only"],
	"g1b.editorShowEditorOnly": ["편집기만 표시", "Show editor only"],
	"g1b.editorEditorOnly": ["편집만", "Editor only"],
	"g1b.editorSwitchToPreview": ["미리보기 모드로 전환", "Switch to preview mode"],
	"g1b.editorPreview": ["미리보기", "Preview"],
	"g1b.editorPrint": ["인쇄", "Print"],
	"g1b.editorPlaybackRate": ["재생 속도", "Playback speed"],
	"g1b.editorZoomFitTitle": ["화면 맞춤", "Fit to screen"],
	"g1b.editorZoomFit": ["맞춤", "Fit"],
	"g1b.editorZoomOriginalTitle": ["원본 크기", "Original size"],
	"g1b.editorZoomOut": ["축소", "Zoom out"],
	"g1b.editorZoomIn": ["확대", "Zoom in"],
	"g1b.editorImageLoading": ["이미지 로딩 중…", "Loading image…"],
	"g1b.editorPdfLoading": ["PDF 로딩 중…", "Loading PDF…"],
	"g1b.editorHwpExtracting": ["텍스트 추출 중…", "Extracting text…"],
	"g1b.editorHwpUnavailable": ["HWP/HWPX 파일 미리보기를 사용할 수 없습니다", "HWP/HWPX preview is unavailable"],
	"g1b.editorHwpSidecarHint": ["사이드카 .txt 파일이 없습니다. /read-doc 스킬로 추출하세요.", "No sidecar .txt file. Extract it with the /read-doc skill."],
	"g1b.editorCsvEmpty": ["CSV 데이터가 없습니다", "No CSV data"],
	"g1b.webwsReverted": ["원본으로 되돌렸어요.", "Reverted to the original."],
	"g1b.webwsRevertFailed": ["원본으로 되돌리지 못했어요.", "Could not revert to the original."],
	"g1b.webwsCloseExplorer": ["파일 탐색기 닫기", "Close file explorer"],
	"g1b.webwsCollapse": ["접기", "Collapse"],
	"g1b.webwsResizeExplorer": ["탐색기 폭 조절", "Resize explorer"],
	"g1b.webwsRevert": ["원본으로 되돌리기", "Revert to original"],
	"g1b.webwsEditHint": ["고치면 바로 저장되고, 지나의 다음 대답부터 반영돼요. 새로고침하면 원본으로 돌아갑니다.", "Edits save immediately and apply from Jina's next answer. Refreshing restores the original."],
	"g1b.docOpenDocs": ["열린 문서", "Open documents"],
	"g1b.docEmpty": ["열린 문서 없음", "No open documents"],
	"g1b.docAskAiTitle": ["이 문서를 AI에게 질의", "Ask AI about this document"],
	"g1b.docAskAiLabel": ["AI에게 질의: {name}", "Ask AI: {name}"],
	"g1b.docCloseLabel": ["문서 닫기: {name}", "Close document: {name}"],
	"g1b.mdImageError": ["이미지를 열 수 없습니다: {detail}", "Cannot open image: {detail}"],
	"g1b.mdUnknownImage": ["알 수 없는 이미지", "Unknown image"],
	"g1b.mdImageLoading": ["이미지 로딩 중…", "Loading image…"],
	"g1b.mdPreviewLabel": ["Markdown 미리보기", "Markdown preview"],
	"g1b.mdExternalLink": ["{label} (외부 링크)", "{label} (external link)"],
	"g1b.qoSearch": ["파일 이름으로 검색… (한글 초성 지원)", "Search by file name… (supports Korean initial-sound search)"],
	"g1b.qoLoading": ["파일 목록 불러오는 중…", "Loading file list…"],
	"g1b.qoEmpty": ["일치하는 파일이 없습니다", "No matching files"],
	"g1b.slidesKioskPrev": ["이전", "Previous"],
	"g1b.slidesKioskPause": ["멈춤", "Pause"],
	"g1b.slidesKioskResume": ["이어 가기", "Resume"],
	"g1b.slidesKioskNext": ["다음", "Next"],
	"g1b.slidesKioskStop": ["끝내기", "End"],
	"g1b.genericNotLoaded": ["이 앱은 설치됐지만 아직 로드되지 않았습니다.", "This app is installed but has not loaded yet."],
	"g1b.genericAddIndex": ["앱 디렉터리에 index.html을 추가하면 즉시 표시됩니다.", "Add index.html to the app directory to show it immediately."],
	"g1b.noteHint": ["Naia에게 이 메모를 읽거나 수정하도록 요청해보세요", "Ask Naia to read or edit this memo"],
	"g1b.notePlaceholder": ["메모를 입력하거나 Naia에게 써달라고 하세요...", "Type a memo or ask Naia to write it…"],
	"g1b.wsSessions": ["현재 Herdr Spaces와 그 안의 에이전트 상태를 반환한다. { sessions: SessionInfo[], summary: { total, active, idle, stopped, error, description } } 형태로 반환한다.", "Returns the current Herdr Spaces and their agent states as { sessions: SessionInfo[], summary: { total, active, idle, stopped, error, description } }."],
	"g1b.wsOpenFile": ["지정한 파일을 에디터에 연다. 절대 경로 또는 WORKSPACE_ROOT 기준 상대 경로를 받는다.", "Opens the given file in the editor. Takes an absolute path or a path relative to WORKSPACE_ROOT."],
	"g1b.wsGetOpenFile": ["현재 에디터에 열려 있는 파일의 경로·내용·sha256 을 반환한다. 파일이 없으면 { open: false }. 민감 경로나 1MB 초과 파일은 내용 없이 error 를 돌려준다.", "Returns the path, contents and sha256 of the file currently open in the editor. { open: false } when none. Sensitive paths or files over 1MB return error without contents."],
	"g1b.wsEditOpenFile": ["현재 에디터에 열려 있는 파일 한 개만 수정한다. 사용자가 에디터의 변경 미리보기를 보고 승인해야만 저장된다. path 는 skill_workspace_get_open_file 이 돌려준 path 와 같아야 한다. oldText(파일 안에서 정확히 한 번 나오는 원문)와 newText 로 부분 수정하거나, content 로 전체를 바꾼다. 결과 status: applied | rejected | stale | denied | invalid | error. rejected 면 저장되지 않았다. 편집기 안 승인 창이 유일한 승인 단계다(50초 안에 답이 없으면 저장하지 않는다).", "Edits only the single file currently open in the editor. Saves only after the user approves the in-editor change preview. path must equal the path returned by skill_workspace_get_open_file. Edit partially with oldText (source text appearing exactly once in the file) and newText, or replace everything with content. Result status: applied | rejected | stale | denied | invalid | error. rejected means not saved. The in-editor approval dialog is the only approval step (no answer within 50 seconds means no save)."],
	"g1b.wsCloseFile": ["현재 열려 있는 파일 탭이나 지정한 경로의 파일 탭을 닫는다. path를 생략하면 현재 활성 파일 탭을 닫는다.", "Closes the currently open file tab or the file tab at the given path. Omitting path closes the current active file tab."],
	"g1b.wsSetSurface": ["워크스페이스 화면을 Herdr 터미널('herdr') 또는 파일 뷰어('viewer')로 전환한다.", "Switches the workspace screen to the Herdr terminal ('herdr') or the file viewer ('viewer')."],
	"g1b.wsFocusSpace": ["Herdr의 특정 워크스페이스/스페이스(이름, ID, 디렉토리)로 포커스를 이동한다.", "Moves focus to a specific Herdr workspace/space (name, ID, or directory)."],
	"g1b.wsTermExec": ["사용자가 보고 있는 Herdr 터미널로 명령이나 입력을 전송하여 실행한다. 실행 시 자동으로 터미널 화면으로 전환되어 사용자가 볼 수 있다.", "Sends a command or input to the Herdr terminal the user is watching and runs it. Automatically switches to the terminal screen so the user can see it."],
	"g1b.wsTermOutput": ["현재 Herdr 터미널 화면에 출력된 최근 텍스트 버퍼를 읽어온다.", "Reads the recent text buffer shown on the current Herdr terminal screen."],
	"g1b.hostRecApproval": ["이 실행은 호출마다 승인이 필요합니다. 승인한 뒤 다시 요청하세요.", "Each run needs approval. Approve it, then ask again."],
	"g1b.hostRecCapability": ["이 작업에 필요한 권한이 부여되어 있지 않습니다. 설정에서 권한을 확인하세요.", "This task lacks a required permission. Check permissions in Settings."],
	"g1b.hostRecTimeout": ["제한 시간 안에 끝나지 않았습니다. 범위를 좁혀 다시 시도하세요.", "Timed out. Narrow the scope and try again."],
	"g1b.hostRecCancelled": ["중단된 작업입니다. 이미 일어난 변화는 그대로 남아 있습니다.", "Task was cancelled. Changes already made remain."],
	"g1b.hostRecDisconnected": ["브라우저 호스트에 닿지 못했습니다. 잠시 뒤 다시 시도하세요.", "Could not reach the browser host. Try again shortly."],
	"g1b.hostRecStaleRef": ["참조가 낡았습니다. 스냅샷을 다시 찍은 뒤 그 참조로 조작하세요.", "Reference is stale. Take a new snapshot, then act on it."],
	"g1b.hostRecMethodDenied": ["정책이 막은 동작입니다. 다른 방법을 찾거나 사람이 직접 하세요.", "Blocked by policy. Find another way or do it by hand."],
	"g1b.hostRecWorkspaceEscape": ["요청 형식이 맞지 않습니다. 인자를 확인하세요.", "Bad request shape. Check the arguments."],
	"g1b.hostRecDefault": ["같은 요청을 그대로 반복하지 말고 원인을 먼저 확인하세요.", "Do not repeat the same request; find the cause first."],
	"g1b.hostWorkspaceTitle": ["작업 공간", "Workspace"],
	"g1b.hostNoWorkspace": ["작업 공간 선택 전", "No workspace selected"],
	"g1b.hostStatusRunning": ["실행 중", "Running"],
	"g1b.hostStatusDone": ["완료", "Done"],
	"g1b.hostStatusRefused": ["거절됨", "Refused"],
	"g1b.hostProgress": ["브라우저에서 실행 중입니다 — 증거를 받는 중", "Running in the browser — collecting evidence"],
	"g1b.hostAddrLabel": ["주소", "Address"],
	"g1b.hostRevisionLabel": ["개정 {revision}", "rev {revision}"],
	"g1b.hostSnapshotLabel": ["스냅샷", "Snapshot"],
	"g1b.hostNone": ["없음", "None"],
	"g1b.hostCaptureLabel": ["캡처", "Capture"],
	"g1b.hostEmptyWorkspaces": ["열려 있는 작업 공간이 없습니다. 새 공간을 열면 그 안에서 웹 작업이 시작됩니다.", "No open workspaces. Open one to start web work inside it."],
	"g1b.hostHeadlessMode": ["화면 없음", "Headless"],
	"g1b.hostToolCreate": ["에이전트 전용 브라우저에 격리된 작업 공간을 하나 연다. 이 공간은 사용자의 브라우저가 아니고 화면도 없으며 로그인되어 있지 않다. 이후의 브라우저 도구는 이 공간에서 돈다.", "Opens an isolated workspace in the agent-only browser. It is not the user's browser, has no screen, and is not logged in. Later browser tools run in this space."],
	"g1b.hostToolList": ["지금 열려 있는 브라우저 작업 공간을 나열한다. 보기만 한다.", "Lists the currently open browser workspaces. Read-only."],
	"g1b.hostToolCloseWorkspace": ["작업 공간 하나를 닫는다. 그 공간의 탭·쿠키·저장소가 사라진다.", "Closes one workspace. Its tabs, cookies and storage disappear."],
	"g1b.hostToolOpen": ["작업 공간에 새 탭을 열어 주소로 간다. 사용자의 창은 열리지 않는다.", "Opens a new tab in the workspace and navigates to the address. Your window stays closed."],
	"g1b.hostToolNavigate": ["지금 탭에서 다른 주소로 간다.", "Navigates to a different address in the current tab."],
	"g1b.hostToolSnapshot": ["지금 페이지의 접근성 구조를 참조가 달린 글로 받는다. 조작하기 전에 이것을 먼저 부른다 — 참조는 이 호출이 만든다.", "Reads the current page's accessibility tree as referenced text. Call this before acting — the call creates the references."],
	"g1b.hostToolClick": ["스냅샷의 참조로 요소를 누른다. 참조로 못 잡을 때만 좌표를 쓰고, 그때는 why 에 이유를 적는다 — 그 사실이 결과에 남는다.", "Clicks the element by snapshot reference. Use coordinates only when no reference fits, and then give the reason in why — that fact stays in the result."],
	"g1b.hostToolFill": ["스냅샷의 참조가 가리키는 입력란에 값을 넣는다.", "Fills the input pointed to by the snapshot reference."],
	"g1b.hostToolEvaluate": ["페이지 안에서 한 덩어리 자바스크립트를 평가하고 값을 받는다. 효과가 고정된 평가다 — 여러 단계를 묶어 돌리는 것은 env_browser_script 이고 등급이 다르다.", "Evaluates one JavaScript chunk in the page and returns the value. A fixed-effect evaluation — bundling several steps is env_browser_script with a different tier."],
	"g1b.hostToolScreenshot": ["지금 페이지를 캡처한다. 저장 위치는 감독자가 정하고 결과에는 그 참조만 온다 — 경로를 지정하지 않는다.", "Captures the current page. The supervisor picks the save location and only its reference comes back — do not specify a path."],
	"g1b.hostToolCloseTab": ["지금 탭을 닫는다. 작업 공간은 남는다.", "Closes the current tab. The workspace remains."],
	"g1b.hostToolScript": ["여러 단계를 자바스크립트 한 덩어리로 묶어 브라우저에서 실행한다. 터미널에서 명령을 돌리는 것과 같은 등급이며 호출마다 사용자 승인이 필요하다. 승인이 없으면 거부되고, 거부는 실패다 — 형식 도구를 늘어놓아 같은 효과를 내려 하지 않는다.", "Runs several steps bundled as one JavaScript chunk in the browser. Same tier as running terminal commands and needs user approval per call. Without approval it is refused, and refusal is failure — do not line up form tools to the same effect."],
	"g1b.hostTargetRefOrCoords": ["참조(ref)나 좌표(x, y)가 필요하다 — 먼저 env_browser_snapshot 을 부른다", "A reference (ref) or coordinates (x, y) are required — call env_browser_snapshot first"],
	"g1b.hostTargetWhyNeeded": ["좌표로 찍으려면 why 에 참조를 쓸 수 없는 이유를 적어야 한다", "To click by coordinates, why must say why no reference could be used"],
	"g1b.hostNotBrowserHost": ["브라우저 호스트 도구가 아니다: {tool}", "Not a browser-host tool: {tool}"],
	"g1b.hostArgNeeded": ["{arg} 이 필요하다", "{arg} is required"],
	"g1b.hostNotEvidenceRpc": ["증거 RPC 가 아니다: {tool}", "Not an evidence RPC: {tool}"],
};

test("g1b 새 키가 열네 로케일에 자체 항목으로 있고 한·영 원문을 확인한다", async () => {
	const previous = getLocale();
	const locales = [
		"ko", "en", "ja", "zh", "fr", "de", "ru", "es", "ar", "hi", "bn", "pt", "id", "vi",
	] as const;
	try {
		for (const locale of locales) {
			const { default: table } = await import(`../locales/${locale}.ts`);
			await setLocale(locale);
			for (const [key, [ko, en]] of Object.entries(STRINGS)) {
				assert.ok(Object.prototype.hasOwnProperty.call(table, key), `${locale}: missing own key ${key}`);
				if (locale === "ko" || locale === "en") {
					assert.equal(t(key as TranslationKey), locale === "ko" ? ko : en, `${locale}: ${key}`);
				}
			}
		}
	} finally {
		await setLocale(previous);
	}
});

test("자리가 끼는 g1b 문구가 로케일을 지나 값을 채운다", async () => {
	const previous = getLocale();
	try {
		await setLocale("ko");
		assert.equal(t("g1b.editorPdfLoadFailed" as TranslationKey, { error: "E" }), "PDF 로드 실패: E");
		assert.equal(t("g1b.docAskAiLabel" as TranslationKey, { name: "a/b" }), "AI에게 질의: a/b");
		assert.equal(t("g1b.hostRevisionLabel" as TranslationKey, { revision: 3 }), "개정 3");
		assert.equal(t("g1b.hostNotBrowserHost" as TranslationKey, { tool: "x" }), "브라우저 호스트 도구가 아니다: x");
		assert.equal(t("g1b.hostArgNeeded" as TranslationKey, { arg: "url" }), "url 이 필요하다");
		await setLocale("en");
		assert.equal(t("g1b.editorPdfLoadFailed" as TranslationKey, { error: "E" }), "PDF load failed: E");
		assert.equal(t("g1b.docAskAiLabel" as TranslationKey, { name: "a/b" }), "Ask AI: a/b");
		assert.equal(t("g1b.hostRevisionLabel" as TranslationKey, { revision: 3 }), "rev 3");
		assert.equal(t("g1b.hostNotBrowserHost" as TranslationKey, { tool: "x" }), "Not a browser-host tool: x");
		assert.equal(t("g1b.hostArgNeeded" as TranslationKey, { arg: "url" }), "url is required");
	} finally {
		await setLocale(previous);
	}
});
