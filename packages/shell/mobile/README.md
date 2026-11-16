# Naia Mobile App Packaging Guide (Capacitor 7 — iOS & Android)

본 디렉터리(`packages/shell/mobile/`)는 `naia-shell`의 단일 웹 코어(`vite build --mode web` 산출물)를 데스크톱 `src-tauri` 및 루트 `pnpm-lock.yaml`과 **충돌 없이 100% 독립적으로** Apple App Store(`iOS`) 및 Google Play(`Android`) 네이티브 앱(`appId: "land.naia.mobile"`)으로 패킹하기 위한 정준 스캐폴드입니다.

런타임 브릿지 로직은 외부 npm 강제 의존성 없는 순수 TypeScript 모듈 `packages/shell/src/lib/mobile/`에 구현되어 있습니다.

---

## 1. 빠른 시작 (Quick Start)

```bash
# 1) 모바일 래퍼 전용 의존성 초기화 (루트 pnpm-lock.yaml 비오염 격리 실행)
cd packages/shell/mobile
cp package.template.json package.json
npm install

# 2) naia-shell 웹 모드 번들(../dist) 빌드
npm run build:web

# 3) 네이티브 프로젝트 생성 (최초 1회)
npx cap add ios
npx cap add android

# 4) 권한 조각 병합 후 웹 번들 동기화
#    - iOS: ios/Info.plist.fragment.xml 항목을 ios/App/App/Info.plist 에 병합
#    - Android: android/AndroidManifest.fragment.xml 항목을 android/app/src/main/AndroidManifest.xml 에 병합
npx cap sync
```

---

## 2. 핵심 런타임 브릿지 (`packages/shell/src/lib/mobile/`)

1. **플랫폼·Safe-Area·iOS NVA 크로마키 감지 (`platform.ts`)**
   - `detectMobileShellPlatform()`: `"ios-capacitor"` | `"android-capacitor"` | `"mobile-web"` | `"desktop-tauri"` | `"desktop-web"` 식별.
   - `shouldForceMp4ChromaKeyNva()`: iOS `WKWebView`가 VP9 알파 `.webm` 디코딩을 차단하거나 알파 채널을 소실하는 문제를 감지하여, **H.264/HEVC 크로마키 `.mp4` + `nva-chromakey-gl.ts` WebGL2 셰이더** 경로를 강제 선택.
   - `applyMobileSafeAreaCssVars()`: 노치/다이나믹 아일랜드/안드로이드 제스처 바 및 가상 키보드 높이(`--naia-safe-area-*`, `--naia-keyboard-inset-bottom`, `--naia-vh`) 자동 동기화.
   - `subscribeMobileDeepLinks()`: `naia://` 커스텀 스킴 및 `https://www.naia.land/s/*` 유니버설/앱 링크 수신.

2. **모바일 오디오·마이크 세션 (`audio-session.ts`)**
   - `unlockMobileAudioOnGesture()`: 첫 사용자 터치 시 `AudioContext.resume()` 및 `1-sample` 무음 버퍼 재생으로 iOS `AVAudioSession` 하드웨어 출력 잠금 즉시 해제.
   - `bindMobileAudioLifecycleSync()`: 백그라운드 진입 시 WebGL2/VRM 립싱크 렌더링 일시정지(`gpusKillClient` 강제종료 예방) 및 포그라운드 복귀 시 `AudioContext` 재개·립싱크 클럭 즉시 재동기화.
   - `checkMobileMicrophonePermission()` / `requestMobileMicrophonePermission()`: 네이티브 플러그인 우선 점검 및 `getUserMedia` 프로브 후 즉시 트랙 해제(`track.stop()`).

3. **인앱결제(StoreKit 2 / Play Billing) 및 스토어 심사 리젝 방지 가드 (`iap-bridge.ts`)**
   - `shouldHideExternalWebCheckout()` / `guardExternalCheckoutUrl()`: App Store 심사 지침 `3.1.1` 및 Google Play 결제 정책에 따라 네이티브 앱 내부에서 외부 웹 결제(`Stripe`, `Toss`, `naia.land/pricing` 등) 링크를 원천 차단.
   - `MobileIapGatewayBridge`:
     - Apple `GET /v1/billing/apple/account-token` (`appAccountToken` UUID 바인딩) 및 `POST /v1/billing/apple/transactions` (`{ signed_transaction }` JWS 검증 → `StoreOrder` 크레딧/구독 지급).
     - Google `GET /v1/billing/google/account-token` 및 `POST /v1/billing/google/transactions` (`{ package_name, product_id, purchase_token }` 검증).
     - 게이트웨이 `StoreOrder` 커밋(`"granted"` / `"already_granted"`) 완료 **직후에만** 네이티브 `finishTransaction`을 호출하여 모바일 네트워크 순단 시 결제 유실을 방지.
