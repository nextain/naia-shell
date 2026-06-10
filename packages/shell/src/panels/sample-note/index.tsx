import { panelRegistry } from "../../lib/panel-registry";
import { SampleNoteCenterPanel } from "./SampleNoteCenterPanel";

panelRegistry.register({
	id: "sample-note",
	name: "Sample Note",
	names: { ko: "샘플 메모", en: "Sample Note" },
	icon: "📝",
	center: SampleNoteCenterPanel,
	tools: [
		{
			name: "skill_note_read",
			description: "Read the current note content",
			parameters: { type: "object", properties: {} },
			tier: 0,
		},
		{
			name: "skill_note_write",
			description: "Write or update the note content",
			parameters: {
				type: "object",
				properties: {
					content: {
						type: "string",
						description: "The note content to write",
					},
				},
				required: ["content"],
			},
			tier: 1,
		},
	],
});
