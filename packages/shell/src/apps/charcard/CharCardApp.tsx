import { useEffect, useMemo, useRef, useState } from "react";
import { Logger } from "../../lib/logger";
import {
	type CardParseErrorCode,
	parseCharacterCardBytes,
} from "./card-parser";
import {
	type CardStorageAdapter,
	type StoredCardRecord,
	createCardStorage,
} from "./card-store";
import {
	type CharCardMessageKey,
	charCardText,
	resolveCharCardLocale,
} from "./locales/messages";
import {
	type BuildRoleplayPromptResult,
	MAX_SERIALIZED_CONTEXT_CHARS,
	type RoleplayContextPayload,
	buildRoleplayPrompt,
	measureSerializedContextLength,
	replaceCardMacros,
} from "./prompt-builder";
import { getBundledSampleCardRecords } from "./sample-cards";
import "./charcard.css";

const TAG = "CharCardApp";

export type CharCardUiErrorCode = CardParseErrorCode | "CONTEXT_TOO_LARGE";

export interface CharCardContextBridge {
	pushContext: (context: RoleplayContextPayload | null) => void;
}

export interface CharCardAppProps {
	bridge?: CharCardContextBridge;
	storage?: CardStorageAdapter;
	localeOverride?: string;
}

interface PendingStorageError {
	kind: "save" | "delete";
	record: StoredCardRecord;
}

const defaultBridge: CharCardContextBridge = {
	pushContext(context) {
		window.parent.postMessage({ type: "naia-app:context", context }, "*");
	},
};

function getInitialChar(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "?";
	return Array.from(trimmed)[0]?.toUpperCase() ?? "?";
}

async function readFileBytes(file: File): Promise<Uint8Array> {
	if (typeof file.arrayBuffer === "function") {
		const buf = await file.arrayBuffer();
		return new Uint8Array(buf);
	}
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (reader.result instanceof ArrayBuffer) {
				resolve(new Uint8Array(reader.result));
			} else {
				reject(new Error("Failed to read file ArrayBuffer"));
			}
		};
		reader.onerror = () =>
			reject(reader.error ?? new Error("FileReader error"));
		reader.readAsArrayBuffer(file);
	});
}

export function CharCardApp({
	bridge = defaultBridge,
	storage: injectedStorage,
	localeOverride,
}: CharCardAppProps) {
	const locale = resolveCharCardLocale(localeOverride);
	const msg = (
		key: CharCardMessageKey,
		params?: Readonly<Record<string, string | number>>,
	) => charCardText(key, params, locale);

	const samples = useMemo(() => getBundledSampleCardRecords(), []);
	const [importedCards, setImportedCards] = useState<StoredCardRecord[]>([]);
	const [storageMode, setStorageMode] = useState<"indexeddb" | "memory">(
		"indexeddb",
	);
	const [selectedCardId, setSelectedCardId] = useState<string>(
		samples[0]?.id ?? "",
	);
	const [greetingIndex, setGreetingIndex] = useState<number>(0);
	const [userName, setUserName] = useState<string>("");
	const [activeCardId, setActiveCardId] = useState<string | null>(null);
	const [activeResult, setActiveResult] =
		useState<BuildRoleplayPromptResult | null>(null);
	const [errorCode, setErrorCode] = useState<CharCardUiErrorCode | null>(null);
	const [storageError, setStorageError] = useState<PendingStorageError | null>(
		null,
	);
	const [pendingDeleteRecord, setPendingDeleteRecord] =
		useState<StoredCardRecord | null>(null);
	const [dragOver, setDragOver] = useState<boolean>(false);

	const storageRef = useRef<CardStorageAdapter | null>(injectedStorage ?? null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const deleteTriggerButtonRef = useRef<HTMLButtonElement>(null);
	const cancelDeleteButtonRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		let cancelled = false;
		async function initStorage() {
			const store = injectedStorage ?? (await createCardStorage());
			if (cancelled) return;
			storageRef.current = store;
			setStorageMode(store.mode);
			try {
				const saved = await store.listCards();
				if (cancelled) return;
				setImportedCards(saved);
			} catch (err) {
				Logger.warn(TAG, "failed to load stored cards", {
					error: String(err),
				});
			}
		}
		void initStorage();
		return () => {
			cancelled = true;
		};
	}, [injectedStorage]);

	useEffect(() => {
		if (!pendingDeleteRecord) return;
		cancelDeleteButtonRef.current?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				setPendingDeleteRecord(null);
				deleteTriggerButtonRef.current?.focus();
				queueMicrotask(() => {
					deleteTriggerButtonRef.current?.focus();
				});
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [pendingDeleteRecord]);

	const allCards = useMemo(
		() => [...importedCards, ...samples],
		[importedCards, samples],
	);

	const selectedRecord = useMemo(
		() =>
			allCards.find((item) => item.id === selectedCardId) ??
			allCards[0] ??
			null,
		[allCards, selectedCardId],
	);

	const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
	useEffect(() => {
		const blob = selectedRecord?.imageBlob ?? null;
		if (!blob) {
			setAvatarUrl(null);
			return;
		}
		if (typeof URL.createObjectURL !== "function") {
			setAvatarUrl(`blob:charcard-${selectedRecord?.id ?? "preview"}`);
			return;
		}
		let url = "";
		try {
			url = URL.createObjectURL(blob);
			setAvatarUrl(url);
		} catch {
			setAvatarUrl(`blob:charcard-${selectedRecord?.id ?? "preview"}`);
		}
		return () => {
			if (url && typeof URL.revokeObjectURL === "function") {
				URL.revokeObjectURL(url);
			}
		};
	}, [selectedRecord]);

	const greetingsList = useMemo(() => {
		if (!selectedRecord) return [];
		const { first_mes, alternate_greetings } = selectedRecord.card;
		const list = [first_mes, ...alternate_greetings];
		return list.map((text, index) => ({
			optionKey: `greeting-${index}`,
			optionValue: index,
			text,
		}));
	}, [selectedRecord]);

	const safeGreetingIndex =
		greetingIndex >= 0 && greetingIndex < greetingsList.length
			? greetingIndex
			: 0;
	const rawSelectedGreeting = greetingsList[safeGreetingIndex]?.text ?? "";

	const effectiveUserName = userName.trim() || msg("charcard.defaultUserName");

	const previewGreeting = useMemo(() => {
		if (!selectedRecord) return "";
		return replaceCardMacros(
			rawSelectedGreeting,
			selectedRecord.card.name,
			effectiveUserName,
		).trim();
	}, [selectedRecord, rawSelectedGreeting, effectiveUserName]);

	const previewPromptResult = useMemo(() => {
		if (!selectedRecord) return null;
		return buildRoleplayPrompt(selectedRecord.card, {
			userName: effectiveUserName,
			selectedGreeting: rawSelectedGreeting,
			locale,
		});
	}, [selectedRecord, effectiveUserName, rawSelectedGreeting, locale]);

	const activeLorebookCount = useMemo(() => {
		if (!selectedRecord) return 0;
		return selectedRecord.card.character_book.entries.filter(
			(e) => e.enabled && e.content.trim().length > 0,
		).length;
	}, [selectedRecord]);

	async function persistImportedRecord(record: StoredCardRecord) {
		if (storageRef.current) {
			try {
				await storageRef.current.saveCard(record);
			} catch (err) {
				Logger.warn(TAG, "failed saving card to storage", {
					error: String(err),
				});
				setStorageError({ kind: "save", record });
				return;
			}
		}
		setStorageError(null);
		setImportedCards((prev) => [
			record,
			...prev.filter((item) => item.id !== record.id),
		]);
		setSelectedCardId(record.id);
		setGreetingIndex(0);
	}

	async function handleFileImport(file: File) {
		Logger.info(TAG, "importing card file", {
			fileName: file.name,
			size: file.size,
		});
		setErrorCode(null);
		setStorageError(null);
		if (file.size > 20 * 1024 * 1024) {
			setErrorCode("FILE_TOO_LARGE");
			return;
		}
		let bytes: Uint8Array;
		try {
			bytes = await readFileBytes(file);
		} catch (err) {
			Logger.warn(TAG, "failed reading file bytes", { error: String(err) });
			setErrorCode("NOT_PNG_OR_JSON");
			return;
		}
		const result = parseCharacterCardBytes(bytes, file.name);
		if (!result.ok) {
			Logger.warn(TAG, "card parse rejected", {
				fileName: file.name,
				code: result.code,
				detail: result.detail,
			});
			setErrorCode(result.code);
			return;
		}

		const id = `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const imageBlob =
			result.card.sourceFormat === "png"
				? new Blob([new Uint8Array(bytes)], { type: "image/png" })
				: null;

		const record: StoredCardRecord = {
			id,
			fileName: file.name,
			importedAt: Date.now(),
			card: result.card,
			rawJson: result.card.rawJson,
			imageBlob,
			builtIn: false,
		};

		await persistImportedRecord(record);
	}

	function triggerFilePicker() {
		setErrorCode(null);
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
			fileInputRef.current.click();
		}
	}

	function handleStartRoleplay() {
		if (!selectedRecord || !previewPromptResult) return;
		const serializedLength = measureSerializedContextLength(
			previewPromptResult.context,
		);
		if (serializedLength > MAX_SERIALIZED_CONTEXT_CHARS) {
			Logger.warn(TAG, "roleplay context exceeds shell limit", {
				serializedLength,
			});
			setErrorCode("CONTEXT_TOO_LARGE");
			return;
		}
		Logger.info(TAG, "starting character roleplay", {
			cardId: selectedRecord.id,
			character: selectedRecord.card.name,
		});
		setErrorCode(null);
		bridge.pushContext(previewPromptResult.context);
		setActiveCardId(selectedRecord.id);
		setActiveResult(previewPromptResult);
	}

	function handleStopRoleplay() {
		Logger.info(TAG, "stopping character roleplay");
		bridge.pushContext(null);
		setActiveCardId(null);
		setActiveResult(null);
	}

	function requestDeleteCard(record: StoredCardRecord) {
		if (record.builtIn) return;
		setStorageError(null);
		setPendingDeleteRecord(record);
	}

	function cancelDeleteCard() {
		setPendingDeleteRecord(null);
		deleteTriggerButtonRef.current?.focus();
		queueMicrotask(() => {
			deleteTriggerButtonRef.current?.focus();
		});
	}

	async function executeDeleteCard(record: StoredCardRecord) {
		if (record.builtIn) return;
		Logger.info(TAG, "deleting imported card", {
			cardId: record.id,
			name: record.card.name,
		});
		setPendingDeleteRecord(null);
		if (storageRef.current) {
			try {
				await storageRef.current.removeCard(record.id);
			} catch (err) {
				Logger.warn(TAG, "failed removing card from storage", {
					error: String(err),
				});
				setStorageError({ kind: "delete", record });
				deleteTriggerButtonRef.current?.focus();
				return;
			}
		}
		setStorageError(null);
		if (activeCardId === record.id) {
			bridge.pushContext(null);
			setActiveCardId(null);
			setActiveResult(null);
		}
		const remaining = importedCards.filter((item) => item.id !== record.id);
		setImportedCards(remaining);
		if (selectedCardId === record.id) {
			const next = remaining[0] ?? samples[0];
			setSelectedCardId(next?.id ?? "");
			setGreetingIndex(0);
		}
	}

	async function handleRetryStorageAction() {
		if (!storageError) return;
		const { kind, record } = storageError;
		if (kind === "save") {
			await persistImportedRecord(record);
		} else {
			await executeDeleteCard(record);
		}
	}

	const isCurrentCardActive =
		Boolean(selectedRecord) && activeCardId === selectedRecord?.id;
	const activeRecord = useMemo(
		() => allCards.find((item) => item.id === activeCardId) ?? null,
		[allCards, activeCardId],
	);

	return (
		<section className="charcard-app" aria-label={msg("charcard.title")}>
			<header className="charcard-app__header">
				<div>
					<h1>{msg("charcard.title")}</h1>
					<p>{msg("charcard.subtitle")}</p>
				</div>
				<div className="charcard-app__header-actions">
					<button
						type="button"
						className="charcard-app__btn charcard-app__btn--primary"
						onClick={triggerFilePicker}
						data-testid="charcard-import-button"
					>
						{msg("charcard.importButton")}
					</button>
					<input
						ref={fileInputRef}
						type="file"
						accept=".png,.json,image/png,application/json"
						className="charcard-app__file-input"
						data-testid="charcard-file-input"
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) void handleFileImport(file);
						}}
					/>
				</div>
			</header>

			{storageMode === "memory" ? (
				<div
					className="charcard-app__notice charcard-app__notice--warn"
					data-testid="charcard-memory-banner"
				>
					{msg("charcard.memoryOnlyBanner")}
				</div>
			) : null}

			{activeRecord ? (
				<div
					className="charcard-app__active-bar"
					data-testid="charcard-active-banner"
				>
					<div className="charcard-app__active-info">
						<span className="charcard-app__active-dot" />
						<strong>
							{msg("charcard.activeBanner", { name: activeRecord.card.name })}
						</strong>
						<span>
							{msg("charcard.activeHint", { name: activeRecord.card.name })}
						</span>
					</div>
					<button
						type="button"
						className="charcard-app__btn charcard-app__btn--danger"
						onClick={handleStopRoleplay}
						data-testid="charcard-stop-banner-button"
					>
						{msg("charcard.stopRoleplay")}
					</button>
				</div>
			) : null}

			<div className="charcard-app__body">
				<aside
					className={`charcard-app__sidebar ${dragOver ? "charcard-app__sidebar--drag" : ""}`}
					aria-label={msg("charcard.cardListLabel")}
					onDragOver={(e) => {
						e.preventDefault();
						setDragOver(true);
					}}
					onDragLeave={() => setDragOver(false)}
					onDrop={(e) => {
						e.preventDefault();
						setDragOver(false);
						const file = e.dataTransfer?.files?.[0];
						if (file) void handleFileImport(file);
					}}
				>
					<button
						type="button"
						className="charcard-app__dropzone"
						onClick={triggerFilePicker}
					>
						<span>{msg("charcard.importDropHint")}</span>
					</button>

					<ul className="charcard-app__list" data-testid="charcard-list">
						{allCards.map((item) => {
							const isSelected = item.id === selectedRecord?.id;
							const isPlaying = item.id === activeCardId;
							return (
								<li key={item.id} className="charcard-app__list-item">
									<button
										type="button"
										className={`charcard-app__card-row ${isSelected ? "charcard-app__card-row--selected" : ""}`}
										onClick={() => {
											setErrorCode(null);
											setSelectedCardId(item.id);
											setGreetingIndex(0);
										}}
										data-testid={`charcard-item-${item.id}`}
									>
										<span className="charcard-app__card-initial">
											{getInitialChar(item.card.name)}
										</span>
										<span className="charcard-app__card-meta">
											<span className="charcard-app__card-name">
												{item.card.name}
											</span>
											<span className="charcard-app__card-badges">
												<span className="charcard-app__badge">
													{item.builtIn
														? msg("charcard.sampleBadge")
														: msg("charcard.importedBadge")}
												</span>
												<span className="charcard-app__badge">
													{item.card.specVersion.toUpperCase()}
												</span>
												{isPlaying ? (
													<span className="charcard-app__badge charcard-app__badge--playing">
														●
													</span>
												) : null}
											</span>
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</aside>

				<main className="charcard-app__detail">
					{errorCode ? (
						<div
							className="charcard-app__error-panel"
							role="alert"
							data-testid="charcard-error-panel"
						>
							<h2>{msg("charcard.errorTitle")}</h2>
							<p>{msg(`charcard.error.${errorCode}`)}</p>
							<div className="charcard-app__error-actions">
								<button
									type="button"
									className="charcard-app__btn charcard-app__btn--primary"
									onClick={triggerFilePicker}
									data-testid="charcard-error-retry"
								>
									{msg("charcard.errorChooseAnother")}
								</button>
								<button
									type="button"
									className="charcard-app__btn"
									onClick={() => setErrorCode(null)}
									data-testid="charcard-error-dismiss"
								>
									{msg("charcard.errorDismiss")}
								</button>
							</div>
						</div>
					) : null}

					{storageError ? (
						<div
							className="charcard-app__error-panel"
							role="alert"
							data-testid="charcard-storage-error"
						>
							<p>
								{msg(
									storageError.kind === "save"
										? "charcard.storageErrorSave"
										: "charcard.storageErrorDelete",
								)}
							</p>
							<div className="charcard-app__error-actions">
								<button
									type="button"
									className="charcard-app__btn charcard-app__btn--primary"
									onClick={() => void handleRetryStorageAction()}
									data-testid="charcard-storage-retry"
								>
									{msg("charcard.storageErrorRetry")}
								</button>
								<button
									type="button"
									className="charcard-app__btn"
									onClick={() => setStorageError(null)}
									data-testid="charcard-storage-dismiss"
								>
									{msg("charcard.storageErrorDismiss")}
								</button>
							</div>
						</div>
					) : null}

					{selectedRecord ? (
						<div className="charcard-app__detail-content">
							<div className="charcard-app__profile">
								<div
									className="charcard-app__avatar"
									data-testid="charcard-avatar"
								>
									{avatarUrl ? (
										<img
											src={avatarUrl}
											alt={selectedRecord.card.name}
											className="charcard-app__avatar-img"
											data-testid="charcard-avatar-img"
										/>
									) : (
										<span
											className="charcard-app__avatar-letter"
											data-testid="charcard-avatar-letter"
										>
											{getInitialChar(selectedRecord.card.name)}
										</span>
									)}
								</div>

								<div className="charcard-app__profile-info">
									<div className="charcard-app__title-row">
										<h2 data-testid="charcard-detail-name">
											{selectedRecord.card.name}
										</h2>
										<span className="charcard-app__badge">
											{selectedRecord.card.specVersion.toUpperCase()} ·{" "}
											{selectedRecord.card.sourceFormat.toUpperCase()}
										</span>
									</div>

									<p className="charcard-app__creator">
										<strong>{msg("charcard.creatorLabel")}:</strong>{" "}
										{selectedRecord.card.creator ||
											msg("charcard.creatorUnknown")}
									</p>

									{selectedRecord.card.tags.length > 0 ? (
										<div
											className="charcard-app__tags"
											aria-label={msg("charcard.tagsLabel")}
										>
											{selectedRecord.card.tags.map((tag) => (
												<span key={tag} className="charcard-app__tag">
													#{tag}
												</span>
											))}
										</div>
									) : null}
								</div>
							</div>

							<div className="charcard-app__controls-card">
								<div className="charcard-app__field-row">
									<label htmlFor="charcard-user-name">
										{msg("charcard.userNameLabel")}
									</label>
									<input
										id="charcard-user-name"
										type="text"
										value={userName}
										placeholder={msg("charcard.userNamePlaceholder")}
										onChange={(e) => setUserName(e.target.value)}
										data-testid="charcard-username-input"
									/>
								</div>

								{greetingsList.length > 1 ? (
									<div className="charcard-app__field-row">
										<label htmlFor="charcard-greeting-select">
											{msg("charcard.greetingSelectLabel")}
										</label>
										<select
											id="charcard-greeting-select"
											value={safeGreetingIndex}
											onChange={(e) => setGreetingIndex(Number(e.target.value))}
											data-testid="charcard-greeting-select"
										>
											{greetingsList.map((opt) => (
												<option key={opt.optionKey} value={opt.optionValue}>
													{opt.optionValue === 0
														? msg("charcard.greetingOptionDefault")
														: msg("charcard.greetingOptionAlt", {
																index: opt.optionValue,
															})}
												</option>
											))}
										</select>
									</div>
								) : null}

								<div className="charcard-app__action-buttons">
									<button
										type="button"
										className="charcard-app__btn charcard-app__btn--primary"
										onClick={handleStartRoleplay}
										data-testid="charcard-start-button"
									>
										{isCurrentCardActive
											? msg("charcard.updateRoleplay")
											: msg("charcard.startRoleplay")}
									</button>

									{isCurrentCardActive ? (
										<button
											type="button"
											className="charcard-app__btn charcard-app__btn--danger"
											onClick={handleStopRoleplay}
											data-testid="charcard-stop-button"
										>
											{msg("charcard.stopRoleplay")}
										</button>
									) : null}

									{!selectedRecord.builtIn ? (
										<button
											ref={deleteTriggerButtonRef}
											type="button"
											className="charcard-app__btn charcard-app__btn--secondary"
											onClick={() => requestDeleteCard(selectedRecord)}
											data-testid="charcard-delete-button"
										>
											{msg("charcard.deleteCard")}
										</button>
									) : null}
								</div>
							</div>

							{(isCurrentCardActive ? activeResult : previewPromptResult)
								?.truncated ? (
								<div
									className="charcard-app__notice charcard-app__notice--warn"
									data-testid="charcard-truncated-notice"
								>
									{msg("charcard.truncatedNotice", {
										parts: (
											(isCurrentCardActive
												? activeResult?.truncatedParts
												: previewPromptResult?.truncatedParts) ?? []
										)
											.map((part) => msg(`charcard.truncatedPart.${part}`))
											.join(", "),
									})}
								</div>
							) : null}

							<div className="charcard-app__greeting-box">
								<h3>{msg("charcard.greetingPreviewTitle")}</h3>
								<blockquote
									className="charcard-app__speech-bubble"
									data-testid="charcard-greeting-bubble"
								>
									{previewGreeting || msg("charcard.greetingEmpty")}
								</blockquote>
							</div>

							{selectedRecord.card.creator_notes ? (
								<details className="charcard-app__Section-collapse">
									<summary>{msg("charcard.creatorNotesSummary")}</summary>
									<p className="charcard-app__plain-text">
										{selectedRecord.card.creator_notes}
									</p>
								</details>
							) : null}

							{selectedRecord.card.description ? (
								<div className="charcard-app__section">
									<h3>{msg("charcard.descriptionSection")}</h3>
									<p
										className="charcard-app__plain-text"
										data-testid="charcard-description-text"
									>
										{replaceCardMacros(
											selectedRecord.card.description,
											selectedRecord.card.name,
											effectiveUserName,
										)}
									</p>
								</div>
							) : null}

							{selectedRecord.card.personality ? (
								<div className="charcard-app__section">
									<h3>{msg("charcard.personalitySection")}</h3>
									<p className="charcard-app__plain-text">
										{replaceCardMacros(
											selectedRecord.card.personality,
											selectedRecord.card.name,
											effectiveUserName,
										)}
									</p>
								</div>
							) : null}

							{selectedRecord.card.scenario ? (
								<div className="charcard-app__section">
									<h3>{msg("charcard.scenarioSection")}</h3>
									<p className="charcard-app__plain-text">
										{replaceCardMacros(
											selectedRecord.card.scenario,
											selectedRecord.card.name,
											effectiveUserName,
										)}
									</p>
								</div>
							) : null}

							{activeLorebookCount > 0 ? (
								<div className="charcard-app__section">
									<h3>
										{msg("charcard.lorebookSection", {
											count: activeLorebookCount,
										})}
									</h3>
									<ul className="charcard-app__lore-list">
										{selectedRecord.card.character_book.entries
											.filter((e) => e.enabled && e.content.trim().length > 0)
											.map((entry) => (
												<li key={entry.id} className="charcard-app__lore-item">
													<strong>
														{entry.name || entry.keys.join(", ") || entry.id}
													</strong>
													<span>
														{replaceCardMacros(
															entry.content,
															selectedRecord.card.name,
															effectiveUserName,
														)}
													</span>
												</li>
											))}
									</ul>
								</div>
							) : null}
						</div>
					) : (
						<div className="charcard-app__empty">
							<p>{msg("charcard.noCardSelected")}</p>
						</div>
					)}
				</main>
			</div>

			{pendingDeleteRecord ? (
				<div
					className="charcard-app__modal-backdrop"
					data-testid="charcard-delete-dialog-backdrop"
				>
					<div
						className="charcard-app__modal"
						role="alertdialog"
						aria-modal="true"
						aria-labelledby="charcard-delete-dialog-title"
						aria-describedby="charcard-delete-dialog-desc"
						data-testid="charcard-delete-dialog"
					>
						<h2 id="charcard-delete-dialog-title">
							{msg("charcard.deleteConfirmTitle")}
						</h2>
						<p id="charcard-delete-dialog-desc">
							{msg("charcard.deleteConfirm", {
								name: pendingDeleteRecord.card.name,
							})}
						</p>
						<div className="charcard-app__modal-actions">
							<button
								ref={cancelDeleteButtonRef}
								type="button"
								className="charcard-app__btn"
								onClick={cancelDeleteCard}
								data-testid="charcard-delete-cancel"
							>
								{msg("charcard.deleteCancelAction")}
							</button>
							<button
								type="button"
								className="charcard-app__btn charcard-app__btn--danger"
								onClick={() => void executeDeleteCard(pendingDeleteRecord)}
								data-testid="charcard-delete-confirm"
							>
								{msg("charcard.deleteConfirmAction")}
							</button>
						</div>
					</div>
				</div>
			) : null}
		</section>
	);
}
