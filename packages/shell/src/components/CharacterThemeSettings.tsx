import { useRef, useState } from "react";
import { useChatStore } from "../stores/chat";
import {
	MAX_CARD_FILE_BYTES,
	type NormalizedCharacterCard,
	type NormalizedLorebookEntry,
	parseCharacterCardBytes,
} from "../apps/charcard/card-parser";
import {
	type CardEditableFieldKey,
	type CardEditablePatch,
	type CharacterTheme,
	type SavedCharacterCard,
	CARD_LIBRARY_MAX_BYTES,
	KIOSK_JINA_CARD_ID,
	KIOSK_JINA_SAVED_CARD,
	KIOSK_JINA_THEME,
	extractCardAvatarImageUrl,
	getModifiedCardFields,
	libraryCard,
	readCharacterLibrary,
	mergeCharacterCard,
	characterCardPatch,
	readCharacterThemes,
	restoreOriginalCard,
	updateNormalizedCard,
} from "../lib/character-theme";
import { loadConfig, saveConfig, type AppConfig } from "../lib/config";
import { getLocale, t } from "../lib/i18n";
import { isKioskDemo } from "../lib/kiosk-demo/flag";
import { Logger } from "../lib/logger";

interface Props {
	config: AppConfig;
	currentTheme: Omit<CharacterTheme, "id" | "name" | "version">;
	onCard: (patch: Partial<AppConfig>, theme?: CharacterTheme) => Promise<void>;
	onCardEdit?: (patch: Partial<AppConfig>) => void;
	onTheme: (theme: CharacterTheme) => Promise<void>;
	onSaveThemes: (themes: CharacterTheme[]) => Promise<void>;
	onPreferences: (patch: Record<string, unknown>) => Promise<void>;
}

export function CharacterThemeSettings({
	config,
	currentTheme,
	onCard,
	onCardEdit,
	onTheme,
	onSaveThemes,
	onPreferences,
}: Props) {
	const streaming = useChatStore((state) => state.isStreaming);

	const [library, setLibrary] = useState<SavedCharacterCard[]>(() => {
		const parsed = readCharacterLibrary(config?.uiPreferences?.b2cCardLibrary);
		if (
			parsed.length === 0 &&
			isKioskDemo() &&
			config?.uiPreferences?.b2cCardLibrary === undefined
		) {
			return [KIOSK_JINA_SAVED_CARD];
		}
		return parsed;
	});
	const initialActiveId =
		typeof config?.uiPreferences?.b2cActiveCardId === "string"
			? config.uiPreferences.b2cActiveCardId
			: isKioskDemo() && config?.uiPreferences?.b2cCardLibrary === undefined
				? KIOSK_JINA_CARD_ID
				: "";
	const initialCard = library.find((c) => c.id === initialActiveId);
	const [card, setCard] = useState<NormalizedCharacterCard | null>(() =>
		initialCard ? libraryCard(initialCard) : null,
	);
	const [originalCard, setOriginalCard] =
		useState<NormalizedCharacterCard | null>(() => {
			if (!initialCard) return null;
			const parsed = libraryCard(initialCard);
			return restoreOriginalCard(
				initialCard.sourceBase64,
				parsed,
				initialCard.id,
			);
		});
	const [cardId, setCardId] = useState(initialCard?.id ?? "");
	const [source, setSource] = useState({
		sourceName: initialCard?.sourceName ?? "",
		sourceBase64: initialCard?.sourceBase64 ?? "",
	});
	const [greetingAutoplay, setGreetingAutoplay] = useState(
		config?.uiPreferences?.b2cGreetingAutoplay !== false,
	);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const [error, setError] = useState("");
	const [status, setStatus] = useState("");
	const [name, setName] = useState("");
	const [themes, setThemes] = useState<CharacterTheme[]>(() => {
		const parsed = readCharacterThemes(config?.uiPreferences?.b2cNvaThemes);
		if (
			parsed.length === 0 &&
			isKioskDemo() &&
			config?.uiPreferences?.b2cNvaThemes === undefined
		) {
			return [KIOSK_JINA_THEME];
		}
		return parsed;
	});
	const [themeId, setThemeId] = useState(initialCard?.themeId ?? "");
	const preview = card
		? characterCardPatch(card, config?.userName, getLocale())
		: null;
	const modifiedFields =
		card && originalCard
			? getModifiedCardFields(card, originalCard)
			: new Set<CardEditableFieldKey>();
	const avatarImageUrl = extractCardAvatarImageUrl(card);

	function syncEditedCardState(
		nextCard: NormalizedCharacterCard,
		baseOriginal: NormalizedCharacterCard,
	) {
		setCard(nextCard);
		const nextPreview = characterCardPatch(
			nextCard,
			config?.userName,
			getLocale(),
		);
		const nextLibrary = cardId
			? library.map((item) =>
					item.id === cardId
						? {
								...item,
								name: nextCard.name,
								rawJson: nextCard.rawJson,
								greeting: nextPreview.greeting,
							}
						: item,
				)
			: library;
		if (cardId) {
			setLibrary(nextLibrary);
		}
		const currentCfg =
			loadConfig() ??
			config ??
			({ provider: "nextain", model: "gpt-5.6-luna", apiKey: "" } as AppConfig);
		const activeId =
			currentCfg?.uiPreferences?.b2cActiveCardId ?? initialActiveId;
		if (cardId && cardId === activeId) {
			const nextUiPrefs = {
				...currentCfg?.uiPreferences,
				b2cCardLibrary: nextLibrary,
				b2cActiveCardId: cardId,
			};
			const patch: Partial<AppConfig> = {
				...nextPreview.patch,
				uiPreferences: nextUiPrefs,
			};
			saveConfig({
				...currentCfg,
				...patch,
			});
			onCardEdit?.(patch);
		}
		void baseOriginal;
	}

	function handleFieldPatch(patch: CardEditablePatch) {
		if (!card) return;
		const baseOrig = originalCard ?? card;
		const nextCard = updateNormalizedCard(card, patch, baseOrig);
		syncEditedCardState(nextCard, baseOrig);
	}

	function handleRevertOriginal() {
		if (!card || !originalCard) return;
		const restored = structuredClone(originalCard);
		syncEditedCardState(restored, restored);
		setStatus("카드 원래대로 되돌렸습니다.");
	}

	function renderModifiedBadge(field: CardEditableFieldKey) {
		if (!modifiedFields.has(field)) return null;
		return (
			<span
				className="charcard-modified-badge"
				data-testid={`card-modified-${field}`}
				style={{
					marginLeft: 6,
					padding: "1px 6px",
					borderRadius: 999,
					fontSize: 11,
					fontWeight: 600,
					background: "rgba(96, 165, 250, 0.18)",
					color: "#93c5fd",
				}}
			>
				카드에서 바꿈
			</span>
		);
	}

	async function run(action: () => Promise<void>) {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError("");
		setStatus("");
		Logger.debug("CharacterThemeSettings", "start settings action");
		try {
			await action();
		} catch {
			setError(t("characterTheme.applyFailed"));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	return (
		<section
			className="settings-field character-theme-settings"
			aria-label={t("characterTheme.sectionLabel")}
			style={{ minWidth: 0, gridColumn: "1 / -1", overflowWrap: "anywhere" }}
		>
			<h3>{t("characterTheme.cardsTitle")}</h3>
			<label>
				<input
					type="checkbox"
					checked={greetingAutoplay}
					disabled={busy}
					onChange={(event) => {
						const enabled = event.target.checked;
						setGreetingAutoplay(enabled);
						void run(async () => {
							try {
								await onPreferences({ b2cGreetingAutoplay: enabled });
							} catch (error) {
								setGreetingAutoplay(!enabled);
								throw error;
							}
						});
					}}
				/>
				{t("characterTheme.greetingAutoplay")}
			</label>
			<p className="settings-hint">{t("characterTheme.cardHint")}</p>
			<label htmlFor="saved-character-card">
				{t("characterTheme.cardLibrary")}
			</label>
			<select
				id="saved-character-card"
				value={cardId}
				disabled={busy}
				style={{ maxWidth: "100%" }}
				onChange={(e) => {
					const saved = library.find((c) => c.id === e.target.value);
					const parsed = saved ? libraryCard(saved) : null;
					setCardId(saved?.id ?? "");
					setCard(parsed);
					setOriginalCard(
						saved && parsed
							? restoreOriginalCard(saved.sourceBase64, parsed, saved.id)
							: null,
					);
					setThemeId(saved?.themeId ?? "");
					setSource(
						saved
							? {
									sourceName: saved.sourceName,
									sourceBase64: saved.sourceBase64,
								}
							: { sourceName: "", sourceBase64: "" },
					);
				}}
			>
				<option value="">{t("characterTheme.chooseSavedCard")}</option>
				{library.map((c) => (
					<option key={c.id} value={c.id}>
						{c.name}
					</option>
				))}
			</select>
			<p className="settings-hint">{t("characterTheme.libraryHint")}</p>
			{cardId && (
				<button
					type="button"
					disabled={busy}
					onClick={() => {
						const binary = atob(source.sourceBase64);
						const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
						const url = URL.createObjectURL(new Blob([bytes]));
						const link = document.createElement("a");
						link.href = url;
						link.download = source.sourceName;
						link.click();
						setTimeout(() => URL.revokeObjectURL(url), 1000);
					}}
				>
					{t("characterTheme.exportCard")}
				</button>
			)}
			{cardId && (
				<button
					type="button"
					disabled={busy}
					onClick={() =>
						void run(async () => {
							const next = library.filter((c) => c.id !== cardId);
							await onPreferences({
								b2cCardLibrary: next,
								...(loadConfig()?.uiPreferences?.b2cActiveCardId === cardId
									? { b2cActiveCardId: undefined }
									: {}),
							});
							setLibrary(next);
							setCardId("");
							setCard(null);
							setOriginalCard(null);
							setStatus(t("characterTheme.cardDeleted"));
						})
					}
				>
					{t("characterTheme.deleteCard")}
				</button>
			)}
			<label htmlFor="character-card-file">
				{t("characterTheme.importCard")}
			</label>
			<input
				id="character-card-file"
				type="file"
				accept=".png,.json"
				disabled={busy}
				style={{ maxWidth: "100%" }}
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (!file) return;
					setCard(null);
					setOriginalCard(null);
					void run(async () => {
						if (file.size > MAX_CARD_FILE_BYTES) {
							setError(t("characterTheme.cardTooLarge"));
							return;
						}
						const bytes = new Uint8Array(await file.arrayBuffer());
						const parsed = await parseCharacterCardBytes(bytes);
						if (!parsed.ok) {
							setError(t("characterTheme.cardUnreadable"));
							return;
						}
						let binary = "";
						for (const byte of bytes) binary += String.fromCharCode(byte);
						setSource({ sourceName: file.name, sourceBase64: btoa(binary) });
						setCardId("");
						setCard(parsed.card);
						setOriginalCard(structuredClone(parsed.card));
					});
				}}
			/>
			{!card && !busy && <p>{t("characterTheme.noCard")}</p>}
			{card && preview && (
				<div
					className="charcard-fields-editor"
					data-testid="charcard-fields-editor"
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 10,
						marginTop: 8,
						padding: 12,
						borderRadius: 10,
						border: "1px solid var(--border-color, rgba(255,255,255,0.14))",
						background: "rgba(15, 23, 42, 0.35)",
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							flexWrap: "wrap",
							gap: 8,
						}}
					>
						<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
							{avatarImageUrl && (
								<img
									src={avatarImageUrl}
									alt={card.name}
									data-testid="charcard-preview-image"
									style={{
										width: 44,
										height: 44,
										borderRadius: 8,
										objectFit: "cover",
										border: "1px solid rgba(255,255,255,0.18)",
									}}
								/>
							)}
							<div>
								<strong>{card.name}</strong>
								{modifiedFields.size > 0 && (
									<span
										className="charcard-modified-summary"
										data-testid="card-field-modified-badge"
										style={{
											marginLeft: 8,
											padding: "2px 8px",
											borderRadius: 999,
											fontSize: 11,
											fontWeight: 600,
											background: "rgba(96, 165, 250, 0.22)",
											color: "#93c5fd",
										}}
									>
										카드에서 바꿈 ({modifiedFields.size})
									</span>
								)}
							</div>
						</div>
						<button
							type="button"
							className="voice-preview-btn"
							data-testid="card-revert-original-btn"
							disabled={busy || modifiedFields.size === 0}
							onClick={handleRevertOriginal}
						>
							카드 원래대로
						</button>
					</div>

					<p
						style={{ whiteSpace: "pre-wrap", maxHeight: 150, overflow: "auto" }}
					>
						{preview.greeting}
					</p>
					{preview.truncated && <p>{t("characterTheme.truncated")}</p>}

					<div className="settings-field">
						<label htmlFor="charcard-field-name">
							이름 (name)
							{renderModifiedBadge("name")}
						</label>
						<input
							id="charcard-field-name"
							data-testid="charcard-field-name"
							type="text"
							className="settings-input"
							value={card.name}
							disabled={busy}
							onChange={(e) => handleFieldPatch({ name: e.target.value })}
						/>
					</div>

					<div className="settings-field">
						<label htmlFor="charcard-field-description">
							소개 (description)
							{renderModifiedBadge("description")}
						</label>
						<textarea
							id="charcard-field-description"
							data-testid="charcard-field-description"
							className="settings-textarea"
							rows={3}
							value={card.description}
							disabled={busy}
							onChange={(e) =>
								handleFieldPatch({ description: e.target.value })
							}
						/>
					</div>

					<div className="settings-field">
						<label htmlFor="charcard-field-personality">
							성격 (personality)
							{renderModifiedBadge("personality")}
						</label>
						<textarea
							id="charcard-field-personality"
							data-testid="charcard-field-personality"
							className="settings-textarea"
							rows={3}
							value={card.personality}
							disabled={busy}
							onChange={(e) =>
								handleFieldPatch({ personality: e.target.value })
							}
						/>
					</div>

					<div className="settings-field">
						<label htmlFor="charcard-field-scenario">
							상황 (scenario)
							{renderModifiedBadge("scenario")}
						</label>
						<textarea
							id="charcard-field-scenario"
							data-testid="charcard-field-scenario"
							className="settings-textarea"
							rows={3}
							value={card.scenario}
							disabled={busy}
							onChange={(e) => handleFieldPatch({ scenario: e.target.value })}
						/>
					</div>

					<div className="settings-field">
						<label htmlFor="charcard-field-first_mes">
							첫 인사 (first_mes / alternate_greetings)
							{renderModifiedBadge("first_mes")}
						</label>
						{(() => {
							const primaryGreeting =
								originalCard?.first_mes || card.first_mes || "";
							const greetingChoices = [
								primaryGreeting,
								...card.alternate_greetings,
							].filter((g, idx, arr) => g.length > 0 && arr.indexOf(g) === idx);
							if (greetingChoices.length === 0) return null;
							return (
								<select
									aria-label="첫 인사 고르기"
									data-testid="charcard-greeting-select"
									className="settings-select"
									value={
										greetingChoices.includes(card.first_mes)
											? card.first_mes
											: ""
									}
									disabled={busy}
									style={{ marginBottom: 6, maxWidth: "100%" }}
									onChange={(e) => {
										if (e.target.value) {
											handleFieldPatch({ first_mes: e.target.value });
										}
									}}
								>
									{!greetingChoices.includes(card.first_mes) && (
										<option value="">직접 고친 첫 인사</option>
									)}
									{greetingChoices.map((g, idx) => (
										<option key={`${idx}-${g.slice(0, 24)}`} value={g}>
											{idx === 0
												? `기본 첫 인사: ${g.slice(0, 36)}`
												: `대체 인사 ${idx}: ${g.slice(0, 36)}`}
										</option>
									))}
								</select>
							);
						})()}
						<textarea
							id="charcard-field-first_mes"
							data-testid="charcard-field-first_mes"
							className="settings-textarea"
							rows={2}
							value={card.first_mes}
							disabled={busy}
							onChange={(e) => handleFieldPatch({ first_mes: e.target.value })}
						/>
						<label
							htmlFor="charcard-field-alternate_greetings"
							style={{ fontSize: 12, marginTop: 4, display: "block" }}
						>
							대체 첫 인사 목록 (줄바꿈으로 구분)
						</label>
						<textarea
							id="charcard-field-alternate_greetings"
							data-testid="charcard-field-alternate_greetings"
							className="settings-textarea"
							rows={2}
							value={card.alternate_greetings.join("\n")}
							disabled={busy}
							onChange={(e) =>
								handleFieldPatch({
									alternate_greetings: e.target.value
										.split("\n")
										.map((s) => s.trim())
										.filter(Boolean),
								})
							}
						/>
					</div>

					<div className="settings-field">
						<label htmlFor="charcard-field-mes_example">
							예시 대화 (mes_example)
							{renderModifiedBadge("mes_example")}
						</label>
						<textarea
							id="charcard-field-mes_example"
							data-testid="charcard-field-mes_example"
							className="settings-textarea"
							rows={3}
							value={card.mes_example}
							disabled={busy}
							onChange={(e) =>
								handleFieldPatch({ mes_example: e.target.value })
							}
						/>
					</div>

					<div className="settings-field" data-testid="charcard-lorebook-list">
						<div
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								gap: 8,
							}}
						>
							<label>
								로어북 항목 목록 (character_book:{" "}
								{card.character_book.entries.length}개)
								{renderModifiedBadge("character_book")}
							</label>
							<button
								type="button"
								className="voice-preview-btn"
								data-testid="charcard-lorebook-add"
								disabled={busy}
								onClick={() => {
									const nextEntry: NormalizedLorebookEntry = {
										id: `entry-${card.character_book.entries.length + 1}`,
										name: `항목 ${card.character_book.entries.length + 1}`,
										comment: "",
										keys: ["키워드"],
										secondary_keys: [],
										content: "새 로어북 지식 내용",
										enabled: true,
										constant: true,
										insertion_order: 10,
										priority: 10,
									};
									handleFieldPatch({
										character_book: {
											...card.character_book,
											entries: [...card.character_book.entries, nextEntry],
										},
									});
								}}
							>
								항목 추가
							</button>
						</div>
						{card.character_book.entries.length === 0 ? (
							<p className="settings-hint">등록된 로어북 항목이 없습니다.</p>
						) : (
							card.character_book.entries.map((entry, idx) => (
								<div
									key={entry.id || idx}
									data-testid={`charcard-lorebook-entry-${idx}`}
									style={{
										padding: 8,
										marginTop: 6,
										borderRadius: 8,
										border: "1px solid rgba(255,255,255,0.12)",
									}}
								>
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: 8,
											marginBottom: 4,
										}}
									>
										<input
											type="checkbox"
											aria-label={`로어북 항목 ${idx + 1} 사용`}
											data-testid={`charcard-lorebook-enabled-${idx}`}
											checked={entry.enabled}
											disabled={busy}
											onChange={(e) => {
												const nextEntries = card.character_book.entries.map(
													(item, i) =>
														i === idx
															? { ...item, enabled: e.target.checked }
															: item,
												);
												handleFieldPatch({
													character_book: {
														...card.character_book,
														entries: nextEntries,
													},
												});
											}}
										/>
										<input
											type="text"
											aria-label={`로어북 항목 ${idx + 1} 키워드`}
											data-testid={`charcard-lorebook-keys-${idx}`}
											className="settings-input"
											value={entry.keys.join(", ")}
											disabled={busy}
											placeholder="키워드 (쉼표 구분)"
											onChange={(e) => {
												const nextKeys = e.target.value
													.split(",")
													.map((s) => s.trim())
													.filter(Boolean);
												const nextEntries = card.character_book.entries.map(
													(item, i) =>
														i === idx ? { ...item, keys: nextKeys } : item,
												);
												handleFieldPatch({
													character_book: {
														...card.character_book,
														entries: nextEntries,
													},
												});
											}}
										/>
									</div>
									<textarea
										aria-label={`로어북 항목 ${idx + 1} 내용`}
										data-testid={`charcard-lorebook-content-${idx}`}
										className="settings-textarea"
										rows={2}
										value={entry.content}
										disabled={busy}
										onChange={(e) => {
											const nextEntries = card.character_book.entries.map(
												(item, i) =>
													i === idx
														? { ...item, content: e.target.value }
														: item,
											);
											handleFieldPatch({
												character_book: {
													...card.character_book,
													entries: nextEntries,
												},
											});
										}}
									/>
								</div>
							))
						)}
					</div>

					<div className="settings-field">
						<label htmlFor="charcard-field-system_prompt">
							카드 쪽 지시 — system_prompt
							{renderModifiedBadge("system_prompt")}
						</label>
						<textarea
							id="charcard-field-system_prompt"
							data-testid="charcard-field-system_prompt"
							className="settings-textarea"
							rows={2}
							value={card.system_prompt}
							disabled={busy}
							onChange={(e) =>
								handleFieldPatch({ system_prompt: e.target.value })
							}
						/>
					</div>

					<div className="settings-field">
						<label htmlFor="charcard-field-post_history_instructions">
							카드 쪽 지시 — post_history
							{renderModifiedBadge("post_history_instructions")}
						</label>
						<textarea
							id="charcard-field-post_history_instructions"
							data-testid="charcard-field-post_history_instructions"
							className="settings-textarea"
							rows={2}
							value={card.post_history_instructions}
							disabled={busy}
							onChange={(e) =>
								handleFieldPatch({
									post_history_instructions: e.target.value,
								})
							}
						/>
					</div>

					<div className="settings-field">
						<label htmlFor="charcard-field-creator">
							만든 사람 (creator)
							{renderModifiedBadge("creator")}
						</label>
						<input
							id="charcard-field-creator"
							data-testid="charcard-field-creator"
							type="text"
							className="settings-input"
							value={card.creator}
							disabled={busy}
							onChange={(e) => handleFieldPatch({ creator: e.target.value })}
						/>
					</div>

					<div className="settings-field">
						<label htmlFor="charcard-field-creator_notes">
							메모 (creator_notes)
							{renderModifiedBadge("creator_notes")}
						</label>
						<textarea
							id="charcard-field-creator_notes"
							data-testid="charcard-field-creator_notes"
							className="settings-textarea"
							rows={2}
							value={card.creator_notes}
							disabled={busy}
							onChange={(e) =>
								handleFieldPatch({ creator_notes: e.target.value })
							}
						/>
					</div>

					<div className="settings-field">
						<label htmlFor="charcard-field-tags">
							꼬리표 (tags)
							{renderModifiedBadge("tags")}
						</label>
						<input
							id="charcard-field-tags"
							data-testid="charcard-field-tags"
							type="text"
							className="settings-input"
							value={card.tags.join(", ")}
							disabled={busy}
							onChange={(e) =>
								handleFieldPatch({
									tags: e.target.value
										.split(",")
										.map((s) => s.trim())
										.filter(Boolean),
								})
							}
						/>
					</div>

					<button
						type="button"
						className="settings-save-btn"
						data-testid="charcard-apply-btn"
						disabled={busy || streaming}
						onClick={() =>
							void run(async () => {
								if (useChatStore.getState().isStreaming)
									throw new Error("chat in progress");
								const incoming: SavedCharacterCard = {
									version: 1,
									id: cardId || crypto.randomUUID(),
									name: card.name,
									rawJson: card.rawJson,
									greeting: preview.greeting,
									...source,
									...(themeId ? { themeId } : {}),
								};
								const { card: saved, cards: next } = mergeCharacterCard(
									library,
									incoming,
								);
								if (
									next.length > 30 ||
									JSON.stringify(next).length > CARD_LIBRARY_MAX_BYTES
								)
									throw new Error("library limit");
								const selectedTheme = themes.find(
									(t) => t.id === saved.themeId,
								);
								useChatStore.setState({ characterTransitionPending: true });
								try {
									await onCard(
										{
											...preview.patch,
											uiPreferences: {
												...loadConfig()?.uiPreferences,
												b2cCardLibrary: next,
												b2cActiveCardId: saved.id,
											},
										},
										selectedTheme,
									);
									setLibrary(next);
									setCardId(saved.id);
									window.dispatchEvent(
										new Event("naia-character-new-conversation"),
									);
								} finally {
									useChatStore.setState({ characterTransitionPending: false });
								}
								setStatus(t("characterTheme.cardApplied"));
							})
						}
					>
						{t("characterTheme.applyCard")}
					</button>
				</div>
			)}
			<h3>{t("characterTheme.themesTitle")}</h3>
			<p className="settings-hint">{t("characterTheme.themesHint")}</p>
			<label htmlFor="character-theme-name">
				{t("characterTheme.themeName")}
			</label>
			<input
				id="character-theme-name"
				className="settings-input"
				maxLength={80}
				value={name}
				disabled={busy}
				onChange={(e) => setName(e.target.value)}
			/>
			<button
				type="button"
				disabled={
					busy || !name.trim() || !currentTheme.nvaModel || themes.length >= 30
				}
				onClick={() =>
					void run(async () => {
						const theme: CharacterTheme = {
							...currentTheme,
							version: 1,
							id: crypto.randomUUID(),
							name: name.trim(),
						};
						if (readCharacterThemes([theme]).length !== 1)
							throw new Error("invalid theme");
						const next = [...themes, theme];
						await onSaveThemes(next);
						setThemes(next);
						setName("");
						setThemeId(theme.id);
						setStatus(t("characterTheme.themeSaved"));
					})
				}
			>
				{t("characterTheme.saveTheme")}
			</button>
			{themes.length === 0 ? (
				<p>{t("characterTheme.noThemes")}</p>
			) : (
				<>
					<label htmlFor="character-theme-select">
						{t("characterTheme.savedThemes")}
					</label>
					<select
						id="character-theme-select"
						className="settings-select"
						value={themeId}
						disabled={busy}
						onChange={(e) => setThemeId(e.target.value)}
					>
						<option value="">{t("characterTheme.selectTheme")}</option>
						{themes.map((theme) => (
							<option key={theme.id} value={theme.id}>
								{theme.name}
							</option>
						))}
					</select>
					<button
						type="button"
						disabled={busy || !themeId}
						onClick={() =>
							void run(async () => {
								const theme = themes.find((t) => t.id === themeId);
								if (!theme) return;
								await onTheme(theme);
								setStatus(t("characterTheme.themeApplied"));
							})
						}
					>
						{t("characterTheme.applyTheme")}
					</button>
				</>
			)}
			{themeId && (
				<div>
					<button
						type="button"
						disabled={busy || !name.trim() || !currentTheme.nvaModel}
						onClick={() =>
							void run(async () => {
								const next = themes.map((t) =>
									t.id === themeId
										? {
												...currentTheme,
												version: 1 as const,
												id: t.id,
												name: name.trim(),
											}
										: t,
								);
								if (readCharacterThemes(next).length !== next.length)
									throw new Error("invalid theme");
								await onSaveThemes(next);
								setThemes(next);
								setStatus(t("characterTheme.themeUpdated"));
							})
						}
					>
						{t("characterTheme.updateTheme")}
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								const next = themes.filter((t) => t.id !== themeId);
								const cards = library.map((c) =>
									c.themeId === themeId ? { ...c, themeId: undefined } : c,
								);
								await onPreferences({
									b2cNvaThemes: next,
									b2cCardLibrary: cards,
								});
								setThemes(next);
								setLibrary(cards);
								setThemeId("");
								setStatus(t("characterTheme.themeDeleted"));
							})
						}
					>
						{t("characterTheme.deleteTheme")}
					</button>
				</div>
			)}
			{busy && (
				<output style={{ display: "block" }}>
					{t("characterTheme.working")}
				</output>
			)}
			{status && <output style={{ display: "block" }}>{status}</output>}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}
