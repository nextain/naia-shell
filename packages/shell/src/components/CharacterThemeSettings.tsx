import { useRef, useState } from "react";
import {
	MAX_CARD_FILE_BYTES,
	type NormalizedCharacterCard,
	parseCharacterCardBytes,
} from "../apps/charcard/card-parser";
import {
	type CharacterTheme,
	characterCardPatch,
	readCharacterThemes,
} from "../lib/character-theme";
import type { AppConfig } from "../lib/config";
import { getLocale } from "../lib/i18n";
import { Logger } from "../lib/logger";

interface Props {
	config: AppConfig;
	currentTheme: Omit<CharacterTheme, "id" | "name" | "version">;
	onCard: (patch: Partial<AppConfig>) => Promise<void>;
	onTheme: (theme: CharacterTheme) => Promise<void>;
	onSaveThemes: (themes: CharacterTheme[]) => Promise<void>;
}

export function CharacterThemeSettings({
	config,
	currentTheme,
	onCard,
	onTheme,
	onSaveThemes,
}: Props) {
	const ko = getLocale() === "ko";
	const copy = (en: string, kr: string) => (ko ? kr : en);
	const [card, setCard] = useState<NormalizedCharacterCard | null>(null);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const [error, setError] = useState("");
	const [status, setStatus] = useState("");
	const [name, setName] = useState("");
	const [themes, setThemes] = useState(() =>
		readCharacterThemes(config.uiPreferences?.b2cNvaThemes),
	);
	const [themeId, setThemeId] = useState("");
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
					"Could not apply. Check your settings and try again.",
					"적용하지 못했습니다. 설정을 확인하고 다시 시도해 주세요.",
				),
			);
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	}

	return (
		<section
			className="settings-field"
			aria-label={copy(
				"Character cards and NVA themes",
				"캐릭터 카드와 NVA 테마",
			)}
			style={{ minWidth: 0, gridColumn: "1 / -1", overflowWrap: "anywhere" }}
		>
			<h3>{copy("Character cards", "캐릭터 카드")}</h3>
			<p className="settings-hint">
				{copy(
					"Import a SillyTavern PNG or JSON card, then apply its persona, greeting and example dialogue. Your model stays selected. Choose a local model in Model settings for local play.",
					"SillyTavern PNG·JSON 카드를 확인한 뒤 성격·첫 인사·예시 대화를 적용합니다. 모델 선택은 유지됩니다. 로컬로 놀려면 모델 설정에서 로컬 모델을 선택하세요.",
				)}
			</p>
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
						const parsed = await parseCharacterCardBytes(
							new Uint8Array(await file.arrayBuffer()),
						);
						if (!parsed.ok) {
							setError(
								copy(
									"Cannot read this card. Choose a valid v2/v3 PNG or JSON card.",
									"카드를 읽을 수 없습니다. 올바른 v2/v3 PNG·JSON 카드를 다시 선택하세요.",
								),
							);
							return;
						}
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
						disabled={busy}
						onClick={() =>
							void run(async () => {
								await onCard(preview.patch);
								setStatus(
									copy(
										"Card applied. Continue in chat; the greeting is included in the persona.",
										"카드를 적용했습니다. 채팅에서 이어가세요. 첫 인사는 페르소나에 포함됩니다.",
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
