# Contract: web-runtime-web-studio-handoff

Source: `packages/shell/src/lib/web-runtime/web-studio-handoff.ts`

스튜디오에서 웹판(브라우저) 셸로 캐릭터 카드를 넘겨받아 적용한다. 캐릭터(아바타)와 목소리를 함께 바꾼다
(R16, UC-WEB-STUDIO-VOICE-APPLY). 스튜디오 목소리 이름은 게이트웨이 `/v1/audio/speech` 형식으로 맞춘다.

```ts
export const STUDIO_PENDING_CHARACTER_STORAGE_KEY
export function decodeBase64UrlToBytes
export interface StudioCardAvatarHint
export function normalizeStudioVoiceId
export function extractStudioCardExtensions
export async function applyNormalizedCharacterCardToWebShell
export interface ConsumeStudioHandoffOptions
export interface ConsumeStudioHandoffResult
export async function consumePendingStudioCharacterCard
```
