import { useEffect, useState } from "react";
import {
	type BrowserLink,
	loadBrowserBookmarks,
	onBrowserPrefsChanged,
	removeBrowserBookmark,
} from "../../lib/browser-prefs";
import { Logger } from "../../lib/logger";

interface BrowserMetaAreaProps {
	onNavigate: (url: string) => void;
}

export function BrowserMetaArea({ onNavigate }: BrowserMetaAreaProps) {
	const [bookmarks, setBookmarks] = useState<BrowserLink[]>([]);

	useEffect(() => {
		let alive = true;
		const load = () => {
			loadBrowserBookmarks()
				.then((items) => {
					if (alive) setBookmarks(items);
				})
				.catch((err) => {
					Logger.warn("BrowserMetaArea", "failed to load bookmarks", {
						error: String(err),
					});
				});
		};
		load();
		const off = onBrowserPrefsChanged(load);
		return () => {
			alive = false;
			off();
		};
	}, []);

	function handleRemove(url: string) {
		removeBrowserBookmark(url)
			.then(setBookmarks)
			.catch((err) => {
				Logger.warn("BrowserMetaArea", "failed to remove bookmark", {
					error: String(err),
				});
			});
	}

	return (
		<div className="browser-meta">
			<div className="browser-meta__tabs">
				<div className="browser-meta__tab browser-meta__tab--active">
					Bookmarks
				</div>
			</div>

			<div className="browser-meta__body">
				<div className="browser-meta__bookmarks">
					{bookmarks.length === 0 ? (
						<p className="browser-meta__empty">No bookmarks yet.</p>
					) : (
						bookmarks.map((bookmark) => (
							<div key={bookmark.url} className="browser-meta__bookmark">
								<button
									type="button"
									className="browser-meta__bookmark-link"
									title={bookmark.url}
									onClick={() => onNavigate(bookmark.url)}
								>
									<span className="browser-meta__bookmark-title">
										{bookmark.title || bookmark.url}
									</span>
									<span className="browser-meta__bookmark-url">
										{bookmark.url}
									</span>
								</button>
								<button
									type="button"
									className="browser-meta__bookmark-remove"
									onClick={() => handleRemove(bookmark.url)}
									title="Remove"
								>
									x
								</button>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
}
