# Contract: web-runtime-web-bgm-music

Source: `packages/shell/src/lib/web-runtime/web-bgm-music.ts`

웹판(브라우저) 음악 앱 로컬 탭(R10, UC-WEB-BGM-LOCAL-IMPORT)의 저장소. 사용자가 고른 음악 파일을
OPFS `naia-adk/naia-settings/bgm-musics` 에 넣고, 목록·읽기·지우기를 제공한다.

```ts
export const WEB_BGM_MUSIC_DIR
export const WEB_BGM_MAX_BYTES
export type WebBgmImportErrorCode
export class WebBgmImportError
export function isWebBgmAudioFile
export function webBgmAudioMime
export function isWebBgmImportSupported
export function webBgmFileName
export async function listWebBgmMusicPaths
export async function importWebBgmMusic
export async function readWebBgmMusicBlob
export async function removeWebBgmMusic
```
