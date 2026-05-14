import type { VRM } from "@pixiv/three-vrm";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import {
	AmbientLight,
	AnimationMixer,
	Clock,
	DirectionalLight,
	LoopRepeat,
	MOUSE,
	Object3D,
	PerspectiveCamera,
	Scene,
	Spherical,
	Vector3,
	WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { randFloat } from "three/src/math/MathUtils.js";
import { getAdkPath } from "../lib/adk-store";
import { Logger } from "../lib/logger";
import {
	clipFromVRMAnimation,
	loadVRMAnimation,
	reAnchorRootPositionTrack,
} from "../lib/vrm/animation";
import { loadVrm, loadVrmFromArrayBuffer } from "../lib/vrm/core";
import {
	buildExpressionResolver,
	createEmotionController,
} from "../lib/vrm/expression";
import { randomSaccadeInterval } from "../lib/vrm/eye-motions";
import { createMouthController } from "../lib/vrm/mouth";
import { useAvatarStore } from "../stores/avatar";

// Module-level camera action bridge — lets App.tsx quick-toggles drive the
// camera without prop-drilling or store changes.
type CameraActions = {
	rotate: (dx: number, dy: number) => void;
	pan: (dx: number, dy: number) => void;
	reset: () => void;
	save: () => void;
};
const _cameraActions: CameraActions = { rotate: () => {}, pan: () => {}, reset: () => {}, save: () => {} };
export function getCameraActions(): CameraActions {
	return _cameraActions;
}

const LOOK_AT_TARGET = { x: 0, y: 0, z: -1 };
const MAX_DELTA = 0.05;
const CAMERA_STORAGE_KEY = "naia-camera-v20";
const DEFAULT_CAMERA = {
	position: { x: -0.12, y: 1.21, z: -2.09 },
	target: { x: -1.45, y: 1.0, z: 0.12 },
};

interface SavedCamera {
	px: number;
	py: number;
	pz: number;
	tx: number;
	ty: number;
	tz: number;
}

function loadCameraState(): SavedCamera | null {
	try {
		const raw = localStorage.getItem(CAMERA_STORAGE_KEY);
		if (!raw) return null;
		return JSON.parse(raw) as SavedCamera;
	} catch {
		return null;
	}
}

export function clearSavedCamera(): void {
	localStorage.removeItem(CAMERA_STORAGE_KEY);
}

function saveCameraState(camera: PerspectiveCamera, target: Vector3): void {
	const state: SavedCamera = {
		px: camera.position.x,
		py: camera.position.y,
		pz: camera.position.z,
		tx: target.x,
		ty: target.y,
		tz: target.z,
	};
	localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(state));
}

const BLINK_DURATION = 0.2;
const MIN_BLINK_INTERVAL = 1;
const MAX_BLINK_INTERVAL = 6;

function randomBlinkInterval() {
	return (
		Math.random() * (MAX_BLINK_INTERVAL - MIN_BLINK_INTERVAL) +
		MIN_BLINK_INTERVAL
	);
}

function normalizeLocalPath(path: string): string {
	if (!path.startsWith("file://")) return path;
	try {
		return decodeURIComponent(new URL(path).pathname);
	} catch {
		return path.replace(/^file:\/\//, "");
	}
}

function isAbsoluteLocalFilePath(path: string): boolean {
	// Unix absolute path
	if (path.startsWith("/")) return true;
	// Windows absolute path: C:\ or D:/ etc.
	return /^[A-Za-z]:[/\\]/.test(path);
}

function resolveAssetUrl(path: string): string {
	const normalized = normalizeLocalPath(path);
	if (normalized.startsWith("http://localhost")) {
		return normalized.replace(
			/^http:\/\/localhost\/?/,
			"http://asset.localhost/",
		);
	}
	// Relative web-asset paths — normalize to absolute web path
	if (normalized.startsWith("avatars/") || normalized.startsWith("assets/")) {
		return `/${normalized}`;
	}
	if (
		normalized.startsWith("/assets/") ||
		normalized.startsWith("/avatars/") ||
		normalized.startsWith("asset:") ||
		normalized.startsWith("http://asset.localhost") ||
		normalized.startsWith("tauri://") ||
		normalized.startsWith("blob:") ||
		normalized.startsWith("data:")
	) {
		return normalized;
	}
	const assetUrl = convertFileSrc(normalized);
	return assetUrl
		.replace(/^asset:\/\/localhost\/?/, "http://asset.localhost/")
		.replace(/^http:\/\/localhost\/?/, "http://asset.localhost/");
}

interface AnimationState {
	isBlinking: boolean;
	blinkProgress: number;
	timeSinceLastBlink: number;
	nextBlinkTime: number;
	nextSaccadeAfter: number;
	fixationTarget: Vector3;
	timeSinceLastSaccade: number;
}

function createAnimationState(): AnimationState {
	return {
		isBlinking: false,
		blinkProgress: 0,
		timeSinceLastBlink: 0,
		nextBlinkTime: randomBlinkInterval(),
		nextSaccadeAfter: -1,
		fixationTarget: new Vector3(),
		timeSinceLastSaccade: 0,
	};
}

function updateBlink(
	vrm: VRM,
	delta: number,
	state: AnimationState,
	blinkName: string,
) {
	if (!vrm.expressionManager) return;

	state.timeSinceLastBlink += delta;

	if (!state.isBlinking && state.timeSinceLastBlink >= state.nextBlinkTime) {
		state.isBlinking = true;
		state.blinkProgress = 0;
	}

	if (state.isBlinking) {
		state.blinkProgress += delta / BLINK_DURATION;
		const blinkValue = Math.sin(Math.PI * state.blinkProgress);
		vrm.expressionManager.setValue(blinkName, blinkValue);

		if (state.blinkProgress >= 1) {
			state.isBlinking = false;
			state.timeSinceLastBlink = 0;
			vrm.expressionManager.setValue(blinkName, 0);
			state.nextBlinkTime = randomBlinkInterval();
		}
	}
}

function updateSaccade(vrm: VRM, delta: number, state: AnimationState) {
	if (!vrm.expressionManager || !vrm.lookAt) return;

	if (state.timeSinceLastSaccade >= state.nextSaccadeAfter) {
		state.fixationTarget.set(
			LOOK_AT_TARGET.x + randFloat(-0.25, 0.25),
			LOOK_AT_TARGET.y + randFloat(-0.25, 0.25),
			LOOK_AT_TARGET.z,
		);
		state.timeSinceLastSaccade = 0;
		state.nextSaccadeAfter = randomSaccadeInterval() / 1000;
	}

	if (!vrm.lookAt.target) {
		vrm.lookAt.target = new Object3D();
	}

	vrm.lookAt.target.position.lerp(state.fixationTarget, 1);
	vrm.lookAt.update(delta);

	state.timeSinceLastSaccade += delta;
}

// Background is now handled by the app-level video/image layer — canvas is transparent.

export function AvatarCanvas() {
	const containerRef = useRef<HTMLDivElement>(null);
	const debugRef = useRef<HTMLDivElement>(null);
	const modelPath = useAvatarStore((s) => s.modelPath);
	const isLoaded = useAvatarStore((s) => s.isLoaded);
	const animationPath = useAvatarStore((s) => s.animationPath);
	const setLoaded = useAvatarStore((s) => s.setLoaded);
	const setLoadProgress = useAvatarStore((s) => s.setLoadProgress);
	const [loadError, setLoadError] = useState("");
	const [loadStage, setLoadStage] = useState("idle");

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let disposed = false;
		let frameId = 0;
		const clock = new Clock();
		const animState = createAnimationState();
		let vrm: VRM | null = null;
		const createdObjectUrls: string[] = [];
		let mixer: AnimationMixer | null = null;
		let emotionCtrl: ReturnType<typeof createEmotionController> | null = null;
		let mouthCtrl: ReturnType<typeof createMouthController> | null = null;
		let blinkExprName = "blink";

		// Renderer
		const renderer = new WebGLRenderer({ antialias: true, alpha: true });
		renderer.setPixelRatio(window.devicePixelRatio);
		renderer.setSize(container.clientWidth, container.clientHeight);
		container.appendChild(renderer.domElement);
		// Prevent WebView2 context menu so right-click drag (pan) reaches OrbitControls
		renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

		// Scene — transparent background (background video/image is handled by the app layer)
		const scene = new Scene();

		// Lighting — required for VRM MToon/PBR materials
		const ambientLight = new AmbientLight(0xffffff, 0.7);
		scene.add(ambientLight);

		const directionalLight = new DirectionalLight(0xffffff, 0.8);
		directionalLight.position.set(0.5, 1.0, 0.5).normalize();
		scene.add(directionalLight);

		// Camera — FOV 50 gives enough horizontal room to prevent edge-clipping during orbit.
		const camera = new PerspectiveCamera(
			50,
			container.clientWidth / container.clientHeight,
			0.1,
			100,
		);

		// OrbitControls
		const controls = new OrbitControls(camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.1;
		controls.enablePan = false; // pan via ✥ button only
		controls.enableZoom = true;
		controls.minDistance = 0.1;
		controls.maxDistance = 10;
		controls.maxPolarAngle = Math.PI * 0.85; // prevent upside-down flip
		controls.minPolarAngle = 0.1;
		// Left-click = rotate, Right-click = pan
		controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };

		_cameraActions.rotate = (dx, dy) => {
			const offset = camera.position.clone().sub(controls.target);
			const spherical = new Spherical();
			spherical.setFromVector3(offset);
			spherical.theta -= dx * 0.005;
			spherical.phi = Math.max(
				0.1,
				Math.min(Math.PI * 0.85, spherical.phi - dy * 0.005),
			);
			camera.position.setFromSpherical(spherical).add(controls.target);
			camera.lookAt(controls.target);
			controls.update();
		};
		let lastModelCenter: Vector3 | null = null;

		_cameraActions.pan = (dx, dy) => {
			// Pan in camera-local XY plane (speed scales with distance to target)
			const dist = camera.position.distanceTo(controls.target);
			const panSpeed = dist * 0.001;
			const right = new Vector3()
				.crossVectors(
					camera.position.clone().sub(controls.target).normalize(),
					camera.up,
				)
				.normalize();
			const panOffset = new Vector3();
			panOffset.addScaledVector(right, -dx * panSpeed);
			panOffset.addScaledVector(camera.up, dy * panSpeed);
			controls.target.add(panOffset);
			camera.position.add(panOffset);
			controls.update();
		};
		_cameraActions.reset = () => {
			camera.position.set(
				DEFAULT_CAMERA.position.x,
				DEFAULT_CAMERA.position.y,
				DEFAULT_CAMERA.position.z,
			);
			// Use actual hips world position so pivot is correct after reset
			let resetTarget = new Vector3(
				DEFAULT_CAMERA.target.x,
				DEFAULT_CAMERA.target.y,
				DEFAULT_CAMERA.target.z,
			);
			if (lastModelCenter) {
				resetTarget = lastModelCenter.clone();
			}
			controls.target.copy(resetTarget);
			controls.update();
			clearSavedCamera();
		};
		_cameraActions.save = () => {
			saveCameraState(camera, controls.target);
		};

		// Set initial camera position immediately
		const savedCam = loadCameraState();
		if (savedCam) {
			camera.position.set(savedCam.px, savedCam.py, savedCam.pz);
			controls.target.set(savedCam.tx, savedCam.ty, savedCam.tz);
			Logger.info("AvatarCanvas", "Camera restored from saved state");
		} else {
			camera.position.set(
				DEFAULT_CAMERA.position.x,
				DEFAULT_CAMERA.position.y,
				DEFAULT_CAMERA.position.z,
			);
			controls.target.set(
				DEFAULT_CAMERA.target.x,
				DEFAULT_CAMERA.target.y,
				DEFAULT_CAMERA.target.z,
			);
			Logger.info("AvatarCanvas", "Camera set to default position");
		}
		controls.update();

		// Save camera on control change
		let saveTimeout: ReturnType<typeof setTimeout> | null = null;
		controls.addEventListener("change", () => {
			if (saveTimeout) clearTimeout(saveTimeout);
			saveTimeout = setTimeout(() => {
				saveCameraState(camera, controls.target);
			}, 500);
		});

		// Render loop — capped at 30 fps to free main thread
		const FRAME_MS = 1000 / 30;
		let lastRenderTime = 0;
		function tick(now: number) {
			if (disposed) return;
			frameId = requestAnimationFrame(tick);
			if (now - lastRenderTime < FRAME_MS) return;
			lastRenderTime = now;

			const delta = Math.min(clock.getDelta(), MAX_DELTA);

			controls.update();

			if (mixer) {
				mixer.update(delta);
			}

			if (vrm) {
				vrm.humanoid?.update();
				updateBlink(vrm, delta, animState, blinkExprName);
				updateSaccade(vrm, delta, animState);
				emotionCtrl?.update(delta);
				mouthCtrl?.update(delta);
				vrm.expressionManager?.update();
				vrm.springBoneManager?.update(delta);
			}

			renderer.render(scene, camera);

			// Debug: show camera position
			if (debugRef.current) {
				const p = camera.position;
				const t = controls.target;
				debugRef.current.textContent =
					`pos: ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}\n` +
					`tgt: ${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)}`;
			}
		}

		async function init() {
			let stage = "init";
			let localReadError = "";
			try {
				setLoadError("");
				setLoaded(false);
				setLoadStage(stage);
				// Convert absolute file paths for custom VRM models
				const normalizedModelPath = normalizeLocalPath(modelPath);
				const vrmUrl = resolveAssetUrl(normalizedModelPath);
				let localVrmBytes: Uint8Array | null = null;
				let resourcePath = "";
				if (
					isAbsoluteLocalFilePath(normalizedModelPath) &&
					!normalizedModelPath.startsWith("/assets/") &&
					!normalizedModelPath.startsWith("/avatars/")
				) {
					try {
						stage = "read-local-binary";
						setLoadStage(stage);
						// Rust returns base64 to avoid JSON number-array OOM (14-26 MB VRM → ~200 MB JS heap).
						const b64 = await invoke<string>("read_local_binary", {
							path: normalizedModelPath,
							allowedBase: getAdkPath() ?? "",
						});
						const raw = atob(b64);
						const buf = new Uint8Array(raw.length);
						for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
						localVrmBytes = buf;
						const slash = Math.max(
							normalizedModelPath.lastIndexOf("/"),
							normalizedModelPath.lastIndexOf("\\"),
						);
						if (slash > 0) {
							resourcePath = resolveAssetUrl(
								normalizedModelPath.slice(0, slash + 1),
							);
						}
					} catch (err) {
						localReadError = String(err);
						Logger.warn("AvatarCanvas", "Failed to read local VRM file", {
							error: String(err),
							path: normalizedModelPath,
						});
					}
				}
				Logger.info("AvatarCanvas", "Loading VRM model", { modelPath, vrmUrl });

				const result = localVrmBytes
					? await (() => {
							stage = "load-local-vrm";
							setLoadStage(stage);
							const localVrmBuffer = new ArrayBuffer(localVrmBytes.byteLength);
							new Uint8Array(localVrmBuffer).set(localVrmBytes);
							return loadVrmFromArrayBuffer(
								localVrmBuffer,
								{
									scene,
									lookAt: true,
								},
								resourcePath,
							);
						})()
					: await (() => {
							stage = "load-url-vrm";
							setLoadStage(stage);
							return loadVrm(vrmUrl, {
								scene,
								lookAt: true,
								onProgress: (progress) => {
									if (progress.lengthComputable) {
										setLoadProgress(progress.loaded / progress.total);
									}
								},
							});
						})();

				if (disposed || !result) {
					if (!result) Logger.error("AvatarCanvas", "Failed to load VRM model");
					return;
				}

				vrm = result._vrm;

				// Use modelCenter (bounding-box chest level, computed by VRM loader).
				// Always save so reset() can restore it; only adjust camera on first load.
				lastModelCenter = result.modelCenter.clone();
				if (!savedCam) {
					const diff = result.modelCenter.clone().sub(controls.target);
					camera.position.add(diff);
					controls.target.copy(result.modelCenter);
					controls.update();
				}

				emotionCtrl = createEmotionController(vrm);
				mouthCtrl = createMouthController(vrm);

				// Resolve blink expression name for VRM 0.0/1.0 compat
				if (vrm.expressionManager) {
					const resolve = buildExpressionResolver(
						vrm.expressionManager.expressionMap,
					);
					blinkExprName = resolve("blink") ?? "blink";
					const available = Object.keys(vrm.expressionManager.expressionMap);
					Logger.info("AvatarCanvas", "VRM expressions available", {
						count: available.length,
						names: available.join(", "),
						blinkResolved: blinkExprName,
					});
				}

				Logger.info("AvatarCanvas", "VRM model loaded", {
					center: `${result.modelCenter.x.toFixed(2)},${result.modelCenter.y.toFixed(2)},${result.modelCenter.z.toFixed(2)}`,
				});

				stage = "vrm-loaded";
				setLoadStage(stage);
				setLoaded(true);
				try {
					stage = "load-idle-animation";
					setLoadStage(stage);
					const vrmAnimation = await loadVRMAnimation(animationPath);
					if (disposed || !vrmAnimation) return;

					const clip = clipFromVRMAnimation(vrm, vrmAnimation);
					if (clip) {
						reAnchorRootPositionTrack(clip, vrm);
						mixer = new AnimationMixer(vrm.scene);
						const action = mixer.clipAction(clip);
						action.setLoop(LoopRepeat, Number.POSITIVE_INFINITY);
						action.play();
						Logger.info("AvatarCanvas", "Idle animation started");
					}
					stage = "ready";
					setLoadStage(stage);
				} catch (animationErr) {
					Logger.warn("AvatarCanvas", "Idle animation load failed", {
						error: String(animationErr),
						animationPath,
					});
				}
			} catch (err) {
				setLoadError(
					`${stage}: ${String(err)}${localReadError ? ` | local-read: ${localReadError}` : ""}`,
				);
				setLoadStage(`error:${stage}`);
				setLoaded(false);
				Logger.error("AvatarCanvas", "VRM initialization failed", {
					error: String(err),
					modelPath,
				});
			}
		}

		// Subscribe to isSpeaking changes for lip sync
		let prevSpeaking = false;
		const unsubSpeaking = useAvatarStore.subscribe((state) => {
			if (state.isSpeaking !== prevSpeaking) {
				prevSpeaking = state.isSpeaking;
				mouthCtrl?.setSpeaking(state.isSpeaking);
			}
		});

		// Subscribe to currentEmotion changes for avatar expression
		let prevEmotion = "neutral";
		const unsubEmotion = useAvatarStore.subscribe((state) => {
			if (state.currentEmotion !== prevEmotion) {
				prevEmotion = state.currentEmotion;
				emotionCtrl?.setEmotion(state.currentEmotion);
			}
		});

		init();
		clock.start();
		frameId = requestAnimationFrame(tick);

		function onResize() {
			if (disposed || !container) return;
			const w = container.clientWidth;
			const h = container.clientHeight;
			if (w === 0 || h === 0) return;
			renderer.setSize(w, h);
			camera.aspect = w / h;
			camera.updateProjectionMatrix();
		}
		const ro = new ResizeObserver(onResize);
		ro.observe(container);

		return () => {
			disposed = true;
			ro.disconnect();
			cancelAnimationFrame(frameId);
			unsubSpeaking();
			unsubEmotion();
			mouthCtrl?.stop();
			if (saveTimeout) clearTimeout(saveTimeout);
			// Save camera position on unmount
			saveCameraState(camera, controls.target);
			_cameraActions.rotate = () => {};
			_cameraActions.pan = () => {};
			_cameraActions.reset = () => {};
			_cameraActions.save = () => {};
			controls.dispose();
			renderer.dispose();
			for (const url of createdObjectUrls) {
				URL.revokeObjectURL(url);
			}
			if (container.contains(renderer.domElement)) {
				container.removeChild(renderer.domElement);
			}
			Logger.debug("AvatarCanvas", "Disposed");
		};
	}, [modelPath, animationPath, setLoaded, setLoadProgress]);

	return (
		<div
			ref={containerRef}
			data-avatar-loaded={isLoaded ? "true" : "false"}
			data-avatar-model-path={modelPath}
			data-avatar-load-error={loadError}
			data-avatar-load-stage={loadStage}
			style={{ width: "100%", height: "100%", position: "relative" }}
		>
			<div
				ref={debugRef}
				style={{
					position: "absolute",
					bottom: 4,
					left: 4,
					fontSize: 9,
					fontFamily: "monospace",
					color: "rgba(255,255,255,0.5)",
					whiteSpace: "pre",
					pointerEvents: "none",
					zIndex: 1,
				}}
			/>
		</div>
	);
}
