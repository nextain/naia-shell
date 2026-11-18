import { getCurrentWindow } from "@tauri-apps/api/window";

interface TitleBarProps {
	appVisible: boolean;
	onToggleApp: () => void;
	title?: string;
}

export function TitleBar({
	appVisible,
	onToggleApp,
	title = "Naia",
}: TitleBarProps) {
	const appWindow = getCurrentWindow();

	function handleDragStart(e: React.MouseEvent) {
		if ((e.target as HTMLElement).closest(".titlebar-buttons")) return;
		// Double-click: toggle maximize/restore (same as OS native titlebar)
		if (e.detail === 2) {
			appWindow.isMaximized().then((maximized) => {
				maximized ? appWindow.unmaximize() : appWindow.maximize();
			});
			return;
		}
		e.preventDefault();
		appWindow.startDragging();
	}

	return (
		<div className="titlebar" onMouseDown={handleDragStart}>
			<div
				className="titlebar-brand"
				aria-label={`Naia - ${title.trim() || "Naia"}`}
			>
				<img className="titlebar-logo" src="/brand/naia-logo.png" alt="" />
				<span className="titlebar-label">{title.trim() || "Naia"}</span>
			</div>
			<div className="titlebar-buttons">
				<button
					type="button"
					className="titlebar-btn"
					data-usage-event="title-bar.on-toggle-app-1.click"
					onClick={onToggleApp}
					title={appVisible ? "채팅 숨기기 (Ctrl+B)" : "채팅 보이기 (Ctrl+B)"}
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 14 14"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<rect x="1" y="1" width="12" height="12" rx="1.5" />
						{appVisible ? (
							<line x1="6" y1="1" x2="6" y2="13" />
						) : (
							<line x1="6" y1="1" x2="6" y2="13" strokeDasharray="2 2" />
						)}
					</svg>
				</button>
				<button
					type="button"
					className="titlebar-btn"
					data-usage-event="title-bar.button-2.click"
					onClick={() => appWindow.minimize()}
					title="최소화"
				>
					&#8211;
				</button>
				<button
					type="button"
					className="titlebar-btn"
					data-usage-event="title-bar.button-3.click"
					onClick={async () => {
						if (await appWindow.isMaximized()) {
							appWindow.unmaximize();
						} else {
							appWindow.maximize();
						}
					}}
					title="최대화"
				>
					&#9633;
				</button>
				<button
					type="button"
					className="titlebar-btn titlebar-btn-close"
					data-usage-event="title-bar.button-4.click"
					onClick={() => appWindow.close()}
					title="닫기"
				>
					&#10005;
				</button>
			</div>
		</div>
	);
}
