import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { getAdkPath, readLocalBlob, toLocalBlobUrl } from "../lib/adk-store";
import {
	clearCameraActions,
	getCameraActions,
	registerCameraActions,
} from "../lib/avatar/camera-actions";
import {
	createDesktopNvaAssetBlobLoader,
	isStackedAlphaClipUrl,
	isWebKitWithoutVp9Alpha,
	probeBundledPublicNvaUrl,
	resolveNvaClipCandidates,
	shouldUseStackedAlpha,
} from "../lib/avatar/nva-stacked-alpha";
import {
	PrebakedAvatarRenderer,
	type ResolvedNvaClipSource,
} from "../lib/avatar/prebaked-renderer";
import { getLocale, t } from "../lib/i18n";
import {
	type NvaManifest,
	collectNvaManifestClipPaths,
	isPrebakedNvaManifest,
	parseNvaManifest,
	resolveNvaAssetPath,
} from "../lib/nva";
import {
	UI_PREFERENCE_KEYS,
	patchUiPreferences,
	useUiPreference,
} from "../lib/ui-preferences";
import { useAvatarStore } from "../stores/avatar";
import { useCascadeAvatarStore } from "../stores/cascade-avatar";

interface VideoAvatarCanvasProps {
	nvaModel?: string;
}
type Mode = "loading" | "prebaked" | "error";
interface NvaPan {
	x: number;
	y: number;
}
const DEFAULT_NVA_PAN: NvaPan = { x: 0, y: 0 };
function videoTransform(pan: NvaPan, zoom = 1): string {
	return `translate(calc(var(--naia-width, 320px) / 2 - 50vw + ${pan.x}px), ${pan.y}px) scale(${zoom})`;
}
const MIN_NVA_ZOOM = 0.5;
const MAX_NVA_ZOOM = 3;
const NVA_ZOOM_STEP = 0.1;
function clampNvaZoom(value: number): number {
	return Math.min(MAX_NVA_ZOOM, Math.max(MIN_NVA_ZOOM, value));
}
function normalizeNvaZoom(value: unknown): number {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= MIN_NVA_ZOOM &&
		value <= MAX_NVA_ZOOM
		? value
		: 1;
}
const VIDEO_STYLE = {
	maxWidth: "min(100%, 56vh)",
	maxHeight: "92%",
	objectFit: "contain" as const,
};

function base64ToBlobUrl(base64: string, mimeType: string): string {
	const raw = atob(base64);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) {
		bytes[i] = raw.charCodeAt(i);
	}
	return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

/** GPU 없는 pre-baked NVA player. retired server-side avatar/cascade를 시작하지 않는다. */
export function VideoAvatarCanvas({ nvaModel }: VideoAvatarCanvasProps) {
	const setLoaded = useAvatarStore((state) => state.setLoaded);
	const [mode, setMode] = useState<Mode>("loading");
	const [error, setError] = useState("");
	const [manifest, setManifest] = useState<NvaManifest | null>(null);
	const [bundleDir, setBundleDir] = useState("");
	const [video, setVideo] = useState<HTMLVideoElement | null>(null);
	const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
	const avatarAreaRef = useRef<HTMLDivElement>(null);
	const rendererRef = useRef<PrebakedAvatarRenderer | null>(null);
	const persistedPan = useUiPreference<NvaPan>(
		UI_PREFERENCE_KEYS.nvaPan,
		DEFAULT_NVA_PAN,
	);
	const persistedZoom = useUiPreference<number>(UI_PREFERENCE_KEYS.nvaZoom, 1);
	const [pan, setPan] = useState<NvaPan>(persistedPan);
	const [zoom, setZoom] = useState(() => normalizeNvaZoom(persistedZoom));
	useEffect(() => setPan(persistedPan), [persistedPan]);
	useEffect(() => {
		const value = normalizeNvaZoom(persistedZoom);
		setZoom(value);
		zoomRef.current = value;
	}, [persistedZoom]);
	const panRef = useRef(pan);
	panRef.current = pan;
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;

	useEffect(() => {
		registerCameraActions({
			rotate: () => {},
			pan: (dx, dy) => {
				const next = { x: panRef.current.x + dx, y: panRef.current.y + dy };
				panRef.current = next;
				setPan(next);
			},
			zoom: (delta) => {
				const next = clampNvaZoom(zoomRef.current + delta);
				zoomRef.current = next;
				setZoom(next);
			},
			reset: () => {
				setPan({ x: 0, y: 0 });
				panRef.current = DEFAULT_NVA_PAN;
				setZoom(1);
				zoomRef.current = 1;
				void patchUiPreferences({
					[UI_PREFERENCE_KEYS.nvaPan]: undefined,
					[UI_PREFERENCE_KEYS.nvaZoom]: undefined,
				});
			},
			save: () =>
				void patchUiPreferences({
					[UI_PREFERENCE_KEYS.nvaPan]: panRef.current,
					[UI_PREFERENCE_KEYS.nvaZoom]:
						zoomRef.current === 1 ? undefined : zoomRef.current,
				}),
			getGestureActions: () => rendererRef.current?.getGestureActions() ?? [],
			playAction: (key) =>
				rendererRef.current?.playAction(key) ?? Promise.resolve(false),
		});
		return () => clearCameraActions();
	}, []);

	useEffect(() => {
		const area = avatarAreaRef.current;
		if (!area) return;
		let saveTimer: ReturnType<typeof setTimeout> | undefined;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			getCameraActions().zoom(
				event.deltaY < 0 ? NVA_ZOOM_STEP : -NVA_ZOOM_STEP,
			);
			if (saveTimer) clearTimeout(saveTimer);
			saveTimer = setTimeout(() => getCameraActions().save(), 180);
		};
		area.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			area.removeEventListener("wheel", onWheel);
			if (saveTimer) clearTimeout(saveTimer);
		};
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
				for (const clipPath of collectNvaManifestClipPaths(parsed)) {
					resolveNvaAssetPath(directory, clipPath);
				}
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
		const adkPath = getAdkPath() ?? "";
		const bundleName =
			bundleDir.split(/[/\\]/).filter(Boolean).pop() ??
			nvaModel?.split(/[/\\]/).filter(Boolean).pop() ??
			"";
		const preferStacked = shouldUseStackedAlpha();
		const webmUnsupported = isWebKitWithoutVp9Alpha();

		const resolveDirectLocalUrl = async (
			relativePath: string,
		): Promise<string> => {
			const cached = urls.get(relativePath);
			if (cached) return cached;
			const url = await toLocalBlobUrl(
				resolveNvaAssetPath(bundleDir, relativePath),
			);
			urls.set(relativePath, url);
			return url;
		};

		const resolveOptionalMp4FallbackUrl = async (
			relativePath: string,
		): Promise<string | null> => {
			const cached = urls.get(relativePath);
			if (cached) return cached;
			const localPath = resolveNvaAssetPath(bundleDir, relativePath);
			if (adkPath) {
				try {
					const b64 = await invoke<string>("read_local_binary", {
						path: localPath,
						allowedBase: adkPath,
					});
					if (b64) {
						const blobUrl = base64ToBlobUrl(b64, "video/mp4");
						urls.set(relativePath, blobUrl);
						return blobUrl;
					}
				} catch {
					// Not in ADK workspace; probe bundled public fallback next.
				}
			}
			const bundledUrl = await probeBundledPublicNvaUrl(
				bundleName,
				relativePath,
			);
			if (bundledUrl) {
				urls.set(relativePath, bundledUrl);
				return bundledUrl;
			}
			return null;
		};

		const loadAssetBlob = createDesktopNvaAssetBlobLoader({
			manifest,
			bundleName,
			readLocalAssetBlob: (relativePath) =>
				readLocalBlob(resolveNvaAssetPath(bundleDir, relativePath), adkPath),
			preferStackedAlpha: preferStacked,
			webmUnsupported,
		});

		const renderer = new PrebakedAvatarRenderer({
			manifest,
			locale: getLocale(),
			resolveAssetUrl: resolveDirectLocalUrl,
			loadAssetBlob,
			resolveClipCandidates: async (
				relativePath: string,
			): Promise<ResolvedNvaClipSource[]> => {
				const candidates = resolveNvaClipCandidates(manifest, relativePath, {
					preferStackedAlpha: preferStacked,
					webmUnsupported,
				});
				const resolved: ResolvedNvaClipSource[] = [];
				for (const candidate of candidates) {
					if (candidate.inferredFallback) {
						// Only probe inferred `.stacked.mp4` / `.mp4` eagerly when VP9+Alpha WebM
						// is unsupported (macOS WKWebView / Safari) or after primary failure.
						if (!webmUnsupported) continue;
						const fallbackUrl = await resolveOptionalMp4FallbackUrl(
							candidate.path,
						);
						if (fallbackUrl) {
							resolved.push({
								url: fallbackUrl,
								stackedAlpha: candidate.stackedAlpha,
								resolvedPath: candidate.path,
							});
						}
						continue;
					}
					// Declared in `manifest.stacked_alpha.clips` or primary clip path.
					// If a declared `stacked_alpha` clip is missing from an un-synced ADK,
					// also fall back to bundled `/nva/<bundle>/...` when running on WebKit.
					if (
						candidate.stackedAlpha &&
						candidate.path !== relativePath &&
						webmUnsupported &&
						adkPath
					) {
						const fallbackUrl = await resolveOptionalMp4FallbackUrl(
							candidate.path,
						);
						if (fallbackUrl) {
							resolved.push({
								url: fallbackUrl,
								stackedAlpha: true,
								resolvedPath: candidate.path,
							});
							continue;
						}
					}
					const url = await resolveDirectLocalUrl(candidate.path);
					resolved.push({
						url,
						stackedAlpha:
							candidate.stackedAlpha || isStackedAlphaClipUrl(candidate.path),
						resolvedPath: candidate.path,
					});
				}
				return resolved;
			},
			onSpeaking: (speaking) => useAvatarStore.getState().setSpeaking(speaking),
			onPlaybackFailure: (reason) => {
				setError(reason);
				setMode("error");
				setLoaded(false);
				useCascadeAvatarStore.getState().setNvaLoadError(reason);
				if (useCascadeAvatarStore.getState().renderer === renderer) {
					useCascadeAvatarStore.getState().setRenderer(null);
				}
			},
		});
		renderer.start(video, canvas);
		rendererRef.current = renderer;
		useCascadeAvatarStore.getState().setRenderer(renderer);
		useCascadeAvatarStore.getState().setNvaLoadError(null);
		setMode("prebaked");
		setLoaded(true);
		return () => {
			renderer.stop();
			if (rendererRef.current === renderer) rendererRef.current = null;
			if (useCascadeAvatarStore.getState().renderer === renderer)
				useCascadeAvatarStore.getState().setRenderer(null);
			for (const url of urls.values())
				if (url.startsWith("blob:")) URL.revokeObjectURL(url);
		};
	}, [video, canvas, manifest, bundleDir, nvaModel, setLoaded]);

	return (
		<div
			ref={avatarAreaRef}
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
				muted
				playsInline
				style={{
					position: "absolute",
					width: 1,
					height: 1,
					opacity: 0,
					pointerEvents: "none",
				}}
			/>
			<canvas
				ref={setCanvas}
				data-video-avatar-prebaked
				style={{
					...VIDEO_STYLE,
					transform: videoTransform(pan, zoom),
					visibility: mode === "error" ? "hidden" : "visible",
				}}
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
