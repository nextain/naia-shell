# Cafe Lua Tarot app: content and sound credits

- **Tarot illustrations and card meanings:** Cafe Lua Tarot v2.0, from Cafe Lua (`cafelua.com`), source commit `3461f7d`. Licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). The app packages the 22 Major Arcana WebP illustrations and the fallback card meaning data. Card image paths and gallery order follow Cafe Lua's `galleryData.ts` current-major deck.
- **Stories:** Fable's *Alpha's First Year* and Astra's *Days Yet Unwritten*, from `src/data/gallery/tarotStories.ts` at the same source commit, under CC BY-NC-SA 4.0. The two editions are mapped in Major Arcana order as Cafe Lua's `galleryData.ts` does. Author labels retained in the app: Claude Fable 5.1 and GPT-6 Astra.
- **Background music:** `sounds/taro-bgm.mp3`, copied unchanged from Cafe Lua's `public/sounds/taro-bgm.mp3` per the user's instruction. The Cafe Lua repository README does not identify a separate license for this audio file; the app does not label it CC BY-NC-SA.
- **Card-turn cue:** no external sound file or recording. It is synthesized at runtime by `audio.ts` with Web Audio oscillator and gain nodes. The source code is part of this MIT-licensed Shell repository; there is no separate recorded audio asset to license.

Changes for this app: the card images, gallery order, stories, and card meanings are packaged locally; the cards are drawn on-device; the tarot reader is Naia using the user's configured default model.
