import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { readNaiaConfig, setAdkPath } from "../lib/adk-store";
import { getLocale, t } from "../lib/i18n";

interface AdkSetupScreenProps {
	onComplete: () => void;
}

type Mode = "select" | "new" | "load" | "login";

function getNaiaWebBaseUrl() {
	return (
		import.meta.env.VITE_NAIA_WEB_BASE_URL?.trim() || "https://naia.nextain.io"
	);
}

function clearAllLocalData() {
	localStorage.removeItem("naia-config");
	localStorage.removeItem("naia-remote-key");
	localStorage.removeItem("naia-remote-user-id");
}

async function getDefaultAdkPath(): Promise<string> {
	try {
		const home = await homeDir();
		return await join(home, "naia-adk");
	} catch {
		return "naia-adk";
	}
}

export function AdkSetupScreen({ onComplete }: AdkSetupScreenProps) {
	const [mode, setMode] = useState<Mode>("select");
	const [path, setPath] = useState("");
	const [defaultPath, setDefaultPath] = useState("~/naia-adk");
	const [error, setError] = useState<string | null>(null);
	const [loginWaiting, setLoginWaiting] = useState(false);
	const [loginTimeout, setLoginTimeout] = useState(false);

	useEffect(() => {
		getDefaultAdkPath().then(setDefaultPath);
	}, []);

	// Listen for Naia auth callback (login mode)
	useEffect(() => {
		const unlisten = listen<{ naiaKey: string; naiaUserId?: string }>(
			"naia_auth_complete",
			(event) => {
				const adkPath = path || defaultPath;
				setLoginWaiting(false);
				setAdkPath(adkPath);
				localStorage.setItem("naia-remote-key", event.payload.naiaKey);
				if (event.payload.naiaUserId) {
					localStorage.setItem("naia-remote-user-id", event.payload.naiaUserId);
				}
				// Mark onboarding complete — Naia login implies an existing account/setup.
				const existing = JSON.parse(
					localStorage.getItem("naia-config") ?? "{}",
				);
				localStorage.setItem(
					"naia-config",
					JSON.stringify({ ...existing, onboardingComplete: true }),
				);
				onComplete();
			},
		);
		return () => {
			unlisten.then((fn) => fn());
		};
	}, [path, defaultPath, onComplete]);

	async function handleBrowse() {
		const selected = await open({
			directory: true,
			title: t("adk.setup.load.dialogTitle"),
		});
		if (selected && typeof selected === "string") {
			setPath(selected);
			setError(null);
		}
	}

	async function handleNewStart() {
		clearAllLocalData();
		const adkPath = defaultPath;
		setAdkPath(adkPath);
		onComplete();
	}

	async function handleLoadConfirm() {
		const trimmed = path.trim();
		if (!trimmed) {
			setError(t("adk.setup.load.error"));
			return;
		}
		setAdkPath(trimmed);
		// Restore config from the selected ADK folder, then mark onboarding done so
		// the wizard doesn't replay for an already-configured folder.
		const fileConfig = await readNaiaConfig();
		const base = fileConfig ?? {};
		localStorage.setItem(
			"naia-config",
			JSON.stringify({ ...base, onboardingComplete: true }),
		);
		onComplete();
	}

	async function handleNaiaLogin() {
		setLoginWaiting(true);
		setLoginTimeout(false);
		const timer = setTimeout(() => {
			setLoginWaiting(false);
			setLoginTimeout(true);
		}, 180_000);

		try {
			const lang = getLocale();
			const loginUrl = `${getNaiaWebBaseUrl()}/${lang}/login?redirect=desktop&source=embedded`;
			const ok = await invoke("browser_open_login", { url: loginUrl }).then(
				() => true,
				() => false,
			);
			if (ok) {
				clearTimeout(timer);
				return;
			}
			const state = await invoke<string>("generate_oauth_state").catch(
				() => "",
			);
			const params = new URLSearchParams({
				redirect: "desktop",
				source: "desktop",
			});
			if (state) params.set("state", state);
			await openUrl(
				`${getNaiaWebBaseUrl()}/${lang}/login?${params.toString()}`,
			);
		} catch {
			clearTimeout(timer);
			setLoginWaiting(false);
		}
	}

	// ── Selection screen ───────────────────────────────────────────────────────
	if (mode === "select") {
		return (
			<div className="adk-setup-screen">
				<div className="adk-setup-header">
					<h1 className="adk-setup-headline">{t("adk.setup.headline")}</h1>
					<p className="adk-setup-sub">{t("adk.setup.sub")}</p>
				</div>

				<div className="adk-setup-cards">
					<button
						type="button"
						className="adk-setup-option-card"
						onClick={() => setMode("new")}
					>
						<span className="adk-setup-option-icon">✦</span>
						<span className="adk-setup-option-title">
							{t("adk.setup.new.title")}
						</span>
						<span className="adk-setup-option-desc">
							{t("adk.setup.new.desc")}
						</span>
					</button>

					<button
						type="button"
						className="adk-setup-option-card"
						onClick={() => setMode("load")}
					>
						<span className="adk-setup-option-icon">📂</span>
						<span className="adk-setup-option-title">
							{t("adk.setup.load.title")}
						</span>
						<span className="adk-setup-option-desc">
							{t("adk.setup.load.desc")}
						</span>
					</button>

					<button
						type="button"
						className="adk-setup-option-card adk-setup-option-card--naia"
						onClick={() => setMode("login")}
					>
						<span className="adk-setup-option-icon">🌐</span>
						<span className="adk-setup-option-title">
							{t("adk.setup.login.title")}
						</span>
						<span className="adk-setup-option-desc">
							{t("adk.setup.login.desc")}
						</span>
					</button>
				</div>
			</div>
		);
	}

	// ── New start ──────────────────────────────────────────────────────────────
	if (mode === "new") {
		return (
			<div className="adk-setup-screen">
				<button
					type="button"
					className="adk-setup-back"
					onClick={() => {
						setMode("select");
						setError(null);
					}}
				>
					{t("adk.setup.back")}
				</button>
				<div className="adk-setup-header">
					<span className="adk-setup-option-icon adk-setup-option-icon--lg">
						✦
					</span>
					<h1 className="adk-setup-headline">{t("adk.setup.new.title")}</h1>
					<p className="adk-setup-sub">{t("adk.setup.new.sub")}</p>
				</div>

				<div className="adk-setup-form">
					<div className="adk-setup-path-preview">{defaultPath}</div>
					<p className="adk-setup-hint">{t("adk.setup.new.hint")}</p>
					<button
						type="button"
						className="adk-setup-confirm-btn"
						onClick={handleNewStart}
					>
						{t("adk.setup.new.confirm")}
					</button>
				</div>
			</div>
		);
	}

	// ── Load from local folder ─────────────────────────────────────────────────
	if (mode === "load") {
		return (
			<div className="adk-setup-screen">
				<button
					type="button"
					className="adk-setup-back"
					onClick={() => {
						setMode("select");
						setError(null);
						setPath("");
					}}
				>
					{t("adk.setup.back")}
				</button>
				<div className="adk-setup-header">
					<span className="adk-setup-option-icon adk-setup-option-icon--lg">
						📂
					</span>
					<h1 className="adk-setup-headline">{t("adk.setup.load.title")}</h1>
					<p className="adk-setup-sub">{t("adk.setup.load.sub")}</p>
				</div>

				<div className="adk-setup-form">
					<div className="adk-setup-field-row">
						<input
							type="text"
							className="adk-setup-input"
							value={path}
							onChange={(e) => {
								setPath(e.target.value);
								setError(null);
							}}
							placeholder={t("adk.setup.load.placeholder")}
							onKeyDown={(e) => e.key === "Enter" && handleLoadConfirm()}
							autoFocus
						/>
						<button
							type="button"
							className="adk-setup-browse-btn"
							onClick={handleBrowse}
						>
							{t("adk.setup.browse")}
						</button>
					</div>
					{error && <p className="adk-setup-error">{error}</p>}
					<p className="adk-setup-hint">{t("adk.setup.load.hint")}</p>
					<button
						type="button"
						className="adk-setup-confirm-btn"
						onClick={handleLoadConfirm}
					>
						{t("adk.setup.load.confirm")}
					</button>
				</div>
			</div>
		);
	}

	// ── Naia login (online backup) ─────────────────────────────────────────────
	return (
		<div className="adk-setup-screen">
			<button
				type="button"
				className="adk-setup-back"
				onClick={() => {
					setMode("select");
					setLoginWaiting(false);
					setLoginTimeout(false);
				}}
			>
				{t("adk.setup.back")}
			</button>
			<div className="adk-setup-header">
				<span className="adk-setup-option-icon adk-setup-option-icon--lg">
					🌐
				</span>
				<h1 className="adk-setup-headline">{t("adk.setup.login.title")}</h1>
				<p className="adk-setup-sub">{t("adk.setup.login.desc")}</p>
			</div>

			<div className="adk-setup-form">
				<div className="adk-setup-field-row">
					<input
						type="text"
						className="adk-setup-input"
						value={path}
						onChange={(e) => setPath(e.target.value)}
						placeholder={`${t("adk.setup.login.pathPrefix")}: ${defaultPath})`}
					/>
					<button
						type="button"
						className="adk-setup-browse-btn"
						onClick={handleBrowse}
					>
						{t("adk.setup.browse")}
					</button>
				</div>
				<p className="adk-setup-hint">{t("adk.setup.login.hint")}</p>

				{loginTimeout && (
					<p className="adk-setup-error">{t("adk.setup.login.timeout")}</p>
				)}

				<button
					type="button"
					className="adk-setup-confirm-btn adk-setup-confirm-btn--naia"
					onClick={handleNaiaLogin}
					disabled={loginWaiting}
				>
					{loginWaiting
						? t("adk.setup.login.waiting")
						: t("adk.setup.login.confirm")}
				</button>
			</div>
		</div>
	);
}
