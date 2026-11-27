import { type AppDescriptor, appRegistry } from "../../lib/app-registry";
import { t } from "../../lib/i18n";
import { isKioskDemo } from "../../lib/kiosk-demo/flag";
import { TAB_SKILL_DESCRIPTORS } from "../../lib/tab-skills";
import { useAppStore } from "../../stores/app";
import { SlidesCenterArea } from "./SlidesCenterArea";
import slidesIconSvg from "./package-public/icon.svg?raw";

/** Shell descriptor used when registering the bundled kiosk app. */
export const NAIA_SLIDES_DESCRIPTOR: AppDescriptor = {
	id: "land.naia.slides",
	get name() {
		return t("g1b.slidesAppName");
	},
	icon: "▣",
	// 앱 꾸러미와 같은 아이콘(대표님 11/13 "슬라이드는 이걸로").
	iconSvg: slidesIconSvg,
	center: SlidesCenterArea,
	tools: [
		{
			name: "skill_slide_presenter",
			description:
				"Control the active Slides app. It supports starting from the selected 1-based page, focused presentation mode (slides with the Naia avatar), collapsible presenter notes, full-screen viewing, and MP4 recording of the Naia window saved to the app sandbox then opened in Workspace. When the user asks to present, call start. Use question before answering a presentation question so automatic advance pauses. Actions: start, pause, resume, stop, next, previous, goto, question, status, get_context.",
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: [
							"start",
							"pause",
							"resume",
							"stop",
							"next",
							"previous",
							"goto",
							"question",
							"status",
							"get_context",
						],
					},
					page: {
						type: "number",
						description: "1-based slide number for goto",
					},
				},
				required: ["action"],
			},
			tier: 0,
		},
		...TAB_SKILL_DESCRIPTORS,
	],
};

export function syncKioskSlidesAppRegistration(): void {
	if (!isKioskDemo()) return;
	if (appRegistry.get(NAIA_SLIDES_DESCRIPTOR.id)) return;
	appRegistry.register(NAIA_SLIDES_DESCRIPTOR);
	useAppStore.getState().bumpAppListVersion();
}

syncKioskSlidesAppRegistration();
