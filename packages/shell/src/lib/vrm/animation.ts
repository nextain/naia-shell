import type { VRMAnimation } from "@pixiv/three-vrm-animation";
import type { VRMCore } from "@pixiv/three-vrm-core";
import type { AnimationClip } from "three";

import { createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import { Vector3, VectorKeyframeTrack } from "three";

import { Logger } from "../logger";
import { useVRMLoader } from "./loader";

interface GLTFUserdata extends Record<string, unknown> {
	vrmAnimations: VRMAnimation[];
}

export async function loadVRMAnimation(
	url: string,
): Promise<VRMAnimation | undefined> {
	const loader = useVRMLoader();
	const gltf = await loader.loadAsync(url);

	const userData = gltf.userData as GLTFUserdata;
	if (!userData.vrmAnimations || userData.vrmAnimations.length === 0) {
		Logger.warn("VRMAnimation", "No VRM animations found in .vrma file", {
			url,
		});
		return;
	}

	return userData.vrmAnimations[0];
}

export function clipFromVRMAnimation(
	vrm?: VRMCore,
	animation?: VRMAnimation,
): AnimationClip | undefined {
	if (!vrm) {
		Logger.warn("VRMAnimation", "No VRM found for clip creation");
		return;
	}
	if (!animation) {
		return;
	}

	return createVRMAnimationClip(animation, vrm);
}

export function reAnchorRootPositionTrack(clip: AnimationClip, _vrm: VRMCore) {
	const hipNode = _vrm.humanoid?.getNormalizedBoneNode("hips");
	if (!hipNode) {
		Logger.warn("VRMAnimation", "No hips node found in VRM model");
		return;
	}
	hipNode.updateMatrixWorld(true);
	const defaultHipPos = new Vector3();
	hipNode.getWorldPosition(defaultHipPos);

	const hipsTrack = clip.tracks.find(
		(track) =>
			track instanceof VectorKeyframeTrack &&
			track.name === `${hipNode.name}.position`,
	);
	if (!(hipsTrack instanceof VectorKeyframeTrack)) {
		Logger.warn("VRMAnimation", "No Hips.position VectorKeyframeTrack found");
		return;
	}

	const animeHipPos = new Vector3(
		hipsTrack.values[0],
		hipsTrack.values[1],
		hipsTrack.values[2],
	);
	const animeDelta = new Vector3().subVectors(animeHipPos, defaultHipPos);

	for (const track of clip.tracks) {
		if (
			track.name.endsWith(".position") &&
			track instanceof VectorKeyframeTrack
		) {
			for (let i = 0; i < track.values.length; i += 3) {
				track.values[i] -= animeDelta.x;
				track.values[i + 1] -= animeDelta.y;
				track.values[i + 2] -= animeDelta.z;
			}
		}
	}
}
