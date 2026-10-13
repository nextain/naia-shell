// `en.ts` 와 영어 런타임 보조 표의 키를 합친 타입이다. 키의 정본은 로케일
// 파일 열넷이고, 새 Ollama 문구는 엔트리 번들 크기를 지키려고 별도 청크다.
export type TranslationKey =
	| keyof typeof import("./en").default
	| keyof typeof import("./ollama-en").default;
