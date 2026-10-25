import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { getAdkPath, toLocalBlobUrl } from "../lib/adk-store";
import {
	clearCameraActions,
	registerCameraActions,
} from "../lib/avatar/camera-actions";
import { shouldUseStackedAlpha } from "../lib/avatar/nva-stacked-alpha";
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
import { isWebMode } from "../lib/web-runtime/web-assets";
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
function videoTransform(pan: NvaPan): string {
	return `translate(calc(var(--naia-width, 320px) / 2 - 50vw + ${pan.x}px), ${pan.y}px)`;
}
const VIDEO_STYLE = {
	maxWidth: "min(100%, 56vh)",
	maxHeight: "92%",
	objectFit: "contain" as const,
};

/** GPU 없는 pre-baked NVA player. retired server-side avatar/cascade를 시작하지 않는다. */
export function VideoAvatarCanvas({ nvaModel }: VideoAvatarCanvasProps) {
	const setLoaded = useAvatarStore((state) => state.setLoaded);
	const [mode, setMode] = useState<Mode>("loading");
	const [error, setError] = useState("");
	const [manifest, setManifest] = useState<NvaManifest | null>(null);
	const [bundleDir, setBundleDir] = useState("");
	const [video, setVideo] = useState<HTMLVideoElement | null>(null);
	const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
	const persistedPan = useUiPreference<NvaPan>(
		UI_PREFERENCE_KEYS.nvaPan,
		DEFAULT_NVA_PAN,
	);
	const [pan, setPan] = useState<NvaPan>(persistedPan);
	useEffect(() => setPan(persistedPan), [persistedPan]);
	const panRef = useRef(pan);
	panRef.current = pan;

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
		if (isWebMode()) {
			const segments = nvaModel?.split(/[/\\]/).filter(Boolean) ?? [];
			const bundleName = segments.at(-1) ?? "";
			if (
				!bundleName ||
				segments.includes("..") ||
				!/^[a-z0-9-]+$/.test(bundleName)
			) {
				const err = !bundleName ? "missing-nva-model" : "invalid-nva-model";
				setError(err);
				setMode("error");
				useCascadeAvatarStore.getState().setNvaLoadError(err);
				return;
			}
			const directory = `/nva/${bundleName}`;
			void fetch(`${directory}/manifest.json`)
				.then(async (res) => {
					if (!res.ok) {
						throw new Error(`HTTP ${res.status}`);
					}
					const raw =
						typeof res.text === "function"
							? await res.text()
							: JSON.stringify(await res.json());
					const parsed = parseNvaManifest(raw);
					if (!isPrebakedNvaManifest(parsed))
						throw new Error("NVA requires vrm_slots prebaked WebM assets");
					for (const anim of Object.values(parsed.animations ?? {})) {
						if (anim?.clip) resolveNvaAssetPath(directory, anim.clip);
					}
					for (const viseme of Object.values(parsed.vrm_slots?.visemes ?? {})) {
						if (viseme?.clip) resolveNvaAssetPath(directory, viseme.clip);
					}
					for (const motion of Object.values(parsed.vrm_slots?.motions ?? {})) {
						if (motion?.clip) resolveNvaAssetPath(directory, motion.clip);
					}
					for (const [clipKey, stackedClip] of Object.entries(
						parsed.stacked_alpha?.clips ?? {},
					)) {
						resolveNvaAssetPath(directory, clipKey);
						resolveNvaAssetPath(directory, stackedClip);
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
		}
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
				if (isWebMode()) {
					const validatedBase = resolveNvaAssetPath(bundleDir, relativePath);
					const normalizedRel = relativePath
						.replace(/\\/g, "/")
						.replace(/^\/+/, "");
					const stackedRel = shouldUseStackedAlpha()
						? (manifest.stacked_alpha?.clips?.[normalizedRel] ??
							manifest.stacked_alpha?.clips?.[relativePath])
						: undefined;
					const url = stackedRel
						? resolveNvaAssetPath(bundleDir, stackedRel)
						: validatedBase;
					urls.set(relativePath, url);
					return url;
				}
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
				style={{ ...VIDEO_STYLE, transform: videoTransform(pan) }}
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
