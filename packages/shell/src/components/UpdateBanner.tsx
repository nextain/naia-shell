import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { NAIA_WEB_BASE_URL } from "../lib/config";
import { getLocale, t } from "../lib/i18n";
import { Logger } from "../lib/logger";
import { naiaWebUrl } from "../lib/naia-instance-urls";
import type { UpdateInfo } from "../lib/updater";

interface UpdateBannerProps {
	info: UpdateInfo;
	onDismiss: () => void;
}

export function UpdateBanner({ info, onDismiss }: UpdateBannerProps) {
	const [installing, setInstalling] = useState(false);

	const handleUpdate = async () => {
		setInstalling(true);
		try {
			await info.installFn();
		} catch (err) {
			Logger.warn("UpdateBanner", "Install failed", { error: String(err) });
			setInstalling(false);
		}
	};

	const handleViewDetails = () => {
		const locale = getLocale();
		openUrl(naiaWebUrl(`${locale}/download`, NAIA_WEB_BASE_URL)).catch(() => {});
	};

	if (installing) {
		return (
			<div className="update-banner">
				<span>{t("update.installing")}</span>
			</div>
		);
	}

	return (
		<div className="update-banner">
			<span className="update-banner-text">
				{t("update.available")} —{" "}
				{t("update.newVersion").replace("{version}", info.version)}
			</span>
			<div className="update-banner-actions">
				<button
					type="button"
					className="update-btn-details"
					data-usage-event="update-banner.handle-view-details-1.click"
					onClick={handleViewDetails}
				>
					{t("update.viewDetails")}
				</button>
				<button
					type="button"
					className="update-btn-install"
					data-usage-event="update-banner.handle-update-2.click"
					onClick={handleUpdate}
				>
					{t("update.now")}
				</button>
				<button
					type="button"
					className="update-btn-dismiss"
					data-usage-event="update-banner.on-dismiss-3.click"
					onClick={onDismiss}
				>
					{t("update.later")}
				</button>
			</div>
		</div>
	);
}
