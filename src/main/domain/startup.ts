// domain/startup — F0 (contract §B.1 StartupMessage)
// 발신 조건 규칙: NotifyConfig/CredsUpdate = config 존재 필요; AuthUpdate = naiaKey 필요.
// 고정 순서(C-R2): AuthUpdate → NotifyConfig → CredsUpdate.

export type StartupMessageKind = "AuthUpdate" | "NotifyConfig" | "CredsUpdate";

export interface StartupMessage {
  readonly kind: StartupMessageKind;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * initAuth 가 보낼 메시지를 고정 순서로 산출 (순수 규칙).
 * @param configPresent loadConfigWithSecrets non-null 여부 (config 조건)
 * @param naiaKeyPresent naiaKey 존재 여부 (auth 조건)
 */
export function startupMessagesToSend(
  configPresent: boolean,
  naiaKeyPresent: boolean,
): StartupMessageKind[] {
  const out: StartupMessageKind[] = [];
  if (naiaKeyPresent) out.push("AuthUpdate"); // ① App.tsx 539 (무키=skip)
  if (configPresent) out.push("NotifyConfig"); // ② 550
  if (configPresent) out.push("CredsUpdate"); // ③ 566
  return out;
}
