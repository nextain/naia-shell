import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import {
	copyBundledAssets,
	getAdkPath,
	setAdkPath,
} from "../lib/adk-store";
import { getLocale, t, type TranslationKey } from "../lib/i18n";
import { sendConfigUpdate } from "../lib/chat-service";

interface AdkSetupScreenProps {
	onComplete: () => void;
}

type Mode = "select" | "new" | "new_exists" | "load" | "login";

type SetupStatus =
	| null
	| "deleting"
	| "cloning"
	| "zipFallback"
	| "initializing"
	| "copyingAssets";

const STATUS_KEYS: Record<Exclude<SetupStatus, null>, TranslationKey> = {
	deleting: "adk.setup.status.deleting",
	cloning: "adk.setup.cloning",
	zipFallback: "adk.setup.status.zipFallback",
	initializing: "adk.setup.status.initializing",
	copyingAssets: "adk.setup.status.copyingAssets",
};

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
	const [setupStatus, setSetupStatus] = useState<SetupStatus>(null);
	const [downloadProgress, setDownloadProgress] = useState<string | null>(null);
	// State of the chosen ADK directory when entering new_exists mode.
	// "has_settings" → existing naia ADK (both "use as-is" and "delete" make sense)
	// "has_other_files" → folder is non-empty but no naia-settings/ (only "delete" makes sense)
	const [dirState, setDirState] = useState<
		"has_settings" | "has_other_files" | null
	>(null);
	const [loginWaiting, setLoginWaiting] = useState(false);
	const [loginTimeout, setLoginTimeout] = useState(false);

	useEffect(() => {
		getDefaultAdkPath().then(setDefaultPath);
		homeDir()
			.then((home) => join(home, "naia-adk"))
			.then(setNewDefaultPath)
			.catch(() => {});
	}, []);

	// Listen for ADK setup progress events emitted by clone_naia_adk
	// (zip fallback + byte-level download progress).
	useEffect(() => {
		const unlisten = listen<{
			phase: string;
			downloaded?: number;
			total?: number;
		}>("adk_setup_progress", (event) => {
			const p = event.payload;
			if (p.phase === "zip_fallback") {
				setSetupStatus("zipFallback");
			} else if (p.phase === "zip_progress") {
				if (typeof p.downloaded === "number") {
					const mb = (p.downloaded / 1024 / 1024).toFixed(1);
					if (typeof p.total === "number" && p.total > 0) {
						const pct = Math.floor((p.downloaded / p.total) * 100);
						setDownloadProgress(`${pct}% (${mb} MB)`);
					} else {
						setDownloadProgress(`${mb} MB`);
					}
				}
			}
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// Clear download progress whenever the active phase moves past download.
	useEffect(() => {
		if (
			setupStatus === null ||
			setupStatus === "initializing" ||
			setupStatus === "copyingAssets"
		) {
			setDownloadProgress(null);
		}
	}, [setupStatus]);

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
			// inspect_adk_dir → "empty" | "has_settings" | "has_other_files" | "missing"
			// Branch into new_exists for both "has_settings" and "has_other_files"
			// so the user always sees a coherent choice instead of a raw
			// "Directory is not empty" error from clone_naia_adk (#325).
			const state = await invoke<string>("inspect_adk_dir", { adkPath });
			if (state === "has_settings" || state === "has_other_files") {
				setDirState(state);
				setPath(adkPath);
				setMode("new_exists");
				return;
			}
			setSetupStatus("cloning");
			await invoke("clone_naia_adk", { adkPath });
			setSetupStatus("initializing");
			await invoke("init_naia_settings", { adkPath });
			setSetupStatus("copyingAssets");
			await copyBundledAssets(adkPath);
			setSetupStatus(null);
			clearAllLocalData();
			setAdkPath(adkPath);
			sendConfigUpdate({ config: { NAIA_ADK_PATH: adkPath } }).catch(() => {});
			localStorage.setItem(
				"naia-config",
				JSON.stringify(preserveWorkspaceRoot({}, adkPath)),
			);
			onComplete();
		} catch (err) {
			setSetupStatus(null);
			setError(String(err));
		}
	}

	async function handleNewUseExisting() {
		try {
			const adkPath = path.trim() || newDefaultPath;
			setSetupStatus("initializing");
			await invoke("init_naia_settings", { adkPath });
			setSetupStatus("copyingAssets");
			await copyBundledAssets(adkPath);
			setSetupStatus(null);
			clearAllLocalData();
			setAdkPath(adkPath);
			sendConfigUpdate({ config: { NAIA_ADK_PATH: adkPath } }).catch(() => {});
			localStorage.setItem(
				"naia-config",
				JSON.stringify(preserveWorkspaceRoot({ onboardingComplete: true }, adkPath)),
			);
			onComplete();
		} catch (err) {
			setSetupStatus(null);
			setError(String(err));
		}
	}

	async function handleNewRecreate() {
		try {
			const adkPath = path.trim() || newDefaultPath;
			setSetupStatus("deleting");
			await invoke("delete_naia_adk", { adkPath });
			setSetupStatus("cloning");
			await invoke("clone_naia_adk", { adkPath });
			setSetupStatus("initializing");
			await invoke("init_naia_settings", { adkPath });
			setSetupStatus("copyingAssets");
			await copyBundledAssets(adkPath);
			setSetupStatus(null);
			clearAllLocalData();
			setAdkPath(adkPath);
			sendConfigUpdate({ config: { NAIA_ADK_PATH: adkPath } }).catch(() => {});
			localStorage.setItem(
				"naia-config",
				JSON.stringify(preserveWorkspaceRoot({}, adkPath)),
			);
			onComplete();
		} catch (err) {
			setSetupStatus(null);
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
			setSetupStatus("initializing");
			await invoke("init_naia_settings", { adkPath: trimmed });
			setSetupStatus("copyingAssets");
			await copyBundledAssets(trimmed);
			setSetupStatus(null);
			localStorage.setItem(
				"naia-config",
				JSON.stringify(preserveWorkspaceRoot({ onboardingComplete: true }, trimmed)),
			);
			onComplete();
		} catch (err) {
			setSetupStatus(null);
			setError(String(err));
		}
	}

	// Status line — shown across all setup modes (new / new_exists / load).
	// Adds byte-level download progress when zip fallback is streaming.
	const statusLine = setupStatus ? (
		<p className="adk-setup-hint">
			{t(STATUS_KEYS[setupStatus])}
			{downloadProgress &&
				(setupStatus === "cloning" || setupStatus === "zipFallback") &&
				` — ${downloadProgress}`}
		</p>
	) : null;

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
					{statusLine}
					<p className="adk-setup-hint">{t("adk.setup.new.hint")}</p>
					<button
						type="button"
						className="adk-setup-confirm-btn"
						onClick={handleNewStart}
						disabled={setupStatus !== null}
					>
						{t("adk.setup.new.confirm")}
					</button>
				</div>
			</div>
		);
	}

	// ── New start — existing data found ───────────────────────────────────────
	if (mode === "new_exists") {
		const hasSettings = dirState === "has_settings";
		return (
			<div className="adk-setup-screen">
				<button
					type="button"
					className="adk-setup-back"
					onClick={() => {
						setMode("new");
						setError(null);
						setPath("");
						setDirState(null);
					}}
				>
					{t("adk.setup.back")}
				</button>
				<div className="adk-setup-header">
					<span className="adk-setup-option-icon adk-setup-option-icon--lg">
						📦
					</span>
					<h1 className="adk-setup-headline">
						{hasSettings ? "이미 데이터가 있어요" : "폴더에 파일이 있어요"}
					</h1>
					<p className="adk-setup-sub">
						{hasSettings
							? "이 폴더에 이미 naia-settings 데이터가 있습니다."
							: "이 폴더에 다른 파일이 있어 naia-adk를 그대로 복제할 수 없습니다."}
					</p>
				</div>

				<div className="adk-setup-form">
					<div className="adk-setup-path-preview">{path}</div>
					{error && <p className="adk-setup-error">{error}</p>}
					{statusLine}
					<div className="adk-setup-cards" style={{ marginTop: 16 }}>
						{hasSettings && (
							<button
								type="button"
								className="adk-setup-option-card"
								onClick={handleNewUseExisting}
								disabled={setupStatus !== null}
							>
								<span className="adk-setup-option-icon">✅</span>
								<span className="adk-setup-option-title">그대로 사용</span>
								<span className="adk-setup-option-desc">
									기존 VRM·배경·BGM 데이터를 유지합니다
								</span>
							</button>
						)}
						<button
							type="button"
							className="adk-setup-option-card"
							onClick={handleNewRecreate}
							disabled={setupStatus !== null}
						>
							<span className="adk-setup-option-icon">🗑</span>
							<span className="adk-setup-option-title">삭제하고 새로 시작</span>
							<span className="adk-setup-option-desc">
								{hasSettings
									? "naia-settings를 완전히 초기화합니다"
									: "기존 파일을 삭제하고 naia-adk를 새로 받습니다"}
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
					{statusLine}
					<p className="adk-setup-hint">{t("adk.setup.load.hint")}</p>
					<button
						type="button"
						className="adk-setup-confirm-btn"
						onClick={handleLoadConfirm}
						disabled={setupStatus !== null}
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
