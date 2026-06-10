import type { VRM } from "@pixiv/three-vrm";
import { useEffect, useRef } from "react";
import {
	AmbientLight,
	AnimationMixer,
	CanvasTexture,
	Clock,
	DirectionalLight,
	LoopRepeat,
	Object3D,
	PerspectiveCamera,
	Scene,
	Vector3,
	WebGLRenderer,
} from "three";
import { Logger } from "../lib/logger";
import {
	clipFromVRMAnimation,
	loadVRMAnimation,
	reAnchorRootPositionTrack,
} from "../lib/vrm/animation";
import { loadVrm } from "../lib/vrm/core";

const BLINK_DURATION = 0.2;
const MIN_BLINK_INTERVAL = 2;
const MAX_BLINK_INTERVAL = 5;

function randomBlinkInterval() {
	return (
		Math.random() * (MAX_BLINK_INTERVAL - MIN_BLINK_INTERVAL) +
		MIN_BLINK_INTERVAL
	);
}

/**
 * Lightweight VRM preview — renders a single model with blink animation.
 * Used in onboarding character selection.
 */
export function VrmPreview({ modelPath }: { modelPath: string }) {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let disposed = false;
		let frameId = 0;
		const clock = new Clock();
		let vrm: VRM | null = null;
		let mixer: AnimationMixer | null = null;
		let blinkName = "blink";
		let blinkProgress = 0;
		let isBlinking = false;
		let timeSinceLastBlink = 0;
		let nextBlinkTime = randomBlinkInterval();

		const renderer = new WebGLRenderer({ antialias: true, alpha: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setSize(container.clientWidth, container.clientHeight);
		container.appendChild(renderer.domElement);

		const scene = new Scene();

		// Gradient background
		const bgCanvas = document.createElement("canvas");
		bgCanvas.width = 2;
		bgCanvas.height = 256;
		const ctx = bgCanvas.getContext("2d");
		if (ctx) {
			const grad = ctx.createLinearGradient(0, 0, 0, 256);
			grad.addColorStop(0, "#1a1412");
			grad.addColorStop(0.5, "#2b2220");
			grad.addColorStop(1, "#0F172A");
			ctx.fillStyle = grad;
			ctx.fillRect(0, 0, 2, 256);
		}
		scene.background = new CanvasTexture(bgCanvas);

		const ambientLight = new AmbientLight(0xffffff, 0.7);
		scene.add(ambientLight);
		const dirLight = new DirectionalLight(0xffffff, 0.8);
		dirLight.position.set(0.5, 1.0, 0.5).normalize();
		scene.add(dirLight);

		const camera = new PerspectiveCamera(
			30,
			container.clientWidth / container.clientHeight,
			0.1,
			100,
		);
		// Bust shot: wider view showing upper chest
		camera.position.set(0.0, 1.35, -1.2);
		camera.lookAt(new Vector3(0, 1.3, 0));

		function tick() {
			if (disposed) return;
			frameId = requestAnimationFrame(tick);
			const delta = Math.min(clock.getDelta(), 0.05);

			if (mixer) {
				mixer.update(delta);
			}

			if (vrm) {
				vrm.humanoid?.update();
			}

			if (vrm?.expressionManager) {
				// Blink animation
				timeSinceLastBlink += delta;
				if (!isBlinking && timeSinceLastBlink >= nextBlinkTime) {
					isBlinking = true;
					blinkProgress = 0;
				}
				if (isBlinking) {
					blinkProgress += delta / BLINK_DURATION;
					const val = Math.sin(Math.PI * blinkProgress);
					vrm.expressionManager.setValue(blinkName, val);
					if (blinkProgress >= 1) {
						isBlinking = false;
						timeSinceLastBlink = 0;
						vrm.expressionManager.setValue(blinkName, 0);
						nextBlinkTime = randomBlinkInterval();
					}
				}
				vrm.expressionManager.update();
				vrm.springBoneManager?.update(delta);
			}

			renderer.render(scene, camera);
		}

		async function init() {
			const result = await loadVrm(modelPath, { scene, lookAt: true });
			if (disposed || !result) return;
			vrm = result._vrm;

			// Adjust camera to look at the character's head
			if (vrm.humanoid) {
				const head = vrm.humanoid.getNormalizedBoneNode("head");
				if (head) {
					const headPos = new Vector3();
					head.getWorldPosition(headPos);
					// Bust shot framing relative to the head height
					camera.position.set(0.0, headPos.y + 0.05, -1.2);
					camera.lookAt(new Vector3(0, headPos.y - 0.05, 0));
				}
			}

			// Resolve blink expression
			if (vrm.expressionManager) {
				const names = Object.keys(vrm.expressionManager.expressionMap);
				if (names.includes("blink")) {
					blinkName = "blink";
				} else if (names.includes("Blink")) {
					blinkName = "Blink";
				}
			}

			// Set lookAt target
			if (vrm.lookAt) {
				if (!vrm.lookAt.target) {
					vrm.lookAt.target = new Object3D();
				}
				vrm.lookAt.target.position.set(0, 1.4, -1);
			}

			// Load idle animation to avoid T-pose
			const vrmAnimation = await loadVRMAnimation("/animations/idle_loop.vrma");
			if (!disposed && vrmAnimation) {
				const clip = clipFromVRMAnimation(vrm, vrmAnimation);
				if (clip) {
					reAnchorRootPositionTrack(clip, vrm);
					mixer = new AnimationMixer(vrm.scene);
					const action = mixer.clipAction(clip);
					action.setLoop(LoopRepeat, Number.POSITIVE_INFINITY);
					action.play();
				}
			}

			Logger.debug("VrmPreview", "Model loaded", { modelPath });
		}

		init();
		clock.start();
		frameId = requestAnimationFrame(tick);

		return () => {
			disposed = true;
			cancelAnimationFrame(frameId);
			renderer.dispose();
			if (container.contains(renderer.domElement)) {
				container.removeChild(renderer.domElement);
			}
		};
	}, [modelPath]);

	return <div ref={containerRef} className="vrm-preview" />;
}
