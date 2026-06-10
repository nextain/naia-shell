/**
 * Server prosody tags → chat-display text (naia-omni).
 *
 * The voice server keeps inline tags like `[sigh]` / `[laughing]` in its
 * `response.audio_transcript.delta` so the synthesis path can render their
 * prosody. For the *chat row* those raw tags read badly, so we map the
 * emotionally-meaningful ones to an emoji and strip the purely functional
 * ones (breath/pause/etc.). "필요에 따라" — only clear emotions become an
 * emoji; unknown or functional tags are removed so the text stays clean.
 *
 * Only naia-omni emits these tags; other providers' transcripts pass through
 * unchanged (no bracketed tags to match).
 */

/** Tag name (lowercase, no brackets) → emoji. Absent = strip silently. */
const EMOTION_EMOJI: Record<string, string> = {
	laughing: "😄",
	laugh: "😄",
	laughter: "😄",
	chuckle: "😊",
	giggle: "😊",
	sigh: "😮‍💨",
	exhale: "😮‍💨",
	gasp: "😲",
	cry: "😢",
	sob: "😢",
	whisper: "🤫",
	cheer: "🥳",
	shout: "📢",
	yawn: "🥱",
	// breath / inhale / pause / hesitation / cough / sneeze / sniff / hum /
	// moan: functional — stripped (no emoji) for a clean chat row.
};

// Capture the tag plus an optional single trailing space: a *stripped* tag
// takes that space with it (no orphan/leading space), while a streamed
// transcript chunk that merely *starts* with a space keeps it (word boundary).
const TAG_RE = /\[([a-z][a-z_-]{1,15})\]( ?)/g;

/**
 * Replace prosody tags with emoji (known) or remove them (unknown/functional).
 * No trim() — `response.text.delta` arrives in streamed chunks, so leading
 * spaces are meaningful word boundaries and must survive.
 */
export function emotionTagsToChatText(text: string): string {
	if (!text) return text;
	return text
		.replace(TAG_RE, (_m, tag: string, space: string) =>
			EMOTION_EMOJI[tag] ? EMOTION_EMOJI[tag] + space : "",
		)
		.replace(/[ \t]{2,}/g, " ") // collapse runs left by a stripped tag
		.replace(/\s+([.,!?。、！？])/g, "$1"); // " ." -> "." after a strip
}
