import { useEffect, useState } from "react";
import { t } from "../lib/i18n";
import {
	type ProactiveSpeechSettings,
	normalizeProactiveSpeechSettings,
	withRadioDjDefaults,
} from "../lib/proactive-speech-settings";

type ProactiveSettingsMode = "all" | "dj" | "exhibition";

function scopeProfile(
	value: ProactiveSpeechSettings,
	mode: ProactiveSettingsMode | undefined,
): ProactiveSpeechSettings {
	const scoped = mode === "dj" ? withRadioDjDefaults(value) : value;
	if (mode === "dj" && value.profile === "exhibition_intro") {
		return { ...scoped, profile: "disabled" };
	}
	if (mode === "exhibition" && value.profile === "personal_radio_dj") {
		return { ...value, profile: "disabled" };
	}
	return scoped;
}

export function RadioDjSettingsCard(props: {
	value: ProactiveSpeechSettings;
	onSave: (value: ProactiveSpeechSettings) => boolean | Promise<boolean>;
}) {
	const [expanded, setExpanded] = useState(false);
	const detailId = "radio-dj-skill-settings-detail";
	const toggleExpanded = () => setExpanded((current) => !current);

	return (
		<div
			className={`skill-card${expanded ? " expanded" : ""}`}
			data-testid="youtube-bgm-skill-settings"
		>
			<button
				type="button"
				className="skill-card-header radio-dj-skill-card-header"
				aria-expanded={expanded}
				aria-controls={detailId}
				onClick={toggleExpanded}
			>
				<div className="skill-card-info">
					<div className="skill-card-name">
						{t("settings.radioDjSkillName")}
					</div>
					<div className="skill-card-desc-short">
						{t("settings.radioDjSkillDesc")}
					</div>
				</div>
				<div className="skill-card-actions" aria-hidden="true">
					<span>{expanded ? "-" : "+"}</span>
				</div>
			</button>
			{expanded && (
				<div id={detailId} className="skill-card-detail">
					<div className="skill-card-badges">
						<span className="skill-badge built-in">skill_youtube_bgm</span>
					</div>
					<ProactiveSpeechSettingsSection
						mode="dj"
						value={props.value}
						onSave={props.onSave}
					/>
				</div>
			)}
		</div>
	);
}

export function ProactiveSpeechSettingsSection(props: {
	value: ProactiveSpeechSettings;
	mode?: ProactiveSettingsMode;
	onChange?: (value: ProactiveSpeechSettings) => void;
	onSave: (value: ProactiveSpeechSettings) => boolean | Promise<boolean>;
}) {
	const sourceKey = JSON.stringify(scopeProfile(props.value, props.mode));
	const [draft, setDraft] = useState(() =>
		scopeProfile(props.value, props.mode),
	);
	const [saveFailed, setSaveFailed] = useState(false);
	useEffect(
		() => setDraft(scopeProfile(props.value, props.mode)),
		// SettingsTab rebuilds its value object during ordinary polling renders.
		// Reset only when the durable values change, otherwise a checkbox click is
		// immediately overwritten by an equivalent parent object.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[sourceKey],
	);
	const update = (patch: Partial<ProactiveSpeechSettings>) => {
		const next = { ...draft, ...patch };
		setDraft(next);
		props.onChange?.(next);
	};
	return (
		<section className="settings-field" data-testid="proactive-speech-settings">
			<label>
				{t("settings.proactiveProfile")}
				<select
					data-testid="proactive-speech-profile"
					value={draft.profile}
					onChange={(event) =>
						update({
							profile: event.target.value as ProactiveSpeechSettings["profile"],
						})
					}
				>
					<option value="disabled">{t("settings.proactiveDisabled")}</option>
					{props.mode !== "exhibition" && (
						<option value="personal_radio_dj">
							{t("settings.proactiveDj")}
						</option>
					)}
					{props.mode !== "dj" && (
						<option value="exhibition_intro">
							{t("settings.proactiveExhibition")}
						</option>
					)}
				</select>
			</label>
			<label>
				{t("settings.proactiveTimezone")}
				<input
					data-testid="proactive-timezone"
					value={draft.timezone}
					onChange={(event) => update({ timezone: event.target.value })}
				/>
			</label>
			{props.mode !== "exhibition" && (
				// #643: idle/interval are elapsed-time timers (quiet-before-first-remark,
				// then a fixed gap between remarks) — not tied to the YouTube iframe's
				// `ended` event, which BGM recovery handles separately. They only mean
				// anything for the DJ session, so General (exhibition) never shows them.
				<>
					<label>
						{t("settings.proactiveIdle")}
						<input
							data-testid="proactive-idle-ms"
							type="number"
							value={draft.idleMs ?? ""}
							onChange={(event) =>
								update({ idleMs: Number(event.target.value) })
							}
						/>
					</label>
					<label>
						{t("settings.proactiveInterval")}
						<input
							data-testid="proactive-interval-ms"
							type="number"
							value={draft.intervalMs ?? ""}
							onChange={(event) =>
								update({ intervalMs: Number(event.target.value) })
							}
						/>
					</label>
					<label>
						<input
							data-testid="proactive-bgm-autoplay"
							type="checkbox"
							checked={draft.bgmAutoPlay === true}
							onChange={(event) => update({ bgmAutoPlay: event.target.checked })}
						/>
						{t("settings.proactiveBgm")}
					</label>
					<label>
						<input
							data-testid="proactive-weather-consent"
							type="checkbox"
							checked={draft.weatherConsented === true}
							onChange={(event) =>
								update({
									weatherConsented: event.target.checked,
									...(!event.target.checked
										? {
												weatherLatitude: undefined,
												weatherLongitude: undefined,
											}
										: {}),
								})
							}
						/>
						{t("settings.proactiveWeather")}
					</label>
					<label>
						{t("settings.proactiveLatitude")}
						<input
							data-testid="proactive-weather-latitude"
							type="number"
							value={draft.weatherLatitude ?? ""}
							onChange={(event) =>
								update({ weatherLatitude: Number(event.target.value) })
							}
						/>
					</label>
					<label>
						{t("settings.proactiveLongitude")}
						<input
							data-testid="proactive-weather-longitude"
							type="number"
							value={draft.weatherLongitude ?? ""}
							onChange={(event) =>
								update({ weatherLongitude: Number(event.target.value) })
							}
						/>
					</label>
				</>
			)}
			{props.mode !== "dj" && (
				<label>
					{t("settings.proactiveScope")}
					<input
						data-testid="proactive-knowledge-scope"
						value={draft.knowledgeScope ?? ""}
						onChange={(event) => update({ knowledgeScope: event.target.value })}
					/>
				</label>
			)}
			<button
				type="button"
				data-testid="proactive-settings-save"
				onClick={async () => {
					setSaveFailed(false);
					let normalized = normalizeProactiveSpeechSettings(draft);
					const sourceIsOutsideThisSection =
						props.value.profile !== "disabled" &&
						scopeProfile(props.value, props.mode).profile === "disabled";
					if (sourceIsOutsideThisSection && draft.profile === "disabled") {
						normalized = { ...normalized, profile: props.value.profile };
					}
					const saved = await props.onSave(normalized);
					setSaveFailed(!saved);
				}}
			>
				{t("settings.proactiveSave")}
			</button>
			{saveFailed && (
				<div role="alert" data-testid="proactive-settings-save-error">
					{t("settings.proactiveSaveError")}
				</div>
			)}
		</section>
	);
}
