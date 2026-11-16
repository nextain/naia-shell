import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
	EditorView,
	highlightActiveLine,
	keymap,
	lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { Logger } from "../../lib/logger";

const TAG = "CodeMirrorEditor";

export interface CodeMirrorEditorProps {
	value: string;
	ariaLabel: string;
	onChange: (nextValue: string) => void;
	onRunShortcut?: () => void;
}

export function CodeMirrorEditor({
	value,
	ariaLabel,
	onChange,
	onRunShortcut,
}: CodeMirrorEditorProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(onChange);
	const onRunRef = useRef(onRunShortcut);
	const [plainMode, setPlainMode] = useState(false);

	onChangeRef.current = onChange;
	onRunRef.current = onRunShortcut;

	useEffect(() => {
		if (plainMode || !hostRef.current) return;
		Logger.debug(TAG, "mounting CodeMirror 6 JavaScript editor");

		const state = EditorState.create({
			doc: value,
			extensions: [
				lineNumbers(),
				highlightActiveLine(),
				history(),
				javascript(),
				oneDark,
				keymap.of([
					{
						key: "Mod-Enter",
						run: () => {
							onRunRef.current?.();
							return true;
						},
					},
					...defaultKeymap,
					...historyKeymap,
				]),
				EditorView.contentAttributes.of({
					"aria-label": ariaLabel,
					"data-testid": "blackjack-cm-content",
				}),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) {
						onChangeRef.current(update.state.doc.toString());
					}
				}),
			],
		});

		const view = new EditorView({
			state,
			parent: hostRef.current,
		});
		viewRef.current = view;

		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, [plainMode, ariaLabel]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const currentDoc = view.state.doc.toString();
		if (currentDoc !== value) {
			view.dispatch({
				changes: { from: 0, to: currentDoc.length, insert: value },
			});
		}
	}, [value]);

	return (
		<div className="bj-cm-wrapper">
			<div className="bj-cm-modebar">
				<span className="bj-cm-lang-pill">JavaScript · ES2022</span>
				<button
					type="button"
					className="bj-btn bj-btn--subtle bj-btn--xs"
					data-testid="blackjack-editor-mode-toggle"
					data-usage-event="blackjack-editor.ctrl-1.click" onClick={() => setPlainMode((prev) => !prev)}
				>
					{plainMode ? "CodeMirror 6" : "Plain Text"}
				</button>
			</div>
			{plainMode ? (
				<textarea
					className="bj-plain-editor"
					aria-label={ariaLabel}
					data-testid="blackjack-plain-textarea"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={(e) => {
						if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
							e.preventDefault();
							onRunShortcut?.();
						}
					}}
					spellCheck={false}
				/>
			) : (
				<div
					ref={hostRef}
					className="bj-cm-host"
					data-testid="blackjack-codemirror-host"
				/>
			)}
		</div>
	);
}
