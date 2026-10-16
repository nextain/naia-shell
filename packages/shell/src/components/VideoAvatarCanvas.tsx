import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { getAdkPath, toLocalBlobUrl } from "../lib/adk-store";
import {
	clearCameraActions,
	registerCameraActions,
} from "../lib/avatar/camera-actions";
import { PrebakedAvatarRenderer } from "../lib/avatar/prebaked-renderer";
import { getLocale, t } from "../lib/i18n";
import {
	UI_PREFERENCE_KEYS,
	patchUiPreferences,
	useUiPreference,
} from "../lib/ui-preferences";
import {
	type NvaManifest,
	isPrebakedNvaManifest,
	parseNvaManifest,
	resolveNvaAssetPath,
} from "../lib/nva";
import { useAvatarStore } from "../stores/avatar";
import { useCascadeAvatarStore } from "../stores/cascade-avatar";

interface VideoAvatarCanvasProps {
	nvaModel?: string;
	presentationMode?: boolean;
}
type Mode = "loading" | "prebaked" | "error";
interface NvaPan {
	x: number;
	y: number;
}
const DEFAULT_NVA_PAN: NvaPan = { x: 0, y: 0 };
function videoTransform(pan: NvaPan): string {
	return `translate(calc(var(--naia-width, 320px) / 2 - 50vw + ${pan.x}px), ${pan.y}px)`;
}
function presentationFace(manifest: NvaManifest | null) {
	const animation = manifest
		? Object.values(manifest.animations ?? {}).find(
				(candidate) => candidate.can_talk && candidate.face_bbox,
				) ??
				Object.values(manifest.animations ?? {}).find(
					(candidate) => candidate.face_bbox,
				)
		: undefined;
	const bbox = animation?.face_bbox;
	if (
		!bbox ||
		(bbox.length !== 3 && bbox.length !== 4) ||
		bbox.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
	)
		return { x: 0.5, y: 0.28, width: 0.42, height: 0.44 };
	return {
		x: bbox[0],
		y: bbox[1],
		width: bbox[2],
		height: bbox.length === 3 ? bbox[2] : bbox[3],
	};
}

export function presentationAvatarTransform(
	manifest: NvaManifest | null,
	viewportWidth = 320,
	viewportHeight = 360,
) {
	const face = presentationFace(manifest);
	const centerX = face.x + face.width / 2;
	const centerY = face.y + face.height / 2;
	const canvasWidth = manifest?.canvas.width ?? 1;
	const canvasHeight = manifest?.canvas.height ?? 1;
	const fitScale = Math.min(
		viewportWidth / canvasWidth,
		viewportHeight / canvasHeight,
	);
	const width = canvasWidth * fitScale;
	const height = canvasHeight * fitScale;
	const zoom = Math.max(
		1,
		Math.min(
			0.62 * viewportHeight / Math.max(face.height * height, 1),
			0.9 * viewportWidth / Math.max(face.width * width, 1),
		),
	);
	return {
		width,
		height,
		transform: `translate(${(0.5 - centerX) * width}px, ${(0.43 - centerY) * height}px) scale(${zoom})`,
		transformOrigin: `${centerX * 100}% ${centerY * 100}%`,
		zoom,
		face,
	};
}
const VIDEO_STYLE = {
	maxWidth: "min(100%, 56vh)",
	maxHeight: "92%",
	objectFit: "contain" as const,
};

/** GPU 없는 pre-baked NVA player. retired server-side avatar/cascade를 시작하지 않는다. */
export function VideoAvatarCanvas({
	nvaModel,
	presentationMode = false,
}: VideoAvatarCanvasProps) {
	const setLoaded = useAvatarStore((state) => state.setLoaded);
	const [mode, setMode] = useState<Mode>("loading");
	const [error, setError] = useState("");
	const [manifest, setManifest] = useState<NvaManifest | null>(null);
	const [bundleDir, setBundleDir] = useState("");
	const [presentationViewport, setPresentationViewport] = useState({
		width: 320,
		height: 360,
	});
	const [video, setVideo] = useState<HTMLVideoElement | null>(null);
	const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
	const avatarViewportRef = useRef<HTMLDivElement | null>(null);
	const persistedPan = useUiPreference<NvaPan>(
		UI_PREFERENCE_KEYS.nvaPan,
		DEFAULT_NVA_PAN,
	);
	const [pan, setPan] = useState<NvaPan>(persistedPan);
	useEffect(() => setPan(persistedPan), [persistedPan]);
	const panRef = useRef(pan);
	panRef.current = pan;
	const presentationCrop = presentationAvatarTransform(
		manifest,
		presentationViewport.width,
		presentationViewport.height,
	);

	useEffect(() => {
		if (!presentationMode || !avatarViewportRef.current) return;
		const element = avatarViewportRef.current;
		const updateSize = () => {
			const bounds = element.getBoundingClientRect();
			if (bounds.width > 0 && bounds.height > 0) {
				setPresentationViewport({ width: bounds.width, height: bounds.height });
			}
		};
		updateSize();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(updateSize);
		observer.observe(element);
		return () => observer.disconnect();
	}, [presentationMode]);

	useEffect(() => {
		registerCameraActions({
			rotate: () => {},
			pan: (dx, dy) =>
				setPan((current) => ({ x: current.x + dx, y: current.y + dy })),
			reset: () => {
				setPan({ x: 0, y: 0 });
				void patchUiPreferences({ [UI_PREFERENCE_KEYS.nvaPan]: undefined });
			},
			save: () =>
				void patchUiPreferences({
					[UI_PREFERENCE_KEYS.nvaPan]: panRef.current,
				}),
		});
		return () => clearCameraActions();
	}, []);

	useEffect(() => {
		let disposed = false;
		setMode("loading");
		setError("");
		setManifest(null);
		setLoaded(false);
		useCascadeAvatarStore.getState().setNvaLoadError(null);
		const adkPath = getAdkPath();
		if (!adkPath || !nvaModel) {
			setError("missing-nva-model");
			setMode("error");
			useCascadeAvatarStore.getState().setNvaLoadError("missing-nva-model");
			return;
		}
		const bundleName =
			nvaModel.split(/[/\\]/).filter(Boolean).pop() ?? nvaModel;
		const sep = adkPath.includes("\\") ? "\\" : "/";
		const directory = `${adkPath}${sep}naia-settings${sep}nva-files${sep}${bundleName}`;
		void invoke<string>("read_local_binary", {
			path: `${directory}${sep}manifest.json`,
			allowedBase: adkPath,
		})
			.then((base64) => {
				const raw = atob(base64);
				const parsed = parseNvaManifest(
					new TextDecoder().decode(
						Uint8Array.from(raw, (char) => char.charCodeAt(0)),
					),
				);
				if (!isPrebakedNvaManifest(parsed))
					throw new Error("NVA requires vrm_slots prebaked WebM assets");
				if (!disposed) {
					setBundleDir(directory);
					setManifest(parsed);
				}
			})
			.catch((cause) => {
				if (!disposed) {
					setError(String(cause));
					setMode("error");
					useCascadeAvatarStore.getState().setNvaLoadError(String(cause));
				}
			});
		return () => {
			disposed = true;
		};
	}, [nvaModel, setLoaded]);

	useEffect(() => {
		if (!video || !canvas || !manifest || !bundleDir) return;
		canvas.width = manifest.canvas.width;
		canvas.height = manifest.canvas.height;
		const urls = new Map<string, string>();
		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: getLocale(),
			resolveAssetUrl: async (relativePath) => {
				const cached = urls.get(relativePath);
				if (cached) return cached;
				const url = await toLocalBlobUrl(
					resolveNvaAssetPath(bundleDir, relativePath),
				);
				urls.set(relativePath, url);
				return url;
			},
			onSpeaking: (speaking) => useAvatarStore.getState().setSpeaking(speaking),
		});
		renderer.start(video, canvas);
		useCascadeAvatarStore.getState().setRenderer(renderer);
		useCascadeAvatarStore.getState().setNvaLoadError(null);
		setMode("prebaked");
		setLoaded(true);
		return () => {
			renderer.stop();
			if (useCascadeAvatarStore.getState().renderer === renderer)
				useCascadeAvatarStore.getState().setRenderer(null);
			for (const url of urls.values())
				if (url.startsWith("blob:")) URL.revokeObjectURL(url);
		};
	}, [video, canvas, manifest, bundleDir, setLoaded]);

	return (
		<div
			ref={avatarViewportRef}
			data-video-avatar
			data-nva-model={nvaModel ?? ""}
			data-video-avatar-mode={mode}
			data-video-avatar-loaded={mode === "prebaked" ? "true" : "false"}
			data-video-avatar-error={error}
			style={{
				position: "relative",
				width: "100%",
				height: "100%",
				overflow: "hidden",
				display: "grid",
				placeItems: "center",
			}}
		>
			{/* Hidden decode buffer — never shown directly (mp4 talking clips have no
			    alpha, so the visible surface is always the composited canvas below). */}
			{/* biome-ignore lint/a11y/useMediaCaption: speech text is already rendered in the chat transcript. */}
			<video
				ref={setVideo}
				playsInline
				style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
			/>
			<canvas
				ref={setCanvas}
				data-video-avatar-prebaked
				data-presentation-crop={presentationMode ? "face" : undefined}
				style={
					presentationMode
						? {
							...VIDEO_STYLE,
							width: `${presentationCrop.width}px`,
							height: `${presentationCrop.height}px`,
							maxWidth: "none",
							maxHeight: "none",
							transform: presentationCrop.transform,
							transformOrigin: presentationCrop.transformOrigin,
						}
						: { ...VIDEO_STYLE, transform: videoTransform(pan) }
				}
			/>
			{mode !== "prebaked" && (
				<output data-video-avatar-status={mode} aria-live="polite">
					{mode === "loading"
						? t("avatar.videoLoading")
						: t("avatar.videoFailed")}
				</output>
			)}
		</div>
	);
}
