#!/usr/bin/env node
import { readFileSync } from "node:fs";

const vrmPath = process.argv[2];
if (!vrmPath) {
	console.error("Usage: node packages/shell/scripts/inspect-naia-vrm.mjs <avatar.vrm>");
	process.exit(2);
}

const requiredBones = [
	"hips",
	"spine",
	"chest",
	"neck",
	"head",
	"leftUpperArm",
	"leftLowerArm",
	"leftHand",
	"rightUpperArm",
	"rightLowerArm",
	"rightHand",
	"leftUpperLeg",
	"leftLowerLeg",
	"leftFoot",
	"rightUpperLeg",
	"rightLowerLeg",
	"rightFoot",
];

const requiredExpressions = [
	"happy",
	"angry",
	"sad",
	"relaxed",
	"surprised",
	"neutral",
	"aa",
	"ih",
	"ou",
	"ee",
	"oh",
	"blink",
	"blinkLeft",
	"blinkRight",
];

function readGlbJson(path) {
	const buf = readFileSync(path);
	if (buf.readUInt32LE(0) !== 0x46546c67) {
		throw new Error("Not a GLB/VRM file");
	}
	const jsonLength = buf.readUInt32LE(12);
	const jsonType = buf.readUInt32LE(16);
	if (jsonType !== 0x4e4f534a) {
		throw new Error("First GLB chunk is not JSON");
	}
	return JSON.parse(buf.subarray(20, 20 + jsonLength).toString("utf8"));
}

const json = readGlbJson(vrmPath);
const vrm = json.extensions?.VRMC_vrm;
if (!vrm) {
	throw new Error("VRMC_vrm extension missing");
}

const nodeNames = json.nodes?.map((node) => node.name ?? "") ?? [];
const nodeByIndex = new Map(nodeNames.map((name, index) => [index, name]));
const humanBones = vrm.humanoid?.humanBones ?? {};
const preset = vrm.expressions?.preset ?? {};
const custom = vrm.expressions?.custom ?? {};

const missingBones = requiredBones.filter((bone) => humanBones[bone]?.node === undefined);
const mappedBones = Object.fromEntries(
	requiredBones.map((bone) => [bone, nodeByIndex.get(humanBones[bone]?.node) ?? null]),
);
const swappedLimbBones = Object.entries(mappedBones)
	.filter(([bone, node]) => node && bone.startsWith("left") && node.startsWith("right")
		|| node && bone.startsWith("right") && node.startsWith("left"))
	.map(([bone, node]) => `${bone}->${node}`);

const expressionSummary = Object.fromEntries(
	requiredExpressions.map((name) => [
		name,
		Array.isArray(preset[name]?.morphTargetBinds) ? preset[name].morphTargetBinds.length : 0,
	]),
);
const missingExpressionBinds = requiredExpressions.filter((name) => expressionSummary[name] < 1);

const mouthNode = json.nodes?.findIndex((node) => node.name === "NaiaMouthShapeKeys") ?? -1;
const hasThink = Array.isArray(custom.think?.morphTargetBinds) && custom.think.morphTargetBinds.length > 0;
const hasSpringBone = Boolean(json.extensions?.VRMC_springBone);
const hasLookAt = Boolean(vrm.lookAt);

const ok =
	missingBones.length === 0
	&& swappedLimbBones.length === 0
	&& missingExpressionBinds.length === 0
	&& mouthNode >= 0
	&& hasThink
	&& hasSpringBone
	&& hasLookAt;

const report = {
	vrm: vrmPath,
	ok,
	specVersion: vrm.specVersion ?? null,
	mouthNode: mouthNode >= 0 ? mouthNode : null,
	missingBones,
	swappedLimbBones,
	mappedBones,
	missingExpressionBinds,
	expressionSummary,
	hasThink,
	hasSpringBone,
	hasLookAt,
};

console.log(JSON.stringify(report, null, 2));
process.exit(ok ? 0 : 1);
