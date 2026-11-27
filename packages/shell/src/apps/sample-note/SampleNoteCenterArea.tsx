import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import { Logger } from "../../lib/logger";
import type { AppCenterProps } from "../../lib/app-registry";

/**
 * SampleNoteCenterArea — minimal installable app demonstrating AI interaction.
 *
 * Exposes two skills to Naia:
 *   - skill_note_read  → returns current note content
 *   - skill_note_write → updates note content
 *
 * This app is NOT built-in, so it can be deleted from AppBar.
 * Install path: ~/.naia/apps/sample-note/ (Phase 4)
 */
export function SampleNoteCenterArea({ naia }: AppCenterProps) {
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
		<div className="sample-note-app">
			<div className="sample-note-app__header">
				<span className="sample-note-app__title">📝 Sample Note</span>
				<span className="sample-note-app__hint">
					{t("g1b.noteHint")}
				</span>
			</div>
			<textarea
				className="sample-note-app__editor"
				value={content}
				onChange={handleChange}
				placeholder={t("g1b.notePlaceholder")}
			/>
		</div>
	);
}
