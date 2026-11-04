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
import { getLocale } from "../lib/i18n";
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
	const ko = getLocale() === "ko";
	const copy = (en: string, kr: string) => (ko ? kr : en);

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
			setError(
				copy(
					"Could not apply. Previous settings were kept. Check that the theme media can play and the library limit (30 cards / 2 MB), then try again.",
					"적용하지 못해 이전 설정을 유지했습니다. 테마 영상 재생과 라이브러리 용량(30장·2MB)을 확인하고 다시 시도해 주세요.",
				),
			);
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	return (
		<section
			className="settings-field character-theme-settings"
			aria-label={copy(
				"Character cards and NVA themes",
				"캐릭터 카드와 NVA 테마",
			)}
			style={{ minWidth: 0, gridColumn: "1 / -1", overflowWrap: "anywhere" }}
		>
			<h3>{copy("Character cards", "캐릭터 카드")}</h3>
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
				{copy(
					"Read first greeting aloud (when voice output is on)",
					"첫 인사 자동 낭독 (음성 출력이 켜져 있을 때)",
				)}
			</label>
			<p className="settings-hint">
				{copy(
					"Import a SillyTavern PNG or JSON card, then apply its persona, greeting and example dialogue. Your model stays selected. Choose a local model in Model settings for local play.",
					"SillyTavern PNG·JSON 카드를 확인한 뒤 성격·첫 인사·예시 대화를 적용합니다. 모델 선택은 유지됩니다. 로컬로 놀려면 모델 설정에서 로컬 모델을 선택하세요.",
				)}
			</p>
			<label htmlFor="saved-character-card">
				{copy("Card library", "카드 라이브러리")}
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
				<option value="">
					{copy("Choose a saved card", "저장한 카드 선택")}
				</option>
				{library.map((c) => (
					<option key={c.id} value={c.id}>
						{c.name}
					</option>
				))}
			</select>
			<p className="settings-hint">
				{copy(
					"Up to 30 cards, 2 MB total including original PNG/JSON. Applying a card starts a new conversation. Select a saved theme below to link it to this card.",
					"원본 PNG·JSON 포함 최대 30장·총 2MB. 카드 적용 시 새 대화를 시작합니다. 아래 저장한 테마를 고르면 이 카드에 연결됩니다.",
				)}
			</p>
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
					{copy("Export original card", "원본 카드 내보내기")}
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
							setStatus(
								copy(
									"Card removed from library.",
									"라이브러리에서 카드를 삭제했습니다.",
								),
							);
						})
					}
				>
					{copy("Delete card", "카드 삭제")}
				</button>
			)}
			<label htmlFor="character-card-file">
				{copy("Import card (PNG / JSON)", "카드 불러오기 (PNG / JSON)")}
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
							setError(
								copy(
									"Card exceeds 20 MB. Choose a smaller file.",
									"카드가 20MB를 넘습니다. 더 작은 파일을 선택하세요.",
								),
							);
							return;
						}
						const bytes = new Uint8Array(await file.arrayBuffer());
						const parsed = await parseCharacterCardBytes(bytes);
						if (!parsed.ok) {
							setError(
								copy(
									"Cannot read this card. Choose a valid v2/v3 PNG or JSON card.",
									"카드를 읽을 수 없습니다. 올바른 v2/v3 PNG·JSON 카드를 다시 선택하세요.",
								),
							);
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
			{!card && !busy && (
				<p>{copy("No card selected.", "선택한 카드가 없습니다.")}</p>
			)}
			{card && preview && (
				<div>
					<strong>{card.name}</strong>
					<p
						style={{ whiteSpace: "pre-wrap", maxHeight: 150, overflow: "auto" }}
					>
						{preview.greeting}
					</p>
					{preview.truncated && (
						<p>
							{copy(
								"Long content was shortened to fit the model context.",
								"긴 내용 일부를 모델 문맥 길이에 맞게 줄였습니다.",
							)}
						</p>
					)}
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
								setStatus(
									copy(
										"Card applied. A new conversation starts with the greeting.",
										"카드를 적용했습니다. 새 대화에서 첫 인사로 시작합니다.",
									),
								);
							})
						}
					>
						{copy("Apply card", "카드 적용")}
					</button>
				</div>
			)}
			<h3>{copy("NVA themes", "NVA 테마")}</h3>
			<p className="settings-hint">
				{copy(
					"Save the avatar, voice and background currently selected in settings as one theme. Select the theme to use it with your character card.",
					"설정에서 고른 아바타·목소리·배경을 하나의 테마로 저장합니다. 테마를 선택해 캐릭터 카드와 함께 사용하세요.",
				)}
			</p>
			<label htmlFor="character-theme-name">
				{copy("Theme name", "테마 이름")}
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
						setStatus(
							copy(
								"Theme saved. Select Apply theme to use it.",
								"테마를 저장했습니다. 테마 적용을 눌러 사용하세요.",
							),
						);
					})
				}
			>
				{copy("Save current theme", "현재 테마 저장")}
			</button>
			{themes.length === 0 ? (
				<p>
					{copy(
						"No saved themes. Select an NVA avatar, voice and background first.",
						"저장한 테마가 없습니다. 먼저 NVA 아바타·목소리·배경을 선택하세요.",
					)}
				</p>
			) : (
				<>
					<label htmlFor="character-theme-select">
						{copy("Saved themes", "저장한 테마")}
					</label>
					<select
						id="character-theme-select"
						className="settings-select"
						value={themeId}
						disabled={busy}
						onChange={(e) => setThemeId(e.target.value)}
					>
						<option value="">{copy("Select a theme", "테마 선택")}</option>
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
								setStatus(copy("Theme applied.", "테마를 적용했습니다."));
							})
						}
					>
						{copy("Apply theme", "테마 적용")}
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
								setStatus(copy("Theme updated.", "테마를 수정했습니다."));
							})
						}
					>
						{copy("Update selected theme", "선택한 테마 수정")}
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
								setStatus(
									copy(
										"Theme deleted. Card links cleared.",
										"테마를 삭제하고 카드 연결을 해제했습니다.",
									),
								);
							})
						}
					>
						{copy("Delete selected theme", "선택한 테마 삭제")}
					</button>
				</div>
			)}
			{busy && (
				<output style={{ display: "block" }}>
					{copy("Working…", "처리 중…")}
				</output>
			)}
			{status && <output style={{ display: "block" }}>{status}</output>}
			{error && <p role="alert">{error}</p>}
		</section>
	);
}
