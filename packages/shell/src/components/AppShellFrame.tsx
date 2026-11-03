import { getCurrentWindow } from "@tauri-apps/api/window";
import { useRef, useState } from "react";
import { loadConfig, saveConfig } from "../lib/config";
import { AppMainContent, type AppMainContentProps } from "./AppMainContent";
import { SplashScreen } from "./SplashScreen";

const NAIA_WIDTH_MIN = 120;
const NAIA_WIDTH_MAX = 1200;

type MainContentProps = Omit<
	AppMainContentProps,
	| "handleNaiaWidthPointerDown"
	| "handleNaiaWidthPointerMove"
	| "handleNaiaWidthPointerUp"
>;

interface AppShellFrameProps {
	appReady: boolean;
	/**
	 * 부팅의 마지막까지 끝났는가. `appReady` 는 스플래시를 걷는 시점이고,
	 * 이것은 앱 목록까지 자리를 잡아 앱바가 채워진 시점이다. 부팅 지연은
	 * 이 표지로 잰다 — 앞의 표지만 재면 뒤 구간의 회귀가 보이지 않는다.
	 */
	bootComplete: boolean;
	backgroundFallback: { url: string; type: "image" | "video" } | null;
	backgroundMediaType: "iframe" | "image" | "video" | "";
	backgroundVideoUrl: string;
	mainContent: MainContentProps;
	onSplashDone: () => void;
	setNaiaWidth: (width: number) => void;
}

function isMediaFile(url: string, extensions: Set<string>): boolean {
	const extension = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
	return extensions.has(extension);
}

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "ogg", "avi"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);

export function AppShellFrame({
	appReady,
	bootComplete,
	backgroundFallback,
	backgroundMediaType,
	backgroundVideoUrl,
	mainContent,
	onSplashDone,
	setNaiaWidth,
}: AppShellFrameProps) {
	const [failedVideoUrl, setFailedVideoUrl] = useState("");
	const autumnVideo = backgroundVideoUrl === "/backgrounds/naia-autumn-office-live.mp4";
	const widthDragRef = useRef<{
		startX: number;
		startW: number;
		currentW: number;
		moved: boolean;
	} | null>(null);

	const handleWinResize =
		(
			direction: Parameters<
				ReturnType<typeof getCurrentWindow>["startResizeDragging"]
			>[0],
		) =>
		(event: React.PointerEvent) => {
			event.preventDefault();
			getCurrentWindow().startResizeDragging(direction);
		};
	const handleNaiaWidthPointerDown = (event: React.PointerEvent) => {
		event.preventDefault();
		widthDragRef.current = {
			startX: event.clientX,
			startW: mainContent.naiaWidth,
			currentW: mainContent.naiaWidth,
			moved: false,
		};
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		document.body.classList.add("resizing-col");
	};
	const handleNaiaWidthPointerMove = (event: React.PointerEvent) => {
		const drag = widthDragRef.current;
		if (!drag) return;
		const delta = event.clientX - drag.startX;
		if (!drag.moved && Math.abs(delta) > 4) drag.moved = true;
		if (!drag.moved) return;
		drag.currentW = Math.max(
			NAIA_WIDTH_MIN,
			Math.min(NAIA_WIDTH_MAX, drag.startW + delta),
		);
		setNaiaWidth(drag.currentW);
	};
	const handleNaiaWidthPointerUp = () => {
		const drag = widthDragRef.current;
		widthDragRef.current = null;
		document.body.classList.remove("resizing-col");
		if (!drag?.moved) return;
		const config = loadConfig();
		if (config)
			saveConfig({
				...config,
				appSize: Math.round((drag.currentW / 1200) * 100),
			});
	};

	const foreground =
		backgroundMediaType === "iframe" && backgroundVideoUrl ? (
			<iframe
				key={backgroundVideoUrl}
				className="app-bg-iframe"
				src={backgroundVideoUrl}
				allow="autoplay"
				referrerPolicy="origin"
				sandbox="allow-scripts allow-same-origin allow-presentation"
				title="BGM"
				style={{ zIndex: 1 }}
			/>
		) : backgroundVideoUrl &&
			(backgroundMediaType === "video" ||
				(!backgroundMediaType &&
					isMediaFile(backgroundVideoUrl, VIDEO_EXTENSIONS))) ? (
			failedVideoUrl === backgroundVideoUrl && autumnVideo ? (
				<img className="app-bg-image" src="/backgrounds/naia-autumn-office.webp" alt="" style={{ zIndex: 1 }} />
			) : failedVideoUrl === backgroundVideoUrl ? null : <video
				key={backgroundVideoUrl}
				className="app-bg-video"
				src={backgroundVideoUrl}
				autoPlay
				loop
				muted
				playsInline
				preload="none"
				poster={autumnVideo ? "/backgrounds/naia-autumn-office.webp" : undefined}
				onCanPlay={(event) => {
					if (autumnVideo) {
						void event.currentTarget.play().catch(() => setFailedVideoUrl(backgroundVideoUrl));
					}
				}}
				onError={() => setFailedVideoUrl(backgroundVideoUrl)}
				style={{ zIndex: 1 }}
			/>
		) : backgroundVideoUrl &&
			(backgroundMediaType === "image" ||
				(!backgroundMediaType &&
					isMediaFile(backgroundVideoUrl, IMAGE_EXTENSIONS))) ? (
			<img
				key={backgroundVideoUrl}
				className="app-bg-image"
				src={backgroundVideoUrl}
				alt=""
				style={{ zIndex: 1 }}
			/>
		) : null;

	return (
		<div
			className="app-root"
			data-ui-mode={mainContent.uiMode}
			data-rail-collapsed={
				mainContent.uiMode === "workspace" && mainContent.railCollapsed
					? "true"
					: "false"
			}
			// 부팅이 어디까지 왔는지 밖에서 볼 수 있게 한다. 시작 지연을 재는
			// 스펙이 화면 요소가 그려진 순간을 잡으면, 설정을 읽고 로케일을
			// 적용하는 구간이 통째로 빠진다 — 실제로 그 구간에 3초를 넣어도
			// 숫자가 움직이지 않았다.
			data-app-ready={appReady ? "true" : "false"}
			data-app-boot-complete={bootComplete ? "true" : "false"}
			style={
				{ "--naia-width": `${mainContent.naiaWidth}px` } as React.CSSProperties
			}
		>
			{(!foreground || backgroundMediaType === "iframe") && (backgroundFallback?.url === "/backgrounds/naia-autumn-office-live.mp4" ? (
				<img className="app-bg-image" src="/backgrounds/naia-autumn-office.webp" alt="" style={{ zIndex: 0 }} />
			) : backgroundFallback?.type === "video" ? (
				<video
					className="app-bg-video"
					src={backgroundFallback.url}
					autoPlay
					loop
					muted
					playsInline
					style={{ zIndex: 0 }}
				/>
			) : backgroundFallback ? (
				<img
					className="app-bg-image"
					src={backgroundFallback.url}
					alt=""
					style={{ zIndex: 0 }}
				/>
			) : (
				<div className="app-bg-fallback" aria-hidden="true" />
			))}
			{foreground}
			{mainContent.showSplash && (
				<SplashScreen onDone={onSplashDone} ready={appReady} />
			)}
			<div className="wr-nw" onPointerDown={handleWinResize("NorthWest")} />
			<div className="wr-n" onPointerDown={handleWinResize("North")} />
			<div className="wr-ne" onPointerDown={handleWinResize("NorthEast")} />
			<div className="wr-w" onPointerDown={handleWinResize("West")} />
			<div className="wr-e" onPointerDown={handleWinResize("East")} />
			<div className="wr-sw" onPointerDown={handleWinResize("SouthWest")} />
			<div className="wr-s" onPointerDown={handleWinResize("South")} />
			<div className="wr-se" onPointerDown={handleWinResize("SouthEast")} />
			<AppMainContent
				{...mainContent}
				handleNaiaWidthPointerDown={handleNaiaWidthPointerDown}
				handleNaiaWidthPointerMove={handleNaiaWidthPointerMove}
				handleNaiaWidthPointerUp={handleNaiaWidthPointerUp}
			/>
		</div>
	);
}
