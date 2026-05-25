import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import {
	copyBundledAssets,
	getAdkPath,
	readNaiaConfig,
	setAdkPath,
} from "../lib/adk-store";
import { getLocale, t } from "../lib/i18n";
import { sendConfigUpdate } from "../lib/chat-service";

interface AdkSetupScreenProps {
	onComplete: () => void;
}

type Mode = "select" | "new" | "new_exists" | "load" | "login";

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

function preserveWorkspaceRoot(
	config: Record<string, unknown>,
	adkPath: string,
): Record<string, unknown> {
	return {
		...config,
		workspaceRoot: adkPath || getAdkPath() || undefined,
	};
}

async function getDefaultAdkPath(): Promise<string> {
	const detected = await invoke<string>("workspace_detect_adk_root").catch(
		() => "",
	);
	if (detected) return detected;
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
	// New-start always uses ~/naia-adk — never auto-detected existing paths.
	const [newDefaultPath, setNewDefaultPath] = useState("~/naia-adk");
	const [error, setError] = useState<string | null>(null);
	const [cloning, setCloning] = useState(false);
	const [loginWaiting, setLoginWaiting] = useState(false);
	const [loginTimeout, setLoginTimeout] = useState(false);

	useEffect(() => {
		getDefaultAdkPath().then(setDefaultPath);
		homeDir()
			.then((home) => join(home, "naia-adk"))
			.then(setNewDefaultPath)
			.catch(() => {});
	}, []);

	// Listen for Naia auth callback (login mode)
	useEffect(() => {
		const unlisten = listen<{ naiaKey: string; naiaUserId?: string }>(
			"naia_auth_complete",
			(event) => {
				const adkPath = path || defaultPath;
				setLoginWaiting(false);
				setAdkPath(adkPath);
				sendConfigUpdate({ config: { NAIA_ADK_PATH: adkPath } }).catch(() => {});
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
					JSON.stringify(preserveWorkspaceRoot({
						provider: "nextain",
						model: "gemini-2.5-flash",
						apiKey: "",
						...existing,
						naiaKey: event.payload.naiaKey,
						naiaUserId: event.payload.naiaUserId,
						onboardingComplete: true,
					}, adkPath)),
				);
				// Cache naiaKey for crash-restart replay before calling onComplete.
				invoke("store_startup_message", {
					message: JSON.stringify({
						type: "auth_update",
						naiaKey: event.payload.naiaKey,
					}),
				}).catch(() => {});
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
		try {
			const adkPath = path.trim() || newDefaultPath;
			// Check if naia-settings already exists
			const exists = await invoke<boolean>("check_naia_settings", { adkPath });
			if (exists) {
				setPath(adkPath);
				setMode("new_exists");
				return;
			}
			// Clone naia-adk scaffold from GitHub
			setCloning(true);
			await invoke("clone_naia_adk", { adkPath });
			setCloning(false);
			// Initialize naia-settings subdirs and copy bundled assets
			await invoke("init_naia_settings", { adkPath });
			await copyBundledAssets(adkPath);
			clearAllLocalData();
			setAdkPath(adkPath);
			sendConfigUpdate({ config: { NAIA_ADK_PATH: adkPath } }).catch(() => {});
			localStorage.setItem(
				"naia-config",
				JSON.stringify(preserveWorkspaceRoot({}, adkPath)),
			);
			onComplete();
		} catch (err) {
			setCloning(false);
			setError(String(err));
		}
	}

	async function handleNewUseExisting() {
		try {
			const adkPath = path.trim() || newDefaultPath;
			await invoke("init_naia_settings", { adkPath });
			await copyBundledAssets(adkPath);
			clearAllLocalData();
			setAdkPath(adkPath);
			sendConfigUpdate({ config: { NAIA_ADK_PATH: adkPath } }).catch(() => {});
			const fileConfig = await readNaiaConfig();
			if (fileConfig) {
				localStorage.setItem(
					"naia-config",
					JSON.stringify(
						preserveWorkspaceRoot(
							{ ...fileConfig, onboardingComplete: true },
							adkPath,
						),
					),
				);
			}
			onComplete();
		} catch (err) {
			setError(String(err));
		}
	}

	async function handleNewRecreate() {
		try {
			const adkPath = path.trim() || newDefaultPath;
			// Wipe entire workspace and re-clone scaffold
			await invoke("delete_naia_adk", { adkPath });
			setCloning(true);
			await invoke("clone_naia_adk", { adkPath });
			setCloning(false);
			await invoke("init_naia_settings", { adkPath });
			await copyBundledAssets(adkPath);
			clearAllLocalData();
			setAdkPath(adkPath);
			sendConfigUpdate({ config: { NAIA_ADK_PATH: adkPath } }).catch(() => {});
			localStorage.setItem(
				"naia-config",
				JSON.stringify(preserveWorkspaceRoot({}, adkPath)),
			);
			onComplete();
		} catch (err) {
			setCloning(false);
			setError(String(err));
		}
	}

	async function handleLoadConfirm() {
		const trimmed = path.trim();
		if (!trimmed) {
			setError(t("adk.setup.load.error"));
			return;
		}
		try {
			setAdkPath(trimmed);
			sendConfigUpdate({ config: { NAIA_ADK_PATH: trimmed } }).catch(() => {});
			// Ensure naia-settings subfolders and bundled defaults exist.
			await invoke("init_naia_settings", { adkPath: trimmed });
			await copyBundledAssets(trimmed);
			// Restore config from the selected ADK folder, then mark onboarding done
			const fileConfig = await readNaiaConfig();
			const base = fileConfig ?? {};
			localStorage.setItem(
				"naia-config",
				JSON.stringify(
					preserveWorkspaceRoot(
						{ ...base, onboardingComplete: true },
						trimmed,
					),
				),
			);
			onComplete();
		} catch (err) {
			setError(String(err));
		}
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
						setPath("");
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
					<div className="adk-setup-field-row">
						<input
							type="text"
							className="adk-setup-input"
							value={path || newDefaultPath}
							onChange={(e) => setPath(e.target.value)}
							placeholder={newDefaultPath}
						/>
						<button
							type="button"
							className="adk-setup-browse-btn"
							onClick={async () => {
								const selected = await open({
									directory: true,
									title: "naia-adk 폴더 선택",
								});
								if (selected && typeof selected === "string") setPath(selected);
							}}
						>
							{t("adk.setup.browse")}
						</button>
					</div>
					{error && <p className="adk-setup-error">{error}</p>}
					{cloning && <p className="adk-setup-hint">{t("adk.setup.cloning")}</p>}
					<p className="adk-setup-hint">{t("adk.setup.new.hint")}</p>
					<button
						type="button"
						className="adk-setup-confirm-btn"
						onClick={handleNewStart}
						disabled={cloning}
					>
						{t("adk.setup.new.confirm")}
					</button>
				</div>
			</div>
		);
	}

	// ── New start — existing data found ───────────────────────────────────────
	if (mode === "new_exists") {
		return (
			<div className="adk-setup-screen">
				<button
					type="button"
					className="adk-setup-back"
					onClick={() => {
						setMode("new");
						setError(null);
						setPath("");
					}}
				>
					{t("adk.setup.back")}
				</button>
				<div className="adk-setup-header">
					<span className="adk-setup-option-icon adk-setup-option-icon--lg">
						📦
					</span>
					<h1 className="adk-setup-headline">이미 데이터가 있어요</h1>
					<p className="adk-setup-sub">
						이 폴더에 이미 naia-settings 데이터가 있습니다.
					</p>
				</div>

				<div className="adk-setup-form">
					<div className="adk-setup-path-preview">{path}</div>
					{error && <p className="adk-setup-error">{error}</p>}
					<div className="adk-setup-cards" style={{ marginTop: 16 }}>
						<button
							type="button"
							className="adk-setup-option-card"
							onClick={handleNewUseExisting}
						>
							<span className="adk-setup-option-icon">✅</span>
							<span className="adk-setup-option-title">그대로 사용</span>
							<span className="adk-setup-option-desc">
								기존 VRM·배경·BGM 데이터를 유지합니다
							</span>
						</button>
						<button
							type="button"
							className="adk-setup-option-card"
							onClick={handleNewRecreate}
						>
							<span className="adk-setup-option-icon">🗑</span>
							<span className="adk-setup-option-title">삭제하고 새로 시작</span>
							<span className="adk-setup-option-desc">
								naia-settings를 완전히 초기화합니다
							</span>
						</button>
					</div>
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
