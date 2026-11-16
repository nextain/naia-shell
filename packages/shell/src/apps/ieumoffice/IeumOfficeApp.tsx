import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IeumOfficeStatus } from "../../lib/ieumoffice-mcp";
import {
	IEUMOFFICE_OFFICIAL_RELEASES_URL,
	IEUMOFFICE_OFFICIAL_REPO_URL,
	IEUMOFFICE_OFFICIAL_SITE_URL,
	buildFallbackNaiaPreset,
} from "../../lib/ieumoffice-mcp";
import { Logger } from "../../lib/logger";
import {
	buildAiDocumentPrompt,
	createSampleStudioDocument,
	ieumText,
	resolveIeumLocale,
} from "./locales/messages";
import {
	SKILL_IEUMOFFICE_STUDIO,
	applySerializedTextToDocument,
	handleIeumStudioToolCall,
	serializeActiveDocument,
} from "./tools";
import {
	type DocxBlock,
	type MindmapNode,
	type StudioDocKind,
	type StudioDocument,
	buildCsvText,
	buildDocxBytes,
	buildHwpxBytes,
	buildPptxBytes,
	buildXlsxBytes,
	buildXmindBytes,
	colLettersFromIndex,
	evaluateSheetCell,
	mindmapToDocxBlocks,
	mindmapToSlides,
	parseDocxBytes,
	parseHwpxBytes,
	parsePptxBytes,
	parseXlsxBytes,
	parseXmindBytes,
} from "./zip-ooxml-engine";

const TAG = "IeumOfficeApp";
const APP_ID = "land.naia.ieumoffice";

interface ProposedEdit {
	summary: string;
	nextText: string;
}

function makeRequestId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function triggerDownload(
	bytesOrText: Uint8Array | string,
	filename: string,
	mimeType: string,
): void {
	if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
		return;
	}
	const blob =
		typeof bytesOrText === "string"
			? new Blob([bytesOrText], { type: mimeType })
			: new Blob([bytesOrText as unknown as BlobPart], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function IeumOfficeApp(): React.ReactElement {
	const [locale, setLocale] = useState<string>(() => resolveIeumLocale());
	const [activeTab, setActiveTab] = useState<"studio" | "connect" | "download">(
		"studio",
	);
	const [doc, setDoc] = useState<StudioDocument>(() =>
		createSampleStudioDocument(resolveIeumLocale()),
	);
	const [activeSlideIdx, setActiveSlideIdx] = useState(0);
	const [undoSnapshot, setUndoSnapshot] = useState<StudioDocument | null>(null);
	const [proposedEdit, setProposedEdit] = useState<ProposedEdit | null>(null);

	const [aiPrompt, setAiPrompt] = useState("");
	const [aiBusy, setAiBusy] = useState(false);
	const [speakingId, setSpeakingId] = useState<string | null>(null);
	const [statusMessage, setStatusMessage] = useState<string | null>(null);

	const [hostStatus, setHostStatus] = useState<IeumOfficeStatus | null>(null);
	const [checkingHost, setCheckingHost] = useState(false);
	const [codingAgentsOutput, setCodingAgentsOutput] = useState<string | null>(
		null,
	);
	const [copiedKey, setCopiedKey] = useState<string | null>(null);

	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const pendingAskIdRef = useRef<string | null>(null);
	const pendingBridgeMapRef = useRef<
		Map<string, (payload: Record<string, unknown>) => void>
	>(new Map());

	const stateRef = useRef({
		activeTab,
		doc,
		hostStatus,
	});
	stateRef.current = { activeTab, doc, hostStatus };

	const t = useCallback(
		(key: Parameters<typeof ieumText>[0]) => ieumText(key, locale),
		[locale],
	);

	const sendHostBridgeRequest = useCallback(
		(
			type: string,
			extra: Record<string, unknown> = {},
		): Promise<Record<string, unknown>> => {
			return new Promise((resolve) => {
				if (typeof window === "undefined" || window.parent === window) {
					resolve({ ok: false, standalone: true });
					return;
				}
				const id = makeRequestId("ieum-bridge");
				const timer = setTimeout(() => {
					pendingBridgeMapRef.current.delete(id);
					resolve({ ok: false, timeout: true });
				}, 6000);
				pendingBridgeMapRef.current.set(id, (payload) => {
					clearTimeout(timer);
					resolve(payload);
				});
				window.parent.postMessage({ type, id, ...extra }, "*");
			});
		},
		[],
	);

	const refreshHostStatus = useCallback(async () => {
		setCheckingHost(true);
		Logger.debug(TAG, "requesting desktop ieumoffice status");
		const res = await sendHostBridgeRequest("naia-ieumoffice:get-status");
		if (res.ok && res.status && typeof res.status === "object") {
			setHostStatus(res.status as IeumOfficeStatus);
		} else if (!hostStatus) {
			setHostStatus({
				installed: false,
				mcpEnabled: false,
				autoConnected: false,
				officialRepoUrl: IEUMOFFICE_OFFICIAL_REPO_URL,
				officialReleasesUrl: IEUMOFFICE_OFFICIAL_RELEASES_URL,
				officialSiteUrl: IEUMOFFICE_OFFICIAL_SITE_URL,
				naiaPreset: buildFallbackNaiaPreset(),
			});
		}
		setCheckingHost(false);
	}, [hostStatus, sendHostBridgeRequest]);

	useEffect(() => {
		void refreshHostStatus();
	}, [refreshHostStatus]);

	// Push live app context to Naia Shell
	useEffect(() => {
		if (typeof window === "undefined" || window.parent === window) return;
		const preview = serializeActiveDocument(doc).slice(0, 1200);
		window.parent.postMessage(
			{
				type: "naia-app:context",
				context: {
					type: "ieumoffice_studio",
					data: {
						activeTab,
						documentKind: doc.kind,
						fileName: doc.fileName,
						preview,
						desktopInstalled: Boolean(hostStatus?.installed),
						desktopMcpEnabled: Boolean(hostStatus?.mcpEnabled),
					},
				},
			},
			"*",
		);
	}, [activeTab, doc, hostStatus]);

	// Listen for Shell host messages (locale, ask reply, speech result, tool call, bridge result)
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const data = event.data;
			if (!data || typeof data !== "object") return;
			const msg = data as Record<string, unknown>;

			if (msg.type === "naia-app:locale" && typeof msg.locale === "string") {
				Logger.debug(TAG, "received shell locale", { locale: msg.locale });
				setLocale(resolveIeumLocale(msg.locale));
				return;
			}

			if (msg.type === "naia-ieumoffice:result" && typeof msg.id === "string") {
				const resolver = pendingBridgeMapRef.current.get(msg.id);
				if (resolver) {
					pendingBridgeMapRef.current.delete(msg.id);
					resolver(msg);
				}
				return;
			}

			if (msg.type === "naia-app:response" && typeof msg.id === "string") {
				if (pendingAskIdRef.current !== msg.id) return;
				pendingAskIdRef.current = null;
				setAiBusy(false);
				if (typeof msg.error === "string" && msg.error) {
					setStatusMessage(`AI error: ${msg.error}`);
					return;
				}
				const replyText = typeof msg.text === "string" ? msg.text.trim() : "";
				if (replyText) {
					setProposedEdit({
						summary: t("ieum.diffTitle"),
						nextText: replyText,
					});
				}
				return;
			}

			if (
				msg.type === "naia-app:speech-result" &&
				typeof msg.id === "string"
			) {
				setSpeakingId((cur) => (cur === msg.id ? null : cur));
				return;
			}

			if (
				msg.type === "naia-tool-call" &&
				msg.tool === SKILL_IEUMOFFICE_STUDIO &&
				typeof msg.id === "string"
			) {
				const args =
					msg.args && typeof msg.args === "object"
						? (msg.args as Record<string, unknown>)
						: {};
				const result = handleIeumStudioToolCall(args, {
					getState: () => ({
						activeTab: stateRef.current.activeTab,
						doc: stateRef.current.doc,
						desktopInstalled: Boolean(stateRef.current.hostStatus?.installed),
						desktopMcpEnabled: Boolean(stateRef.current.hostStatus?.mcpEnabled),
						desktopVersion: stateRef.current.hostStatus?.version,
					}),
					setProposedEdit: (proposal) => setProposedEdit(proposal),
					applyDocumentUpdate: (updater) => setDoc(updater),
				});
				window.parent.postMessage(
					{
						type: "naia-tool-result",
						id: msg.id,
						result,
					},
					"*",
				);
			}
		};

		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [t]);

	const handleSelectDocKind = (kind: StudioDocKind) => {
		Logger.debug(TAG, "switching studio document kind", { kind });
		setProposedEdit(null);
		setDoc((prev) => ({ ...prev, kind }));
	};

	const handleOpenLocalFile = async (
		event: React.ChangeEvent<HTMLInputElement>,
	) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		const lower = file.name.toLowerCase();
		const baseName = file.name.replace(/\.[^.]+$/, "");
		Logger.info(TAG, "opening local document in web studio", {
			ext: lower.split(".").pop(),
			size: file.size,
		});
		try {
			const buf = new Uint8Array(await file.arrayBuffer());
			if (lower.endsWith(".docx")) {
				const blocks = await parseDocxBytes(buf);
				setDoc((prev) => ({
					...prev,
					kind: "docx",
					fileName: baseName,
					docxBlocks: blocks,
				}));
			} else if (lower.endsWith(".xlsx")) {
				const sheet = await parseXlsxBytes(buf);
				setDoc((prev) => ({
					...prev,
					kind: "xlsx",
					fileName: baseName,
					sheet,
				}));
			} else if (lower.endsWith(".csv")) {
				const text = new TextDecoder("utf-8").decode(buf);
				const rows = text
					.split(/\r?\n/)
					.filter((l) => l.length > 0)
					.map((l) => l.split(","));
				setDoc((prev) => ({
					...prev,
					kind: "xlsx",
					fileName: baseName,
					sheet: { name: baseName, rows },
				}));
			} else if (lower.endsWith(".pptx")) {
				const slides = await parsePptxBytes(buf);
				setActiveSlideIdx(0);
				setDoc((prev) => ({
					...prev,
					kind: "pptx",
					fileName: baseName,
					slides,
				}));
			} else if (lower.endsWith(".hwpx")) {
				const paragraphs = await parseHwpxBytes(buf);
				setDoc((prev) => ({
					...prev,
					kind: "hwpx",
					fileName: baseName,
					hwpxParagraphs: paragraphs,
				}));
			} else if (lower.endsWith(".xmind")) {
				const mindmap = await parseXmindBytes(buf);
				setDoc((prev) => ({
					...prev,
					kind: "xmind",
					fileName: baseName,
					mindmap,
				}));
			} else {
				const text = new TextDecoder("utf-8").decode(buf);
				setDoc((prev) => ({
					...prev,
					kind: "markdown",
					fileName: baseName,
					markdownText: text,
				}));
			}
			setStatusMessage(null);
		} catch (err) {
			Logger.warn(TAG, "failed to parse local document", {
				error: String(err),
			});
			setStatusMessage(
				err instanceof Error ? err.message : "Could not parse file",
			);
		}
	};

	const handleExportCurrent = () => {
		const safeName = doc.fileName.trim() || "document";
		Logger.info(TAG, "exporting current document", { kind: doc.kind });
		switch (doc.kind) {
			case "docx":
				triggerDownload(
					buildDocxBytes(doc.docxBlocks),
					`${safeName}.docx`,
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				);
				break;
			case "xlsx":
				triggerDownload(
					buildXlsxBytes(doc.sheet),
					`${safeName}.xlsx`,
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
				);
				break;
			case "pptx":
				triggerDownload(
					buildPptxBytes(doc.slides),
					`${safeName}.pptx`,
					"application/vnd.openxmlformats-officedocument.presentationml.presentation",
				);
				break;
			case "hwpx":
				triggerDownload(
					buildHwpxBytes(doc.hwpxParagraphs, doc.title),
					`${safeName}.hwpx`,
					"application/hwp+zip",
				);
				break;
			case "xmind":
				triggerDownload(
					buildXmindBytes(doc.mindmap),
					`${safeName}.xmind`,
					"application/octet-stream",
				);
				break;
			case "markdown":
				triggerDownload(
					doc.markdownText,
					`${safeName}.md`,
					"text/markdown;charset=utf-8",
				);
				break;
		}
	};

	const askNaiaToEdit = (instructionOverride?: string) => {
		const instruction = (instructionOverride ?? aiPrompt).trim();
		if (!instruction || aiBusy) return;
		const serialized = serializeActiveDocument(doc);
		const prompt = buildAiDocumentPrompt(doc, serialized, instruction, locale);
		const reqId = makeRequestId("ieum-ask");
		pendingAskIdRef.current = reqId;
		setAiBusy(true);
		setStatusMessage(null);
		Logger.info(TAG, "sending naia-app:ask edit request", {
			reqId,
			kind: doc.kind,
		});

		if (typeof window !== "undefined" && window.parent !== window) {
			window.parent.postMessage(
				{
					type: "naia-app:ask",
					appId: APP_ID,
					id: reqId,
					prompt,
				},
				"*",
			);
		} else {
			// Standalone fallback preview when tested outside Tauri host
			setAiBusy(false);
			pendingAskIdRef.current = null;
			setProposedEdit({
				summary: instruction,
				nextText: `${serialized}\n- [Draft] ${instruction}`,
			});
		}
	};

	const handleApplyProposedEdit = () => {
		if (!proposedEdit) return;
		setUndoSnapshot(doc);
		setDoc((prev) => applySerializedTextToDocument(prev, proposedEdit.nextText));
		setProposedEdit(null);
	};

	const handleToggleSpeak = () => {
		if (typeof window === "undefined" || window.parent === window) return;
		if (speakingId) {
			window.parent.postMessage(
				{
					type: "naia-app:speak-cancel",
					appId: APP_ID,
					id: speakingId,
				},
				"*",
			);
			setSpeakingId(null);
			return;
		}
		const text = serializeActiveDocument(doc).slice(0, 1500);
		if (!text.trim()) return;
		const id = makeRequestId("ieum-speak");
		setSpeakingId(id);
		window.parent.postMessage(
			{
				type: "naia-app:speak",
				appId: APP_ID,
				id,
				text,
			},
			"*",
		);
	};

	const handleToggleMcp = async () => {
		const nextEnabled = !hostStatus?.mcpEnabled;
		setCheckingHost(true);
		const res = await sendHostBridgeRequest("naia-ieumoffice:set-mcp-enabled", {
			enabled: nextEnabled,
		});
		if (res.ok && res.status && typeof res.status === "object") {
			setHostStatus(res.status as IeumOfficeStatus);
		}
		setCheckingHost(false);
	};

	const handleRegisterCodingAgents = async () => {
		setCheckingHost(true);
		const res = await sendHostBridgeRequest(
			"naia-ieumoffice:register-coding-agents",
		);
		if (res.ok && res.result && typeof res.result === "object") {
			const r = res.result as { summary?: string; ok?: boolean };
			setCodingAgentsOutput(r.summary || (r.ok ? "OK" : "Completed"));
		} else if (typeof res.error === "string") {
			setCodingAgentsOutput(res.error);
		}
		setCheckingHost(false);
	};

	const copyText = async (key: string, value: string) => {
		try {
			await navigator.clipboard.writeText(value);
		} catch {
			// Ignore clipboard denial in restricted contexts
		}
		setCopiedKey(key);
		setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 2000);
	};

	const preset = useMemo(
		() => hostStatus?.naiaPreset ?? buildFallbackNaiaPreset(),
		[hostStatus],
	);

	const activeSlide = doc.slides[activeSlideIdx] ?? doc.slides[0];

	return (
		<div className="ieum-root" data-testid="ieumoffice-studio">
			<header className="ieum-hero">
				<div className="ieum-hero-main">
					<img src="icon.svg" alt="IeumOffice" className="ieum-hero-icon" />
					<div>
						<div className="ieum-eyebrow">{t("ieum.brandEyebrow")}</div>
						<h1>
							{t("ieum.title")} <small>v0.2.0</small>
						</h1>
						<p>{t("ieum.subtitle")}</p>
						<div className="ieum-badges">
							<span className="ieum-badge amber">{t("ieum.badgeFree")}</span>
							<span className="ieum-badge">{t("ieum.badgeEmbedded")}</span>
							<span className="ieum-badge">
								{hostStatus?.installed && hostStatus.mcpEnabled
									? t("ieum.mcpConnectedBadge")
									: t("ieum.badgeMcp")}
							</span>
						</div>
					</div>
				</div>
			</header>

			<nav className="ieum-tabs" role="tablist">
				{(["studio", "connect", "download"] as const).map((tabId) => (
					<button
						key={tabId}
						type="button"
						role="tab"
						aria-selected={activeTab === tabId}
						className={`ieum-tab ${activeTab === tabId ? "on" : ""}`}
						data-usage-event="ieumoffice-app.ctrl-1.click" onClick={() => setActiveTab(tabId)}
					>
						{tabId === "studio"
							? t("ieum.tabStudio")
							: tabId === "connect"
								? t("ieum.tabConnect")
								: t("ieum.tabDownload")}
					</button>
				))}
			</nav>

			{statusMessage && (
				<div className="ieum-status-banner" role="status">
					<span>{statusMessage}</span>
					<button
						type="button"
						className="ieum-btn ghost sm"
						data-usage-event="ieumoffice-app.ctrl-2.click" onClick={() => setStatusMessage(null)}
					>
						{t("ieum.dismissNotice")}
					</button>
				</div>
			)}

			{activeTab === "studio" && (
				<section className="ieum-studio-grid">
					<aside className="ieum-card ieum-format-rail">
						<div className="ieum-format-list">
							{(
								[
									["docx", "ieum.docKindDocx"],
									["xlsx", "ieum.docKindXlsx"],
									["pptx", "ieum.docKindPptx"],
									["hwpx", "ieum.docKindHwpx"],
									["xmind", "ieum.docKindXmind"],
									["markdown", "ieum.docKindMarkdown"],
								] as const
							).map(([kind, labelKey]) => (
								<button
									key={kind}
									type="button"
									data-testid={`format-${kind}`}
									className={`ieum-format-btn ${doc.kind === kind ? "on" : ""}`}
									data-usage-event="ieumoffice-app.ctrl-3.click" onClick={() => handleSelectDocKind(kind)}
								>
									{t(labelKey)}
								</button>
							))}
						</div>

						<div className="ieum-file-actions">
							<label className="ieum-field-label" htmlFor="ieum-file-name">
								{t("ieum.fileNameLabel")}
							</label>
							<input
								id="ieum-file-name"
								className="ieum-input"
								value={doc.fileName}
								onChange={(e) =>
									setDoc((prev) => ({ ...prev, fileName: e.target.value }))
								}
							/>

							<input
								ref={fileInputRef}
								type="file"
								accept=".docx,.xlsx,.csv,.pptx,.hwpx,.xmind,.md,.html,.txt"
								hidden
								onChange={handleOpenLocalFile}
							/>
							<button
								type="button"
								className="ieum-btn ghost full"
								data-usage-event="ieumoffice-app.ctrl-4.click" onClick={() => fileInputRef.current?.click()}
							>
								{t("ieum.openFile")}
							</button>
							<button
								type="button"
								className="ieum-btn full"
								data-testid="export-doc-btn"
								data-usage-event="ieumoffice-app.ctrl-5.click" onClick={handleExportCurrent}
							>
								{t("ieum.exportFile")}
							</button>
							{doc.kind === "xlsx" && (
								<button
									type="button"
									className="ieum-btn ghost full"
									data-usage-event="ieumoffice-app.ctrl-6.click" onClick={() =>
										triggerDownload(
											buildCsvText(doc.sheet),
											`${doc.fileName || "sheet"}.csv`,
											"text/csv;charset=utf-8",
										)
									}
								>
									{t("ieum.exportCsv")}
								</button>
							)}
							<button
								type="button"
								className="ieum-btn ghost full"
								data-usage-event="ieumoffice-app.ctrl-7.click" onClick={() =>
									setDoc((prev) => ({
										...createSampleStudioDocument(locale),
										kind: prev.kind,
									}))
								}
							>
								{t("ieum.resetSample")}
							</button>
						</div>
					</aside>

					<main className="ieum-card ieum-editor-surface">
						{doc.kind === "docx" && (
							<div data-testid="editor-docx">
								<div className="ieum-toolbar">
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-usage-event="ieumoffice-app.ctrl-8.click" onClick={() =>
											setDoc((prev) => ({
												...prev,
												docxBlocks: [
													...prev.docxBlocks,
													{
														id: makeRequestId("h2"),
														kind: "heading2",
														text: "",
													},
												],
											}))
										}
									>
										{t("ieum.addHeading")}
									</button>
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-usage-event="ieumoffice-app.ctrl-9.click" onClick={() =>
											setDoc((prev) => ({
												...prev,
												docxBlocks: [
													...prev.docxBlocks,
													{
														id: makeRequestId("p"),
														kind: "paragraph",
														text: "",
													},
												],
											}))
										}
									>
										{t("ieum.addParagraph")}
									</button>
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-usage-event="ieumoffice-app.ctrl-10.click" onClick={() =>
											setDoc((prev) => ({
												...prev,
												docxBlocks: [
													...prev.docxBlocks,
													{
														id: makeRequestId("b"),
														kind: "bullet",
														text: "",
													},
												],
											}))
										}
									>
										{t("ieum.addBullet")}
									</button>
								</div>

								<div className="ieum-page-sheet">
									{doc.docxBlocks.map((block, idx) => (
										<div key={block.id} className="ieum-docx-row">
											<select
												aria-label="Block style"
												className="ieum-select-sm"
												value={block.kind}
												data-usage-event="ieumoffice-app.ctrl-11.select" onChange={(e) => {
													const nextKind = e.target.value as DocxBlock["kind"];
													setDoc((prev) => ({
														...prev,
														docxBlocks: prev.docxBlocks.map((b, i) =>
															i === idx ? { ...b, kind: nextKind } : b,
														),
													}));
												}}
											>
												<option value="heading1">
													{t("ieum.blockHeading1")}
												</option>
												<option value="heading2">
													{t("ieum.blockHeading2")}
												</option>
												<option value="paragraph">
													{t("ieum.blockParagraph")}
												</option>
												<option value="bullet">{t("ieum.blockBullet")}</option>
											</select>
											<textarea
												rows={block.kind === "paragraph" ? 2 : 1}
												className={`ieum-docx-input ${block.kind}`}
												value={block.text}
												onChange={(e) => {
													const val = e.target.value;
													setDoc((prev) => ({
														...prev,
														docxBlocks: prev.docxBlocks.map((b, i) =>
															i === idx ? { ...b, text: val } : b,
														),
													}));
												}}
											/>
											{doc.docxBlocks.length > 1 && (
												<button
													type="button"
													className="ieum-btn ghost xs"
													data-usage-event="ieumoffice-app.ctrl-12.click" onClick={() =>
														setDoc((prev) => ({
															...prev,
															docxBlocks: prev.docxBlocks.filter(
																(_, i) => i !== idx,
															),
														}))
													}
												>
													{t("ieum.removeItem")}
												</button>
											)}
										</div>
									))}
								</div>
							</div>
						)}

						{doc.kind === "xlsx" && (
							<div data-testid="editor-xlsx">
								<div className="ieum-toolbar">
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-usage-event="ieumoffice-app.ctrl-13.click" onClick={() =>
											setDoc((prev) => {
												const cols = prev.sheet.rows[0]?.length || 4;
												return {
													...prev,
													sheet: {
														...prev.sheet,
														rows: [
															...prev.sheet.rows,
															Array.from({ length: cols }, () => ""),
														],
													},
												};
											})
										}
									>
										{t("ieum.addRow")}
									</button>
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-usage-event="ieumoffice-app.ctrl-14.click" onClick={() =>
											setDoc((prev) => ({
												...prev,
												sheet: {
													...prev.sheet,
													rows: prev.sheet.rows.map((r) => [...r, ""]),
												},
											}))
										}
									>
										{t("ieum.addCol")}
									</button>
									<span className="ieum-muted-hint">{t("ieum.formulaHint")}</span>
								</div>
								<div className="ieum-sheet-wrap">
									<table className="ieum-sheet-table">
										<thead>
											<tr>
												<th>#</th>
												{(doc.sheet.rows[0] ?? []).map((_, cIdx) => (
													<th key={colLettersFromIndex(cIdx)}>
														{colLettersFromIndex(cIdx)}
													</th>
												))}
											</tr>
										</thead>
										<tbody>
											{doc.sheet.rows.map((row, rIdx) => (
												<tr key={`r-${rIdx + 1}`}>
													<td className="ieum-row-num">{rIdx + 1}</td>
													{row.map((cell, cIdx) => {
														const isFormula = cell.trim().startsWith("=");
														const computed = isFormula
															? evaluateSheetCell(doc.sheet.rows, rIdx, cIdx)
															: "";
														return (
															<td key={`${rIdx}-${cIdx}`}>
																<input
																	aria-label={`${colLettersFromIndex(cIdx)}${rIdx + 1}`}
																	className="ieum-cell-input"
																	value={cell}
																	onChange={(e) => {
																		const nextVal = e.target.value;
																		setDoc((prev) => ({
																			...prev,
																			sheet: {
																				...prev.sheet,
																				rows: prev.sheet.rows.map((r, ri) =>
																					ri === rIdx
																						? r.map((v, ci) =>
																								ci === cIdx ? nextVal : v,
																							)
																						: r,
																				),
																			},
																		}));
																	}}
																/>
																{isFormula && (
																	<div className="ieum-cell-eval">
																		= {computed}
																	</div>
																)}
															</td>
														);
													})}
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</div>
						)}

						{doc.kind === "pptx" && activeSlide && (
							<div data-testid="editor-pptx">
								<div className="ieum-toolbar">
									{doc.slides.map((s, idx) => (
										<button
											key={s.id}
											type="button"
											className={`ieum-btn ${idx === activeSlideIdx ? "" : "ghost"} sm`}
											data-usage-event="ieumoffice-app.ctrl-15.click" onClick={() => setActiveSlideIdx(idx)}
										>
											#{idx + 1}
										</button>
									))}
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-usage-event="ieumoffice-app.ctrl-16.click" onClick={() => {
											const nextIdx = doc.slides.length;
											setDoc((prev) => ({
												...prev,
												slides: [
													...prev.slides,
													{
														id: makeRequestId("slide"),
														title: `Slide ${prev.slides.length + 1}`,
														bullets: [""],
														notes: "",
													},
												],
											}));
											setActiveSlideIdx(nextIdx);
										}}
									>
										{t("ieum.addSlide")}
									</button>
								</div>

								<div className="ieum-slide-canvas">
									<h2>{activeSlide.title}</h2>
									<ul>
										{activeSlide.bullets
											.filter((b) => b.trim().length > 0)
											.map((b, bi) => (
												<li key={`${activeSlide.id}-b-${bi}`}>{b}</li>
											))}
									</ul>
								</div>

								<div className="ieum-slide-fields">
									<label className="ieum-field-label" htmlFor="slide-title-in">
										{t("ieum.slideTitle")}
									</label>
									<input
										id="slide-title-in"
										className="ieum-input"
										value={activeSlide.title}
										onChange={(e) => {
											const val = e.target.value;
											setDoc((prev) => ({
												...prev,
												slides: prev.slides.map((s, idx) =>
													idx === activeSlideIdx ? { ...s, title: val } : s,
												),
											}));
										}}
									/>
									<label
										className="ieum-field-label"
										htmlFor="slide-bullets-in"
									>
										{t("ieum.slideBullets")}
									</label>
									<textarea
										id="slide-bullets-in"
										rows={4}
										className="ieum-textarea"
										value={activeSlide.bullets.join("\n")}
										onChange={(e) => {
											const lines = e.target.value.split("\n");
											setDoc((prev) => ({
												...prev,
												slides: prev.slides.map((s, idx) =>
													idx === activeSlideIdx ? { ...s, bullets: lines } : s,
												),
											}));
										}}
									/>
									<label className="ieum-field-label" htmlFor="slide-notes-in">
										{t("ieum.slideNotes")}
									</label>
									<input
										id="slide-notes-in"
										className="ieum-input"
										value={activeSlide.notes}
										onChange={(e) => {
											const val = e.target.value;
											setDoc((prev) => ({
												...prev,
												slides: prev.slides.map((s, idx) =>
													idx === activeSlideIdx ? { ...s, notes: val } : s,
												),
											}));
										}}
									/>
								</div>
							</div>
						)}

						{doc.kind === "hwpx" && (
							<div data-testid="editor-hwpx">
								<p className="ieum-muted-hint">{t("ieum.hwpxHint")}</p>
								<div className="ieum-toolbar">
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-usage-event="ieumoffice-app.ctrl-17.click" onClick={() =>
											setDoc((prev) => ({
												...prev,
												hwpxParagraphs: [...prev.hwpxParagraphs, ""],
											}))
										}
									>
										{t("ieum.addParagraph")}
									</button>
								</div>
								<div className="ieum-page-sheet">
									{doc.hwpxParagraphs.map((para, idx) => (
										<div key={`hwp-${idx + 1}`} className="ieum-docx-row">
											<textarea
												rows={2}
												className="ieum-docx-input paragraph"
												value={para}
												onChange={(e) => {
													const val = e.target.value;
													setDoc((prev) => ({
														...prev,
														hwpxParagraphs: prev.hwpxParagraphs.map((p, i) =>
															i === idx ? val : p,
														),
													}));
												}}
											/>
										</div>
									))}
								</div>
							</div>
						)}

						{doc.kind === "xmind" && (
							<div data-testid="editor-xmind">
								<div className="ieum-toolbar">
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-usage-event="ieumoffice-app.ctrl-18.click" onClick={() =>
											setDoc((prev) => ({
												...prev,
												mindmap: {
													...prev.mindmap,
													children: [
														...prev.mindmap.children,
														{
															id: makeRequestId("branch"),
															title: "New Topic",
															children: [],
														},
													],
												},
											}))
										}
									>
										{t("ieum.addBranch")}
									</button>
									<button
										type="button"
										className="ieum-btn sm"
										data-testid="mindmap-to-pptx-btn"
										data-usage-event="ieumoffice-app.ctrl-19.click" onClick={() => {
											setActiveSlideIdx(0);
											setDoc((prev) => ({
												...prev,
												kind: "pptx",
												slides: mindmapToSlides(prev.mindmap),
											}));
										}}
									>
										{t("ieum.convertToSlides")}
									</button>
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-testid="mindmap-to-docx-btn"
										data-usage-event="ieumoffice-app.ctrl-20.click" onClick={() =>
											setDoc((prev) => ({
												...prev,
												kind: "docx",
												docxBlocks: mindmapToDocxBlocks(prev.mindmap),
											}))
										}
									>
										{t("ieum.convertToDocx")}
									</button>
								</div>

								<div className="ieum-mindmap-root">
									<input
										aria-label="Root topic"
										className="ieum-input root-topic"
										value={doc.mindmap.title}
										onChange={(e) => {
											const val = e.target.value;
											setDoc((prev) => ({
												...prev,
												mindmap: { ...prev.mindmap, title: val },
											}));
										}}
									/>
									<div className="ieum-mindmap-branches">
										{doc.mindmap.children.map((branch, bIdx) => (
											<div key={branch.id} className="ieum-branch-card">
												<div className="ieum-branch-head">
													<input
														className="ieum-input"
														value={branch.title}
														onChange={(e) => {
															const val = e.target.value;
															setDoc((prev) => ({
																...prev,
																mindmap: {
																	...prev.mindmap,
																	children: prev.mindmap.children.map(
																		(b: MindmapNode, i: number) =>
																			i === bIdx ? { ...b, title: val } : b,
																	),
																},
															}));
														}}
													/>
													<button
														type="button"
														className="ieum-btn ghost xs"
														data-usage-event="ieumoffice-app.ctrl-21.click" onClick={() =>
															setDoc((prev) => ({
																...prev,
																mindmap: {
																	...prev.mindmap,
																	children: prev.mindmap.children.map((b, i) =>
																		i === bIdx
																			? {
																					...b,
																					children: [
																						...b.children,
																						{
																							id: makeRequestId("leaf"),
																							title: "",
																							children: [],
																						},
																					],
																				}
																			: b,
																	),
																},
															}))
														}
													>
														{t("ieum.addSubtopic")}
													</button>
												</div>
												{branch.children.map((leaf, lIdx) => (
													<input
														key={leaf.id}
														className="ieum-input leaf"
														value={leaf.title}
														onChange={(e) => {
															const val = e.target.value;
															setDoc((prev) => ({
																...prev,
																mindmap: {
																	...prev.mindmap,
																	children: prev.mindmap.children.map((b, i) =>
																		i === bIdx
																			? {
																					...b,
																					children: b.children.map((lf, li) =>
																						li === lIdx
																							? { ...lf, title: val }
																							: lf,
																					),
																				}
																			: b,
																	),
																},
															}));
														}}
													/>
												))}
											</div>
										))}
									</div>
								</div>
							</div>
						)}

						{doc.kind === "markdown" && (
							<div className="ieum-md-split" data-testid="editor-markdown">
								<div>
									<div className="ieum-field-label">
										{t("ieum.markdownWrite")}
									</div>
									<textarea
										rows={14}
										className="ieum-textarea mono"
										value={doc.markdownText}
										onChange={(e) =>
											setDoc((prev) => ({
												...prev,
												markdownText: e.target.value,
											}))
										}
									/>
								</div>
								<div>
									<div className="ieum-field-label">
										{t("ieum.markdownPreview")}
									</div>
									<div className="ieum-page-sheet">
										{doc.markdownText.split("\n").map((line, i) => (
											<p key={`md-${i + 1}`} className="ieum-md-line">
												{line}
											</p>
										))}
									</div>
								</div>
							</div>
						)}
					</main>

					<aside className="ieum-card ieum-ai-rail">
						<h3>{t("ieum.aiPanelTitle")}</h3>
						<p className="ieum-muted-hint">{t("ieum.aiPanelDesc")}</p>

						<div className="ieum-quick-chips">
							{(
								[
									"ieum.aiQuickPolish",
									"ieum.aiQuickSummary",
									"ieum.aiQuickExpand",
								] as const
							).map((chipKey) => (
								<button
									key={chipKey}
									type="button"
									className="ieum-chip-btn"
									disabled={aiBusy}
									data-usage-event="ieumoffice-app.ctrl-22.click" onClick={() => askNaiaToEdit(t(chipKey))}
								>
									{t(chipKey)}
								</button>
							))}
						</div>

						<textarea
							rows={3}
							className="ieum-textarea"
							placeholder={t("ieum.aiPlaceholder")}
							value={aiPrompt}
							onChange={(e) => setAiPrompt(e.target.value)}
						/>

						<div className="ieum-ai-actions">
							<button
								type="button"
								className="ieum-btn full"
								data-testid="ask-naia-edit-btn"
								disabled={aiBusy || !aiPrompt.trim()}
								data-usage-event="ieumoffice-app.ctrl-23.click" onClick={() => askNaiaToEdit()}
							>
								{aiBusy ? t("ieum.aiAsking") : t("ieum.aiAskBtn")}
							</button>
							<button
								type="button"
								className="ieum-btn ghost full"
								data-usage-event="ieumoffice-app.ctrl-24.click" onClick={handleToggleSpeak}
							>
								{speakingId ? t("ieum.aiStopSpeakBtn") : t("ieum.aiSpeakBtn")}
							</button>
							{undoSnapshot && (
								<button
									type="button"
									className="ieum-btn ghost full"
									data-testid="undo-ai-edit-btn"
									data-usage-event="ieumoffice-app.ctrl-25.click" onClick={() => {
										setDoc(undoSnapshot);
										setUndoSnapshot(null);
									}}
								>
									{t("ieum.undoBtn")}
								</button>
							)}
						</div>

						{proposedEdit && (
							<div className="ieum-diff-box" data-testid="ai-diff-box">
								<strong>{proposedEdit.summary}</strong>
								<pre className="ieum-diff-pre">{proposedEdit.nextText}</pre>
								<div className="ieum-diff-btns">
									<button
										type="button"
										className="ieum-btn sm"
										data-testid="apply-ai-edit-btn"
										data-usage-event="ieumoffice-app.ctrl-26.click" onClick={handleApplyProposedEdit}
									>
										{t("ieum.diffApply")}
									</button>
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-usage-event="ieumoffice-app.ctrl-27.click" onClick={() => setProposedEdit(null)}
									>
										{t("ieum.diffDiscard")}
									</button>
								</div>
							</div>
						)}
					</aside>
				</section>
			)}

			{activeTab === "connect" && (
				<section className="ieum-connect-grid" data-testid="connect-panel">
					<div className="ieum-card">
						<div className="ieum-row-between">
							<h3>{t("ieum.connectHeader")}</h3>
							<button
								type="button"
								className="ieum-btn ghost sm"
								disabled={checkingHost}
								data-usage-event="ieumoffice-app.ctrl-28.click" onClick={() => void refreshHostStatus()}
							>
								{t("ieum.recheckBtn")}
							</button>
						</div>

						<div className="ieum-status-strip">
							<span
								className={`ieum-pill-tag ${hostStatus?.installed ? "ok" : "neutral"}`}
							>
								{checkingHost
									? t("ieum.statusChecking")
									: hostStatus?.installed
										? `${t("ieum.statusInstalled")}${hostStatus.version ? ` (${hostStatus.version})` : ""}`
										: t("ieum.statusMissing")}
							</span>
							{hostStatus?.installed && (
								<span
									className={`ieum-pill-tag ${hostStatus.mcpEnabled ? "ok" : "warn"}`}
								>
									{hostStatus.mcpEnabled
										? hostStatus.autoConnected
											? t("ieum.mcpAutoBadge")
											: t("ieum.mcpConnectedBadge")
										: t("ieum.mcpPausedBadge")}
								</span>
							)}
						</div>

						{hostStatus?.binaryPath && (
							<div className="ieum-code-box">
								<div className="ieum-field-label">
									{t("ieum.mcpCommandLabel")}
								</div>
								<code>
									{hostStatus.mcpLaunch
										? `${hostStatus.mcpLaunch.command} ${hostStatus.mcpLaunch.args.join(" ")}`
										: `${hostStatus.binaryPath} mcp`}
								</code>
							</div>
						)}

						<div className="ieum-row-gap">
							{hostStatus?.installed && (
								<button
									type="button"
									className="ieum-btn"
									data-testid="toggle-mcp-btn"
									disabled={checkingHost}
									data-usage-event="ieumoffice-app.ctrl-29.click" onClick={() => void handleToggleMcp()}
								>
									{hostStatus.mcpEnabled
										? t("ieum.mcpToggleOff")
										: t("ieum.mcpToggleOn")}
								</button>
							)}
							{hostStatus?.installed && (
								<button
									type="button"
									className="ieum-btn ghost"
									data-testid="register-coding-agents-btn"
									disabled={checkingHost}
									data-usage-event="ieumoffice-app.ctrl-30.click" onClick={() => void handleRegisterCodingAgents()}
								>
									{t("ieum.codingAgentsBtn")}
								</button>
							)}
						</div>

						{codingAgentsOutput && (
							<pre className="ieum-diff-pre">{codingAgentsOutput}</pre>
						)}
					</div>

					<div className="ieum-two-col">
						<div className="ieum-card">
							<h3>{t("ieum.dir1Title")}</h3>
							<p>{t("ieum.dir1Body")}</p>
							<h4 className="ieum-subhead">{t("ieum.codingAgentsTitle")}</h4>
							<p className="ieum-muted-hint">{t("ieum.codingAgentsDesc")}</p>
							<code className="ieum-inline-cmd">ieumoffice mcp install</code>
						</div>

						<div className="ieum-card">
							<h3>{t("ieum.dir2Title")}</h3>
							<p>{t("ieum.dir2Body")}</p>

							<div className="ieum-preset-box">
								<strong>{t("ieum.cloudPresetTitle")}</strong>
								<div className="ieum-copy-row">
									<input
										readOnly
										aria-label="Naia Cloud Base URL"
										className="ieum-input"
										value={preset.cloudBaseUrl}
									/>
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-usage-event="ieumoffice-app.ctrl-31.click" onClick={() =>
											void copyText("cloud-url", preset.cloudBaseUrl)
										}
									>
										{t("ieum.copyBtn")}
									</button>
								</div>
								<div className="ieum-copy-row">
									<input
										readOnly
										aria-label="Naia Cloud Model"
										className="ieum-input"
										value={preset.cloudModel}
									/>
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-usage-event="ieumoffice-app.ctrl-32.click" onClick={() =>
											void copyText("cloud-model", preset.cloudModel)
										}
									>
										{t("ieum.copyBtn")}
									</button>
								</div>
							</div>

							<div className="ieum-preset-box">
								<strong>{t("ieum.localPresetTitle")}</strong>
								<div className="ieum-copy-row">
									<input
										readOnly
										aria-label="Naia Local Base URL"
										className="ieum-input"
										value={preset.localBaseUrl}
									/>
									<button
										type="button"
										className="ieum-btn ghost sm"
										data-usage-event="ieumoffice-app.ctrl-33.click" onClick={() =>
											void copyText("local-url", preset.localBaseUrl)
										}
									>
										{t("ieum.copyBtn")}
									</button>
								</div>
							</div>

							{copiedKey && (
								<div className="ieum-copied" role="status">
									{t("ieum.copiedNotice")}
								</div>
							)}
						</div>
					</div>
				</section>
			)}

			{activeTab === "download" && (
				<section className="ieum-connect-grid" data-testid="download-panel">
					<div className="ieum-two-col">
						<div className="ieum-card">
							<h3>{t("ieum.downloadRepoTitle")}</h3>
							<p>{t("ieum.downloadRepoDesc")}</p>
							<div className="ieum-copy-row">
								<input
									readOnly
									aria-label="Official Releases URL"
									className="ieum-input"
									data-testid="official-releases-input"
									value={preset.officialReleasesUrl}
								/>
								<button
									type="button"
									className="ieum-btn sm"
									data-usage-event="ieumoffice-app.ctrl-34.click" onClick={() =>
										void copyText("releases", preset.officialReleasesUrl)
									}
								>
									{t("ieum.copyBtn")}
								</button>
							</div>
							<div className="ieum-copy-row">
								<input
									readOnly
									aria-label="Official Repository URL"
									className="ieum-input"
									data-testid="official-repo-input"
									value={preset.officialRepoUrl}
								/>
								<button
									type="button"
									className="ieum-btn ghost sm"
									data-usage-event="ieumoffice-app.ctrl-35.click" onClick={() => void copyText("repo", preset.officialRepoUrl)}
								>
									{t("ieum.copyBtn")}
								</button>
							</div>
						</div>

						<div className="ieum-card">
							<h3>{t("ieum.downloadSiteTitle")}</h3>
							<p>{t("ieum.downloadSiteDesc")}</p>
							<div className="ieum-copy-row">
								<input
									readOnly
									aria-label="Official Site URL"
									className="ieum-input"
									value={preset.officialSiteUrl}
								/>
								<button
									type="button"
									className="ieum-btn ghost sm"
									data-usage-event="ieumoffice-app.ctrl-36.click" onClick={() => void copyText("site", preset.officialSiteUrl)}
								>
									{t("ieum.copyBtn")}
								</button>
							</div>
							{copiedKey && (
								<div className="ieum-copied" role="status">
									{t("ieum.copiedNotice")}
								</div>
							)}
						</div>
					</div>

					<div className="ieum-warn-card">{t("ieum.smartScreenWarn")}</div>
					<p className="ieum-muted-hint">{t("ieum.archNote")}</p>
				</section>
			)}
		</div>
	);
}
