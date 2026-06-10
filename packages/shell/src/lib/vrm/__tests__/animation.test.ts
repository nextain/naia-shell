import { type Vector3, VectorKeyframeTrack } from "three";
import { AnimationClip } from "three";
import { describe, expect, it } from "vitest";
import { clipFromVRMAnimation, reAnchorRootPositionTrack } from "../animation";

describe("clipFromVRMAnimation", () => {
	it("returns undefined when vrm is undefined", () => {
		const result = clipFromVRMAnimation(undefined, undefined);
		expect(result).toBeUndefined();
	});

	it("returns undefined when animation is undefined", () => {
		const mockVrm = { expressionManager: null } as never;
		const result = clipFromVRMAnimation(mockVrm, undefined);
		expect(result).toBeUndefined();
	});
});

describe("reAnchorRootPositionTrack", () => {
	it("does nothing when hips node is missing", () => {
		const clip = new AnimationClip("test", 1, []);
		const mockVrm = {
			humanoid: {
				getNormalizedBoneNode: () => null,
			},
		} as never;

		// Should not throw
		reAnchorRootPositionTrack(clip, mockVrm);
		expect(clip.tracks).toHaveLength(0);
	});

	it("adjusts position tracks by hip delta", () => {
		const hipNodeName = "hips";
		const trackValues = new Float32Array([1, 2, 3, 4, 5, 6]);
		const track = new VectorKeyframeTrack(
			`${hipNodeName}.position`,
			[0, 1],
			trackValues,
		);
		const clip = new AnimationClip("test", 1, [track]);

		const mockHipNode = {
			name: hipNodeName,
			updateMatrixWorld: () => {},
			getWorldPosition: (target: Vector3) => {
				target.set(1, 2, 3);
				return target;
			},
		};

		const mockVrm = {
			humanoid: {
				getNormalizedBoneNode: (name: string) =>
					name === "hips" ? mockHipNode : null,
			},
		} as never;

		reAnchorRootPositionTrack(clip, mockVrm);

		// First frame hip pos = (1,2,3), default hip pos = (1,2,3)
		// Delta = (0,0,0), so values should be unchanged
		expect(track.values[0]).toBe(1);
		expect(track.values[1]).toBe(2);
		expect(track.values[2]).toBe(3);
	});

	it("subtracts non-zero delta from all position tracks", () => {
		const hipNodeName = "hips";
		const trackValues = new Float32Array([2, 4, 6, 5, 7, 9]);
		const track = new VectorKeyframeTrack(
			`${hipNodeName}.position`,
			[0, 1],
			trackValues,
		);
		const clip = new AnimationClip("test", 1, [track]);

		const mockHipNode = {
			name: hipNodeName,
			updateMatrixWorld: () => {},
			getWorldPosition: (target: Vector3) => {
				// Default hip at origin
				target.set(0, 0, 0);
				return target;
			},
		};

		const mockVrm = {
			humanoid: {
				getNormalizedBoneNode: (name: string) =>
					name === "hips" ? mockHipNode : null,
			},
		} as never;

		reAnchorRootPositionTrack(clip, mockVrm);

		// First frame hip = (2,4,6), default = (0,0,0)
		// Delta = (2,4,6)
		// Values after: (2-2, 4-4, 6-6, 5-2, 7-4, 9-6) = (0, 0, 0, 3, 3, 3)
		expect(track.values[0]).toBeCloseTo(0);
		expect(track.values[1]).toBeCloseTo(0);
		expect(track.values[2]).toBeCloseTo(0);
		expect(track.values[3]).toBeCloseTo(3);
		expect(track.values[4]).toBeCloseTo(3);
		expect(track.values[5]).toBeCloseTo(3);
	});
});
