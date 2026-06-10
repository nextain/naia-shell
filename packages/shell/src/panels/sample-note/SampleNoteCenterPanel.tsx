import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Logger } from "../../lib/logger";
import type { PanelCenterProps } from "../../lib/panel-registry";

/**
 * SampleNoteCenterPanel — minimal installable panel demonstrating AI interaction.
 *
 * Exposes two skills to Naia:
 *   - skill_note_read  → returns current note content
 *   - skill_note_write → updates note content
 *
 * This panel is NOT built-in, so it can be deleted from ModeBar.
 * Install path: ~/.naia/panels/sample-note/ (Phase 4)
 */
export function SampleNoteCenterPanel({ naia }: PanelCenterProps) {
	const [content, setContent] = useState("");
	// Ref so tool handlers always access latest content without stale closure
	const contentRef = useRef(content);
	contentRef.current = content;

	// Register tool handlers on mount; clean up on unmount
	useEffect(() => {
		Logger.debug("SampleNote", "Registering tool handlers");

		const unsubRead = naia.onToolCall("skill_note_read", () => {
			Logger.debug("SampleNote", "skill_note_read called");
			return contentRef.current || "(empty)";
		});

		const unsubWrite = naia.onToolCall("skill_note_write", (args) => {
			const newContent = String(args.content ?? "");
			Logger.info("SampleNote", "skill_note_write called", {
				length: newContent.length,
			});
			setContent(newContent);
			contentRef.current = newContent;
			naia.pushContext({ type: "sample-note", data: { content: newContent } });
			return "Note updated";
		});

		return () => {
			Logger.debug("SampleNote", "Unregistering tool handlers");
			unsubRead();
			unsubWrite();
		};
	}, [naia]);

	function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
		const newContent = e.target.value;
		setContent(newContent);
		naia.pushContext({ type: "sample-note", data: { content: newContent } });
	}

	return (
		<div className="sample-note-panel">
			<div className="sample-note-panel__header">
				<span className="sample-note-panel__title">📝 Sample Note</span>
				<span className="sample-note-panel__hint">
					Naia에게 이 메모를 읽거나 수정하도록 요청해보세요
				</span>
			</div>
			<textarea
				className="sample-note-panel__editor"
				value={content}
				onChange={handleChange}
				placeholder="메모를 입력하거나 Naia에게 써달라고 하세요..."
			/>
		</div>
	);
}
