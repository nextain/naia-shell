import { openUrl } from "@tauri-apps/plugin-opener";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { NAIA_WEB_BASE_URL } from "../lib/config";
import { getLocale, t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import { naiaWebUrl } from "../lib/naia-instance-urls";
import type { UpdateInfo } from "../lib/updater";
import { useAppStore } from "../stores/app";

interface UpdatePromptProps {
	info: UpdateInfo;
	onLater: (snoozeForMonth: boolean) => void;
}

export function UpdatePrompt({ info, onLater }: UpdatePromptProps) {
	const [snoozeForMonth, setSnoozeForMonth] = useState(false);
	const [installing, setInstalling] = useState(false);
	const [installFailed, setInstallFailed] = useState(false);
	const dialogRef = useRef<HTMLDialogElement>(null);
	const installButtonRef = useRef<HTMLButtonElement>(null);
	const pushModal = useAppStore((state) => state.pushModal);
	const popModal = useAppStore((state) => state.popModal);

	useEffect(() => {
		pushModal();
		installButtonRef.current?.focus();
		return () => popModal();
	}, [popModal, pushModal]);

	const handleDialogKeyDown = (event: ReactKeyboardEvent) => {
		if (event.key === "Escape" && !installing) {
			event.preventDefault();
			onLater(snoozeForMonth);
			return;
		}
		if (event.key !== "Tab") return;

		const focusable = Array.from(
			dialogRef.current?.querySelectorAll<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
			) ?? [],
		);
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	const handleInstall = async () => {
		setInstalling(true);
		setInstallFailed(false);
		try {
			await info.installFn();
		} catch (err) {
			Logger.warn("UpdatePrompt", "Install failed", { error: String(err) });
			setInstallFailed(true);
			setInstalling(false);
		}
	};

	const handleViewDetails = () => {
		openUrl(naiaWebUrl(`${getLocale()}/download`, NAIA_WEB_BASE_URL)).catch(() => {});
	};

	return (
		<div className="update-prompt-overlay">
			<dialog
				ref={dialogRef}
				open
				className="update-prompt"
				aria-modal="true"
				aria-labelledby="update-prompt-title"
				aria-describedby="update-prompt-description"
				onKeyDown={handleDialogKeyDown}
			>
				<header className="update-prompt-header">
					<div>
						<p className="update-prompt-eyebrow">{t("update.available")}</p>
						<h2 id="update-prompt-title">{t("update.promptTitle")}</h2>
					</div>
					<span className="update-prompt-icon" aria-hidden="true">
						↑
					</span>
				</header>

				<p id="update-prompt-description" className="update-prompt-description">
					{t("update.promptDescription")}
				</p>

				<div className="update-prompt-versions">
					<span>
						{t("update.currentVersion").replace(
							"{version}",
							info.currentVersion,
						)}
					</span>
					<span aria-hidden="true">→</span>
					<strong>
						{t("update.newVersion").replace("{version}", info.version)}
					</strong>
				</div>

				{info.body && (
					<div className="update-prompt-notes">
						<strong>{t("update.releaseNotes")}</strong>
						<p>{info.body}</p>
					</div>
				)}

				<label className="update-prompt-snooze">
					<input
						type="checkbox"
						checked={snoozeForMonth}
						onChange={(event) => setSnoozeForMonth(event.target.checked)}
						disabled={installing}
					/>
					<span>{t("update.snoozeMonth")}</span>
				</label>

				{installFailed && (
					<p className="update-prompt-error" role="alert">
						{t("update.installFailed")}
					</p>
				)}

				<footer className="update-prompt-actions">
					<button
						type="button"
						className="update-prompt-details"
						onClick={handleViewDetails}
						disabled={installing}
					>
						{t("update.viewDetails")}
					</button>
					<div className="update-prompt-primary-actions">
						<button
							type="button"
							className="update-prompt-later"
							onClick={() => onLater(snoozeForMonth)}
							disabled={installing}
						>
							{t("update.later")}
						</button>
						<button
							ref={installButtonRef}
							type="button"
							className="update-prompt-install"
							onClick={handleInstall}
							disabled={installing}
						>
							{installing ? t("update.installing") : t("update.now")}
						</button>
					</div>
				</footer>
			</dialog>
		</div>
	);
}
