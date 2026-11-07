import { useRef, useState } from "react";
import { useChatStore } from "../stores/chat";
import {
	MAX_CARD_FILE_BYTES,
	type NormalizedCharacterCard,
	parseCharacterCardBytes,
} from "../apps/charcard/card-parser";
import {
	type CharacterTheme,
	type SavedCharacterCard,
	CARD_LIBRARY_MAX_BYTES,
	libraryCard,
	readCharacterLibrary,
	mergeCharacterCard,
	characterCardPatch,
	readCharacterThemes,
} from "../lib/character-theme";
import { loadConfig, type AppConfig } from "../lib/config";
import { getLocale, t } from "../lib/i18n";
import { Logger } from "../lib/logger";

interface Props {
	config: AppConfig;
	currentTheme: Omit<CharacterTheme, "id" | "name" | "version">;
	onCard: (patch: Partial<AppConfig>, theme?: CharacterTheme) => Promise<void>;
	onTheme: (theme: CharacterTheme) => Promise<void>;
	onSaveThemes: (themes: CharacterTheme[]) => Promise<void>;
	onPreferences: (patch: Record<string, unknown>) => Promise<void>;
}

export function CharacterThemeSettings({
	config,
	currentTheme,
	onCard,
	onTheme,
	onSaveThemes,
	onPreferences,
}: Props) {
	const streaming = useChatStore((state) => state.isStreaming);

	const [library, setLibrary] = useState(() =>
		readCharacterLibrary(config.uiPreferences?.b2cCardLibrary),
	);
	const initialCard = library.find(
		(c) => c.id === config.uiPreferences?.b2cActiveCardId,
	);
	const [card, setCard] = useState<NormalizedCharacterCard | null>(() =>
		initialCard ? libraryCard(initialCard) : null,
	);
	const [cardId, setCardId] = useState(initialCard?.id ?? "");
	const [source, setSource] = useState({
		sourceName: initialCard?.sourceName ?? "",
		sourceBase64: initialCard?.sourceBase64 ?? "",
	});
	const [greetingAutoplay, setGreetingAutoplay] = useState(
		config.uiPreferences?.b2cGreetingAutoplay !== false,
	);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const [error, setError] = useState("");
	const [status, setStatus] = useState("");
	const [name, setName] = useState("");
	const [themes, setThemes] = useState(() =>
		readCharacterThemes(config.uiPreferences?.b2cNvaThemes),
	);
	const [themeId, setThemeId] = useState(initialCard?.themeId ?? "");
	const preview = card
		? characterCardPatch(card, config.userName, getLocale())
		: null;

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
					setCardId(saved?.id ?? "");
					setCard(saved ? libraryCard(saved) : null);
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
					});
				}}
			/>
			{!card && !busy && <p>{t("characterTheme.noCard")}</p>}
			{card && preview && (
				<div>
					<strong>{card.name}</strong>
					<p
						style={{ whiteSpace: "pre-wrap", maxHeight: 150, overflow: "auto" }}
					>
						{preview.greeting}
					</p>
					{preview.truncated && <p>{t("characterTheme.truncated")}</p>}
					<button
						type="button"
						className="settings-save-btn"
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
