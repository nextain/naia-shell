import { type FormEvent, useEffect, useId, useState } from "react";
import { t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import {
	DEFAULT_VISUAL_AGENT_SLUG,
	buildVisualAgentPublicUrl,
	isVisualAgentSlug,
} from "../lib/web-runtime/visual-agent-slug";
import { startWebLoginRedirect } from "../lib/web-runtime/web-auth";

const SETTINGS_URL = "/api/visual-agent/settings";

type SlugAccess = "loading" | "ready" | "signed-out" | "unavailable";
type SlugError = "invalid" | "taken" | "saveError" | "copyError";

export default function WebVisualAgentSlugSettings() {
	const id = useId();
	const [slug, setSlug] = useState(DEFAULT_VISUAL_AGENT_SLUG);
	const [saved, setSaved] = useState(DEFAULT_VISUAL_AGENT_SLUG);
	const [access, setAccess] = useState<SlugAccess>("loading");
	const [retry, setRetry] = useState(0);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<SlugError | null>(null);
	const [notice, setNotice] = useState<"saved" | "copied" | null>(null);
	const ready = access === "ready";
	const dirty = slug !== saved;
	const invalid = error === "invalid" || error === "taken";
	const address = (ready || access === "signed-out") && isVisualAgentSlug(slug)
		? buildVisualAgentPublicUrl(slug)
		: null;

	useEffect(() => {
		const controller = new AbortController();
		async function read() {
			Logger.debug("WebVisualAgentSlugSettings", "reading settings", { retry });
			try {
				const response = await fetch(SETTINGS_URL, { signal: controller.signal });
				if (controller.signal.aborted) return;
				if (response.status === 401) {
					Logger.debug("WebVisualAgentSlugSettings", "sign-in required");
					setAccess("signed-out");
					return;
				}
				if (!response.ok) throw new Error("read");
				const data = await response.json();
				if (!isVisualAgentSlug(data?.slug)) throw new Error("slug");
				if (controller.signal.aborted) return;
				setSaved(data.slug);
				setSlug(data.slug);
				setAccess("ready");
				Logger.debug("WebVisualAgentSlugSettings", "settings loaded");
			} catch {
				if (controller.signal.aborted) return;
				setAccess("unavailable");
				Logger.debug("WebVisualAgentSlugSettings", "settings unavailable");
			}
		}
		void read();
		return () => controller.abort();
	}, [retry]);

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!ready || saving || !dirty) return;
		Logger.debug("WebVisualAgentSlugSettings", "saving settings", { length: slug.length });
		setNotice(null);
		if (!isVisualAgentSlug(slug)) {
			setError("invalid");
			Logger.debug("WebVisualAgentSlugSettings", "invalid slug");
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const response = await fetch(SETTINGS_URL, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ slug }),
			});
			Logger.debug("WebVisualAgentSlugSettings", "save response", { status: response.status });
			if (response.status === 409) {
				setError("taken");
				return;
			}
			if (response.status === 401) {
				setSaved(DEFAULT_VISUAL_AGENT_SLUG);
				setSlug(DEFAULT_VISUAL_AGENT_SLUG);
				setAccess("signed-out");
				return;
			}
			if (!response.ok) throw new Error("save");
			const data = await response.json();
			if (data?.slug !== slug) throw new Error("slug");
			setSaved(data.slug);
			setNotice("saved");
		} catch {
			setError("saveError");
		} finally {
			setSaving(false);
		}
	}

	async function copyAddress() {
		if (!address || dirty) return;
		setNotice(null);
		try {
			await navigator.clipboard.writeText(address);
			setError(null);
			setNotice("copied");
			Logger.debug("WebVisualAgentSlugSettings", "address copied");
		} catch {
			setError("copyError");
			Logger.debug("WebVisualAgentSlugSettings", "copy unavailable");
		}
	}

	return (
		<form className="settings-field visual-agent-slug-settings" onSubmit={save} noValidate>
			<label htmlFor={id}>{t("webVisualAgent.slugLabel")}</label>
			<input
				id={id}
				dir="ltr"
				autoComplete="off"
				autoCapitalize="none"
				spellCheck={false}
				disabled={!ready || saving}
				value={slug}
				aria-invalid={invalid}
				aria-describedby={invalid ? `${id}-error` : `${id}-hint`}
				onChange={(event) => {
					setSlug(event.target.value);
					setError(null);
					setNotice(null);
				}}
			/>
			{!invalid && <p id={`${id}-hint`} className="settings-hint">{t("webVisualAgent.hint")}</p>}
			{(error || access === "unavailable") && (
				<p id={`${id}-error`} role="alert" className="settings-error">
					{t(`webVisualAgent.${error ?? "readError"}`)}
				</p>
			)}
			{address && (
				<div className="visual-agent-slug-preview">
					<span className="settings-hint">{t("webVisualAgent.publicAddress")}</span>
					<p dir="ltr" data-testid="visual-agent-public-url">{address}</p>
				</div>
			)}
			<div className="visual-agent-slug-actions">
				{ready && (
					<button type="submit" className="settings-save-btn" disabled={!dirty || saving}>
						{t("webVisualAgent.save")}
					</button>
				)}
				{access === "signed-out" && (
					<button type="button" className="settings-save-btn" onClick={() => startWebLoginRedirect()}>
						{t("webVisualAgent.loginToEdit")}
					</button>
				)}
				{address && (
					<button type="button" className="voice-preview-btn" disabled={dirty} onClick={copyAddress}>
						{t("webVisualAgent.copy")}
					</button>
				)}
				{access === "unavailable" && (
					<button type="button" className="voice-preview-btn" onClick={() => {
						setAccess("loading");
						setRetry((attempt) => attempt + 1);
					}}>
						{t("common.retry")}
					</button>
				)}
			</div>
			<div role="status" className="settings-hint">
				{access === "loading" ? t("webVisualAgent.loading") :
					saving ? t("settings.saving") : notice ? t(`webVisualAgent.${notice}`) : null}
			</div>
		</form>
	);
}
