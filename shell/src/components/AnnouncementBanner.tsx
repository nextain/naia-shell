import { openUrl } from "@tauri-apps/plugin-opener";
import {
	type Announcement,
	getLocalizedText,
	markAnnouncementRead,
} from "../lib/announcements";
import { getLocale, t } from "../lib/i18n";

interface AnnouncementBannerProps {
	announcements: Announcement[];
	onDismissAll: () => void;
	onDismissOne: (id: string) => void;
}

const TYPE_ICON: Record<string, string> = {
	release: "🚀",
	maintenance: "🔧",
	warning: "⚠",
	info: "ℹ",
};

export function AnnouncementBanner({
	announcements,
	onDismissAll,
	onDismissOne,
}: AnnouncementBannerProps) {
	if (announcements.length === 0) return null;

	const lang = getLocale();
	// Show the first (highest-priority) announcement
	const item = announcements[0];
	const icon = TYPE_ICON[item.type] ?? "ℹ";
	const title = getLocalizedText(item.title, lang);
	const body = getLocalizedText(item.body, lang);
	const remaining = announcements.length - 1;

	const handleDismiss = () => {
		markAnnouncementRead(item.id);
		onDismissOne(item.id);
	};

	const handleDismissAll = () => {
		for (const a of announcements) markAnnouncementRead(a.id);
		onDismissAll();
	};

	const handleLink = () => {
		if (item.url && /^https?:\/\//.test(item.url)) {
			openUrl(item.url).catch(() => {});
		}
	};

	return (
		<div className={`announcement-banner announcement-banner--${item.type}`}>
			<span className="announcement-banner__icon">{icon}</span>
			<div className="announcement-banner__content">
				<strong className="announcement-banner__title">{title}</strong>
				<span className="announcement-banner__body">{body}</span>
			</div>
			<div className="announcement-banner__actions">
				{item.url && (
					<button
						type="button"
						className="announcement-btn announcement-btn--link"
						onClick={handleLink}
					>
						{t("announcement.details")}
					</button>
				)}
				<button
					type="button"
					className="announcement-btn announcement-btn--dismiss"
					onClick={handleDismiss}
				>
					{remaining > 0
						? t("announcement.next").replace("{remaining}", String(remaining))
						: t("announcement.dismiss")}
				</button>
				{remaining > 0 && (
					<button
						type="button"
						className="announcement-btn announcement-btn--dismiss-all"
						onClick={handleDismissAll}
					>
						×
					</button>
				)}
			</div>
		</div>
	);
}
