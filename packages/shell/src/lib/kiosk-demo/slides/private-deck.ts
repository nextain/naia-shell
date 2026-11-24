// 비공개 장(숫자가 든 장)의 낭독 원고. 저장소에는 없고, 시연판 웹 빌드 때만
// vite.config.ts 의 kioskPrivateSlidesPlugin 이 scripts/web-kiosk-private-slides.mjs 로
// 확인한 원고를 이 가상 모듈에 넣는다. 그 밖의 빌드와 시험에서는 빈 목록이다.
import privateDeck from "virtual:kiosk-private-slides";
import privateManifest from "./ir-deck-private.manifest.json";

export interface KioskPrivateIrSlide {
	page: number;
	image: string;
	title: string;
	script: string;
}

export function getKioskPrivateIrSlides(): KioskPrivateIrSlide[] {
	return privateDeck.slides;
}

/** 저장소에 기록된 비공개 장 그림 파일 이름. */
export const KIOSK_PRIVATE_IR_SLIDE_IMAGES: readonly string[] =
	privateManifest.slides.map((slide) => slide.image);

export const KIOSK_PRIVATE_IR_SLIDE_PAGES: readonly number[] =
	privateManifest.slides.map((slide) => slide.page);
