/**
 * 손 포즈 — idle 애니메이션이 손가락을 펼친 채로 두면 어색해서, 매 프레임
 * humanoid.update() 직전에 4지(검지~새끼) + 엄지를 살짝 구부려 "살짝 주먹"을 만든다.
 *
 * three-vrm 정규화 본의 손가락 curl 축/부호는 모델마다 다를 수 있어 amount/sign 을
 * 노출한다(시각 확인 후 튜닝). 기본 = 약한 curl(0.55rad 안팎, 자연스러운 이완 주먹).
 */
import type { VRM } from "@pixiv/three-vrm";

type Curl = { bone: string; axis: "x" | "y" | "z"; amount: number };

// 검지~새끼: proximal+intermediate 를 X 축으로 구부림(손가락 hinge). distal 은 약하게.
// 엄지: 다른 평면이라 Z 로 살짝 모음. 좌/우 부호는 hand 별로 반대.
function fingerCurls(side: "left" | "right", k: number): Curl[] {
	const s = side === "left" ? 1 : -1; // 좌우 대칭 부호(필요 시 반전)
	const fingers = ["Index", "Middle", "Ring", "Little"];
	const curls: Curl[] = [];
	for (const f of fingers) {
		curls.push({ bone: `${side}${f}Proximal`, axis: "z", amount: -s * 0.6 * k });
		curls.push({
			bone: `${side}${f}Intermediate`,
			axis: "z",
			amount: -s * 0.7 * k,
		});
		curls.push({ bone: `${side}${f}Distal`, axis: "z", amount: -s * 0.4 * k });
	}
	// 엄지: 살짝 안으로
	curls.push({ bone: `${side}ThumbProximal`, axis: "y", amount: s * 0.3 * k });
	curls.push({ bone: `${side}ThumbDistal`, axis: "z", amount: -s * 0.25 * k });
	return curls;
}

/**
 * 매 프레임 호출(humanoid.update() 직전). `strength`(0~1)로 주먹 강도.
 * idle 애니메이션이 손가락 트랙을 포함하지 않는 한 이 설정이 유지된다.
 */
export function applyRelaxedFists(vrm: VRM, strength = 1): void {
	const humanoid = vrm.humanoid;
	if (!humanoid) return;
	const curls = [...fingerCurls("left", strength), ...fingerCurls("right", strength)];
	for (const c of curls) {
		// biome-ignore lint/suspicious/noExplicitAny: VRMHumanBoneName 문자열 인덱싱
		const node = humanoid.getNormalizedBoneNode(c.bone as any);
		if (node) node.rotation[c.axis] = c.amount;
	}
}
