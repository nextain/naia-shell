# 셸 사용 통계 이름표 대조 (2026-11-04)

정본: https://ax.nextain.io/d/eae97c . 기준 main 702b2c70, 0.2.6 작업.

결정: 다운로드→실행은 총량만(설치 연결 없음), 첫 실행 동의와 설정 끄기, Application Insights 한 곳(Google 전달 보류), Steam도 같은 이름표.

## 설계와 차이

| 항목 | 구현 계약 / 이유 |
|---|---|
| 세부 누름 보완 | 아래 452개 네이티브 JSX 누름/선택/제출/문맥 메뉴 위치. 코드에 고정 data-usage-event를 선언한다. 동적 텍스트·앱 이름·주소를 이름표로 만들지 않는다. 반복 목록은 같은 동작 이름으로 합산한다. |
| 이름 안정성 | 화면.요소.동작; 요소 뒤 번호는 같은 화면의 중복 요소를 구별하는 영구 식별자. 코드 행이 바뀌어도 바꾸지 않는다. 새 요소는 새 이름을 배정한다. |
| 입력 | 자유 입력·슬라이더 값은 수집하지 않는다. 세부 선택값은 보내지 않고, 정본 의미 사건에 필요한 choice는 고정 허용값만 센다. 소개 단계·로그인 결과 등은 아래 의미 사건으로 별도 기록한다. |
| 개인정보 최소화 | 정본 4·7절의 event_id·순번·시각·로그인 시도 번호는 중복·순서·성공 분모 보존을 위해 유지. 그 밖에는 설치 난수·이름표·고정 화면·고정 choice·앱 판·OS 종류·배포 채널만 허용한다. |
| 저장 | 동의는 앱 사용자 WebView 저장소에, 통계 번호·원자적 순번은 별도 키. ADK와 분리. Web Locks/BroadcastChannel 미지원 또는 저장 실패 시 수집 중단(경합 순번을 만들지 않음). 저장소 복제는 같은 설치 번호가 되는 정본의 한계를 유지하며 기기 지문을 추가하지 않는다. |
| 대기열 | 메모리 최대 50, 오래된 것 폐기·유실 수 로컬 계수, 발생 후 10분 이내 1회 재시도. 오프라인/종료 폐기, 끄면 모든 창 예약/대기열 삭제·요청 취소 시도. 이미 서버 도달한 자료는 취소 보장 불가. |
| 미관측 | 동의 전·초기 i18n/렌더 실패 전·별도 브라우저 WebView 내부와 외부 설치 앱 내부 클릭은 관측하지 않는다. 임의 사이트에 주입하지 않음. 셸 소유 React 제어만 아래 목록 대상. |
| 출시 관문 | 자원·연결 문자열·수신 제한/비용/권한/보유/아동·개인정보 검토·14개 언어 방침 공지·실수신 집계 검증은 별도 승인 후. 연결 문자열 없는 현재 빌드는 전송 0건. 배포 금지. |

## 의미 사건 (정본 부록 대조)

| 이름 | 실제 위치 / 시점 |
|---|---|
| shell.start.observed / shell.launch.start | UsageConsentGate, ADK 설정 전 동의 후 초기화. 첫 관측 순번 1, 재실행은 launch만 |
| intro.screen.view | OnboardingWizard step effect: welcome/agentName/userName/speechStyle/character/background/provider/voice/complete |
| intro.navigation.click / intro.welcome.link / intro.speech.select / intro.character.select / intro.background.select / intro.provider.choose / intro.voice.select / intro.voice.preview | 아래 onboarding-wizard 목록의 실제 제어 위치에 고정 이름 부여. 상세 위치 이름과 정본 묶음 이름을 함께 기록하며 선택은 고정 choice로만 구별 |
| intro.finish.saved | OnboardingWizard handleComplete 저장 완료 후; manual/start 별도 화면 이름 |
| login.browser.start / login.credentials.saved / login.attempt.fail / login.credentials.restored | 소개·설정의 실제 시작/저장/복원 경로. 로그인 시도 난수(계정 연결 없음), 5분 만료, 중복 결과 차단 |
| home.menu.open / home.shortcut.click | AppBar 누름 목록 + app.screen.view 실제 앱 변경; 외부 앱 ID는 other로 정규화 |
| settings.tab.open | SettingsTab activeSettingsTab effect; 세부 제어는 아래 settings-tab 목록 |
| settings.option.click / settings.voice.click / settings.save.click / settings.update.check | 아래 settings-tab 및 분리 설정 컴포넌트의 실제 동작별 이름으로 세분. 저장 성공을 클릭으로 추정하지 않음 |
| chat.message.send / chat.voice.toggle / chat.voice.cancel / chat.session.new | ChatArea 해당 핸들러 진입(내용 없음), DOM 누름과 별도 사건 |
| chat.reply.first | ChatArea 실제 응답 텍스트/실시간 음성 응답 경로, 사용자 대화 시도 뒤 설치별 첫 성공만 저장 |
| privacy.choice.select | 허용/다시 켜기 후만 기록, 거절/끄기는 전송하지 않음 |

## 전체 누름 위치

| 이름표 | 화면 | 제어/핸들러 | 소스 (기준판 행) |
|---|---|---|---|
| `adk-setup-screen.set-mode-1.click` | adk-setup-screen | button / set-mode / onClick | packages/shell/src/components/AdkSetupScreen.tsx:403 |
| `adk-setup-screen.set-mode-2.click` | adk-setup-screen | button / set-mode / onClick | packages/shell/src/components/AdkSetupScreen.tsx:417 |
| `adk-setup-screen.set-mode-3.click` | adk-setup-screen | button / set-mode / onClick | packages/shell/src/components/AdkSetupScreen.tsx:456 |
| `adk-setup-screen.set-path-4.click` | adk-setup-screen | button / set-path / onClick | packages/shell/src/components/AdkSetupScreen.tsx:487 |
| `adk-setup-screen.handle-new-start-5.click` | adk-setup-screen | button / handle-new-start / onClick | packages/shell/src/components/AdkSetupScreen.tsx:505 |
| `adk-setup-screen.set-mode-6.click` | adk-setup-screen | button / set-mode / onClick | packages/shell/src/components/AdkSetupScreen.tsx:523 |
| `adk-setup-screen.handle-new-use-existing-7.click` | adk-setup-screen | button / handle-new-use-existing / onClick | packages/shell/src/components/AdkSetupScreen.tsx:558 |
| `adk-setup-screen.handle-new-recreate-8.click` | adk-setup-screen | button / handle-new-recreate / onClick | packages/shell/src/components/AdkSetupScreen.tsx:573 |
| `adk-setup-screen.set-mode-9.click` | adk-setup-screen | button / set-mode / onClick | packages/shell/src/components/AdkSetupScreen.tsx:599 |
| `adk-setup-screen.handle-browse-10.click` | adk-setup-screen | button / handle-browse / onClick | packages/shell/src/components/AdkSetupScreen.tsx:634 |
| `adk-setup-screen.handle-load-confirm-11.click` | adk-setup-screen | button / handle-load-confirm / onClick | packages/shell/src/components/AdkSetupScreen.tsx:646 |
| `adk-setup-screen.set-mode-12.click` | adk-setup-screen | button / set-mode / onClick | packages/shell/src/components/AdkSetupScreen.tsx:662 |
| `adk-setup-screen.handle-browse-13.click` | adk-setup-screen | button / handle-browse / onClick | packages/shell/src/components/AdkSetupScreen.tsx:690 |
| `adk-setup-screen.handle-naia-login-14.click` | adk-setup-screen | button / handle-naia-login / onClick | packages/shell/src/components/AdkSetupScreen.tsx:704 |
| `agents-tab.button-1.click` | agents-tab | button / button / onClick | packages/shell/src/components/AgentsTab.tsx:60 |
| `agents-tab.handle-delete-session-2.click` | agents-tab | button / handle-delete-session / onClick | packages/shell/src/components/AgentsTab.tsx:93 |
| `ai-control-bar.toggle-ai-interference-enabled-1.click` | ai-control-bar | button / toggle-ai-interference-enabled / onClick | packages/shell/src/components/AiControlBar.tsx:95 |
| `ai-control-bar.toggle-tts-enabled-2.click` | ai-control-bar | button / toggle-tts-enabled / onClick | packages/shell/src/components/AiControlBar.tsx:110 |
| `ai-control-bar.toggle-proactive-3.click` | ai-control-bar | button / toggle-proactive / onClick | packages/shell/src/components/AiControlBar.tsx:131 |
| `ai-control-bar.button-4.click` | ai-control-bar | button / button / onClick | packages/shell/src/components/AiControlBar.tsx:232 |
| `ai-control-bar.button-5.click` | ai-control-bar | button / button / onClick | packages/shell/src/components/AiControlBar.tsx:246 |
| `ai-control-bar.button-6.click` | ai-control-bar | button / button / onClick | packages/shell/src/components/AiControlBar.tsx:260 |
| `announcement-banner.handle-link-1.click` | announcement-banner | button / handle-link / onClick | packages/shell/src/components/AnnouncementBanner.tsx:69 |
| `announcement-banner.handle-dismiss-2.click` | announcement-banner | button / handle-dismiss / onClick | packages/shell/src/components/AnnouncementBanner.tsx:77 |
| `announcement-banner.handle-dismiss-all-3.click` | announcement-banner | button / handle-dismiss-all / onClick | packages/shell/src/components/AnnouncementBanner.tsx:87 |
| `app-bar.handle-tab-bar-context-menu-1.context` | app-bar | div / handle-tab-bar-context-menu / onContextMenu | packages/shell/src/components/AppBar.tsx:364 |
| `app-bar.set-active-app-2.click` | app-bar | button / set-active-app / onClick | packages/shell/src/components/AppBar.tsx:366 |
| `app-bar.set-active-app-3.click` | app-bar | button / set-active-app / onClick | packages/shell/src/components/AppBar.tsx:375 |
| `app-bar.set-active-app-4.click` | app-bar | button / set-active-app / onClick | packages/shell/src/components/AppBar.tsx:384 |
| `app-bar.open-app-store-5.click` | app-bar | button / open-app-store / onClick | packages/shell/src/components/AppBar.tsx:395 |
| `app-bar.set-active-app-6.click` | app-bar | button / set-active-app / onClick | packages/shell/src/components/AppBar.tsx:413 |
| `app-bar.handle-remove-app-7.click` | app-bar | button / handle-remove-app / onClick | packages/shell/src/components/AppBar.tsx:433 |
| `app-bar.open-icon-editor-8.click` | app-bar | button / open-icon-editor / onClick | packages/shell/src/components/AppBar.tsx:459 |
| `app-bar.stop-propagation-9.click` | app-bar | button / stop-propagation / onClick | packages/shell/src/components/AppBar.tsx:498 |
| `app-bar.handle-ctx-remove-shortcut-10.click` | app-bar | button / handle-ctx-remove-shortcut / onClick | packages/shell/src/components/AppBar.tsx:522 |
| `app-bar.handle-ctx-remove-app-11.click` | app-bar | button / handle-ctx-remove-app / onClick | packages/shell/src/components/AppBar.tsx:531 |
| `app-bar.set-add-url-dialog-12.click` | app-bar | div / set-add-url-dialog / onClick | packages/shell/src/components/AppBar.tsx:543 |
| `app-bar.stop-propagation-13.click` | app-bar | div / stop-propagation / onClick | packages/shell/src/components/AppBar.tsx:547 |
| `app-bar.set-add-url-dialog-14.click` | app-bar | button / set-add-url-dialog / onClick | packages/shell/src/components/AppBar.tsx:551 |
| `app-bar.set-add-url-dialog-15.click` | app-bar | button / set-add-url-dialog / onClick | packages/shell/src/components/AppBar.tsx:565 |
| `app-bar.set-add-url-dialog-16.click` | app-bar | button / set-add-url-dialog / onClick | packages/shell/src/components/AppBar.tsx:579 |
| `app-bar.set-add-url-dialog-17.click` | app-bar | button / set-add-url-dialog / onClick | packages/shell/src/components/AppBar.tsx:594 |
| `app-bar.set-url-input-dialog-18.click` | app-bar | div / set-url-input-dialog / onClick | packages/shell/src/components/AppBar.tsx:620 |
| `app-bar.stop-propagation-19.click` | app-bar | form / stop-propagation / onClick | packages/shell/src/components/AppBar.tsx:624 |
| `app-bar.set-url-input-dialog-20.click` | app-bar | button / set-url-input-dialog / onClick | packages/shell/src/components/AppBar.tsx:641 |
| `app-bar.set-add-url-dialog-21.click` | app-bar | button / set-add-url-dialog / onClick | packages/shell/src/components/AppBar.tsx:659 |
| `app-bar.set-edit-mode-22.click` | app-bar | button / set-edit-mode / onClick | packages/shell/src/components/AppBar.tsx:668 |
| `app-bar.set-icon-editing-23.click` | app-bar | div / set-icon-editing / onClick | packages/shell/src/components/AppBar.tsx:682 |
| `app-bar.stop-propagation-24.click` | app-bar | form / stop-propagation / onClick | packages/shell/src/components/AppBar.tsx:686 |
| `app-bar.set-icon-editing-25.click` | app-bar | button / set-icon-editing / onClick | packages/shell/src/components/AppBar.tsx:709 |
| `app-bar.set-active-app-26.click` | app-bar | button / set-active-app / onClick | packages/shell/src/components/AppBar.tsx:731 |
| `app-install-dialog.on-close-1.click` | app-install-dialog | div / on-close / onClick | packages/shell/src/components/AppInstallDialog.tsx:125 |
| `app-install-dialog.stop-propagation-2.click` | app-install-dialog | div / stop-propagation / onClick | packages/shell/src/components/AppInstallDialog.tsx:130 |
| `app-install-dialog.on-close-3.click` | app-install-dialog | button / on-close / onClick | packages/shell/src/components/AppInstallDialog.tsx:137 |
| `app-install-dialog.handle-install-4.click` | app-install-dialog | button / handle-install / onClick | packages/shell/src/components/AppInstallDialog.tsx:193 |
| `app-install-dialog.set-mode-5.click` | app-install-dialog | button / set-mode / onClick | packages/shell/src/components/AppInstallDialog.tsx:201 |
| `app-install-dialog.set-mode-6.click` | app-install-dialog | button / set-mode / onClick | packages/shell/src/components/AppInstallDialog.tsx:208 |
| `app-install-dialog.on-close-7.click` | app-install-dialog | button / on-close / onClick | packages/shell/src/components/AppInstallDialog.tsx:216 |
| `app-install-dialog.handle-install-8.click` | app-install-dialog | button / handle-install / onClick | packages/shell/src/components/AppInstallDialog.tsx:224 |
| `app-main-content.set-chat-mode-1.click` | app-main-content | button / set-chat-mode / onClick | packages/shell/src/components/AppMainContent.tsx:289 |
| `app-main-content.set-chat-mode-2.click` | app-main-content | button / set-chat-mode / onClick | packages/shell/src/components/AppMainContent.tsx:298 |
| `app-main-content.toggle-rail-collapsed-3.click` | app-main-content | button / toggle-rail-collapsed / onClick | packages/shell/src/components/AppMainContent.tsx:323 |
| `app-switcher.set-active-app-1.click` | app-switcher | button / set-active-app / onClick | packages/shell/src/components/AppSwitcher.tsx:13 |
| `at-mention-popover.handle-select-1.click` | at-mention-popover | div / handle-select / onClick | packages/shell/src/components/AtMentionPopover.tsx:239 |
| `bgm-player.set-app-expanded-1.click` | bgm-player | span / set-app-expanded / onClick | packages/shell/src/components/BgmPlayer.tsx:2263 |
| `bgm-player.button-2.click` | bgm-player | button / button / onClick | packages/shell/src/components/BgmPlayer.tsx:2273 |
| `bgm-player.toggle-play-3.click` | bgm-player | button / toggle-play / onClick | packages/shell/src/components/BgmPlayer.tsx:2281 |
| `bgm-player.button-4.click` | bgm-player | button / button / onClick | packages/shell/src/components/BgmPlayer.tsx:2290 |
| `bgm-player.toggle-current-like-5.click` | bgm-player | button / toggle-current-like / onClick | packages/shell/src/components/BgmPlayer.tsx:2298 |
| `bgm-player.button-6.click` | bgm-player | button / button / onClick | packages/shell/src/components/BgmPlayer.tsx:2307 |
| `bgm-player.set-app-expanded-7.click` | bgm-player | button / set-app-expanded / onClick | packages/shell/src/components/BgmPlayer.tsx:2318 |
| `bgm-player.set-app-tab-8.click` | bgm-player | button / set-app-tab / onClick | packages/shell/src/components/BgmPlayer.tsx:2366 |
| `bgm-player.set-app-tab-9.click` | bgm-player | button / set-app-tab / onClick | packages/shell/src/components/BgmPlayer.tsx:2373 |
| `bgm-player.set-app-tab-10.click` | bgm-player | button / set-app-tab / onClick | packages/shell/src/components/BgmPlayer.tsx:2380 |
| `bgm-player.set-app-expanded-11.click` | bgm-player | button / set-app-expanded / onClick | packages/shell/src/components/BgmPlayer.tsx:2388 |
| `bgm-player.select-12.select` | bgm-player | select / select / onChange | packages/shell/src/components/BgmPlayer.tsx:2400 |
| `bgm-player.button-13.click` | bgm-player | button / button / onClick | packages/shell/src/components/BgmPlayer.tsx:2406 |
| `bgm-player.button-14.click` | bgm-player | button / button / onClick | packages/shell/src/components/BgmPlayer.tsx:2407 |
| `bgm-player.set-show-youtube-background-15.select` | bgm-player | input / set-show-youtube-background / onChange | packages/shell/src/components/BgmPlayer.tsx:2414 |
| `bgm-player.set-yt-view-16.click` | bgm-player | button / set-yt-view / onClick | packages/shell/src/components/BgmPlayer.tsx:2424 |
| `bgm-player.set-yt-view-17.click` | bgm-player | button / set-yt-view / onClick | packages/shell/src/components/BgmPlayer.tsx:2431 |
| `bgm-player.set-yt-view-18.click` | bgm-player | button / set-yt-view / onClick | packages/shell/src/components/BgmPlayer.tsx:2438 |
| `bgm-player.button-19.click` | bgm-player | button / button / onClick | packages/shell/src/components/BgmPlayer.tsx:2451 |
| `bgm-player.form-20.submit` | bgm-player | form / form / onSubmit | packages/shell/src/components/BgmPlayer.tsx:2465 |
| `bgm-player.set-new-playlist-name-21.submit` | bgm-player | form / set-new-playlist-name / onSubmit | packages/shell/src/components/BgmPlayer.tsx:2544 |
| `bgm-player.button-22.click` | bgm-player | button / button / onClick | packages/shell/src/components/BgmPlayer.tsx:2571 |
| `bgm-player.remove-track-from-playlist-23.click` | bgm-player | button / remove-track-from-playlist / onClick | packages/shell/src/components/BgmPlayer.tsx:2575 |
| `bgm-player.div-24.click` | bgm-player | div / div / onClick | packages/shell/src/components/BgmPlayer.tsx:2591 |
| `bgm-player.stop-propagation-25.click` | bgm-player | button / stop-propagation / onClick | packages/shell/src/components/BgmPlayer.tsx:2608 |
| `bgm-player.on-play-26.click` | bgm-player | div / on-play / onClick | packages/shell/src/components/BgmPlayer.tsx:2689 |
| `bgm-player.stop-propagation-27.click` | bgm-player | button / stop-propagation / onClick | packages/shell/src/components/BgmPlayer.tsx:2718 |
| `bgm-player.stop-propagation-28.click` | bgm-player | button / stop-propagation / onClick | packages/shell/src/components/BgmPlayer.tsx:2729 |
| `chat-area.on-retry-1.click` | chat-area | button / on-retry / onClick | packages/shell/src/components/ChatArea.tsx:388 |
| `chat-area.handle-tab-change-2.click` | chat-area | button / handle-tab-change / onClick | packages/shell/src/components/ChatArea.tsx:4224 |
| `chat-area.handle-tab-change-3.click` | chat-area | button / handle-tab-change / onClick | packages/shell/src/components/ChatArea.tsx:4237 |
| `chat-area.set-show-cost-dashboard-4.click` | chat-area | button / set-show-cost-dashboard / onClick | packages/shell/src/components/ChatArea.tsx:4255 |
| `chat-area.handle-new-conversation-5.click` | chat-area | button / handle-new-conversation / onClick | packages/shell/src/components/ChatArea.tsx:4266 |
| `chat-area.set-compaction-notice-6.click` | chat-area | button / set-compaction-notice / onClick | packages/shell/src/components/ChatArea.tsx:4338 |
| `chat-area.handle-voice-cancel-7.click` | chat-area | button / handle-voice-cancel / onClick | packages/shell/src/components/ChatArea.tsx:4496 |
| `chat-area.handle-voice-toggle-8.click` | chat-area | button / handle-voice-toggle / onClick | packages/shell/src/components/ChatArea.tsx:4516 |
| `chat-area.handle-cancel-streaming-9.click` | chat-area | button / handle-cancel-streaming / onClick | packages/shell/src/components/ChatArea.tsx:4579 |
| `chat-area.handle-send-10.click` | chat-area | button / handle-send / onClick | packages/shell/src/components/ChatArea.tsx:4588 |
| `chat-area.set-show-no-auth-modal-11.click` | chat-area | div / set-show-no-auth-modal / onClick | packages/shell/src/components/ChatArea.tsx:4600 |
| `chat-area.stop-propagation-12.click` | chat-area | div / stop-propagation / onClick | packages/shell/src/components/ChatArea.tsx:4604 |
| `chat-area.set-show-no-auth-modal-13.click` | chat-area | button / set-show-no-auth-modal / onClick | packages/shell/src/components/ChatArea.tsx:4619 |
| `chat-markdown.open-file-in-workspace-1.click` | chat-markdown | button / open-file-in-workspace / onClick | packages/shell/src/components/ChatMarkdown.tsx:59 |
| `cost-dashboard.open-url-1.click` | cost-dashboard | button / open-url / onClick | packages/shell/src/components/CostDashboard.tsx:232 |
| `deferred-adk-setup-screen.button-1.click` | deferred-adk-setup-screen | button / button / onClick | packages/shell/src/components/DeferredAdkSetupScreen.tsx:44 |
| `deferred-chat-area.button-1.click` | deferred-chat-area | button / button / onClick | packages/shell/src/components/DeferredChatArea.tsx:111 |
| `deferred-onboarding-wizard.button-1.click` | deferred-onboarding-wizard | button / button / onClick | packages/shell/src/components/DeferredOnboardingWizard.tsx:44 |
| `device-pairing-section.set-once-secret-1.click` | device-pairing-section | button / set-once-secret / onClick | packages/shell/src/components/DevicePairingSection.tsx:112 |
| `device-pairing-section.button-2.click` | device-pairing-section | button / button / onClick | packages/shell/src/components/DevicePairingSection.tsx:149 |
| `device-pairing-section.set-once-secret-3.click` | device-pairing-section | button / set-once-secret / onClick | packages/shell/src/components/DevicePairingSection.tsx:162 |
| `device-pairing-section.button-4.click` | device-pairing-section | button / button / onClick | packages/shell/src/components/DevicePairingSection.tsx:176 |
| `device-pairing-section.set-verify-code-5.click` | device-pairing-section | button / set-verify-code / onClick | packages/shell/src/components/DevicePairingSection.tsx:215 |
| `device-pairing-section.button-6.click` | device-pairing-section | button / button / onClick | packages/shell/src/components/DevicePairingSection.tsx:230 |
| `device-pairing-section.set-once-secret-7.click` | device-pairing-section | button / set-once-secret / onClick | packages/shell/src/components/DevicePairingSection.tsx:246 |
| `diagnostics-tab.button-1.click` | diagnostics-tab | button / button / onClick | packages/shell/src/components/DiagnosticsTab.tsx:406 |
| `diagnostics-tab.handle-restart-2.click` | diagnostics-tab | button / handle-restart / onClick | packages/shell/src/components/DiagnosticsTab.tsx:413 |
| `diagnostics-tab.handle-tab-change-3.click` | diagnostics-tab | button / handle-tab-change / onClick | packages/shell/src/components/DiagnosticsTab.tsx:478 |
| `diagnostics-tab.handle-toggle-tailing-4.click` | diagnostics-tab | button / handle-toggle-tailing / onClick | packages/shell/src/components/DiagnosticsTab.tsx:493 |
| `diagnostics-tab.handle-clear-5.click` | diagnostics-tab | button / handle-clear / onClick | packages/shell/src/components/DiagnosticsTab.tsx:507 |
| `diagnostics-tab.handle-open-in-window-6.click` | diagnostics-tab | button / handle-open-in-window / onClick | packages/shell/src/components/DiagnosticsTab.tsx:515 |
| `diagnostics-tab.set-selected-log-7.click` | diagnostics-tab | div / set-selected-log / onClick | packages/shell/src/components/DiagnosticsTab.tsx:561 |
| `diagnostics-tab.set-selected-log-8.click` | diagnostics-tab | div / set-selected-log / onClick | packages/shell/src/components/DiagnosticsTab.tsx:585 |
| `diagnostics-tab.stop-propagation-9.click` | diagnostics-tab | div / stop-propagation / onClick | packages/shell/src/components/DiagnosticsTab.tsx:589 |
| `diagnostics-tab.set-selected-log-10.click` | diagnostics-tab | button / set-selected-log / onClick | packages/shell/src/components/DiagnosticsTab.tsx:607 |
| `history-tab.button-1.click` | history-tab | button / button / onClick | packages/shell/src/components/HistoryTab.tsx:101 |
| `history-tab.handle-load-session-2.click` | history-tab | button / handle-load-session / onClick | packages/shell/src/components/HistoryTab.tsx:121 |
| `history-tab.handle-delete-session-3.click` | history-tab | button / handle-delete-session / onClick | packages/shell/src/components/HistoryTab.tsx:139 |
| `knowledge-graph-overlay.on-close-1.click` | knowledge-graph-overlay | div / on-close / onClick | packages/shell/src/components/KnowledgeGraphOverlay.tsx:73 |
| `knowledge-graph-overlay.stop-propagation-2.click` | knowledge-graph-overlay | div / stop-propagation / onClick | packages/shell/src/components/KnowledgeGraphOverlay.tsx:89 |
| `knowledge-graph-overlay.on-close-3.click` | knowledge-graph-overlay | button / on-close / onClick | packages/shell/src/components/KnowledgeGraphOverlay.tsx:122 |
| `knowledge-graph-overlay.open-source-4.click` | knowledge-graph-overlay | button / open-source / onClick | packages/shell/src/components/KnowledgeGraphOverlay.tsx:192 |
| `knowledge-graph-view.set-mode-1.click` | knowledge-graph-view | button / set-mode / onClick | packages/shell/src/components/KnowledgeGraphView.tsx:220 |
| `knowledge-graph-view.handle-canvas-click-2.click` | knowledge-graph-view | canvas / handle-canvas-click / onClick | packages/shell/src/components/KnowledgeGraphView.tsx:237 |
| `knowledge-settings-tab.handle-remove-1.click` | knowledge-settings-tab | button / handle-remove / onClick | packages/shell/src/components/KnowledgeSettingsTab.tsx:188 |
| `knowledge-settings-tab.handle-add-folder-2.click` | knowledge-settings-tab | button / handle-add-folder / onClick | packages/shell/src/components/KnowledgeSettingsTab.tsx:200 |
| `knowledge-settings-tab.handle-compile-3.click` | knowledge-settings-tab | button / handle-compile / onClick | packages/shell/src/components/KnowledgeSettingsTab.tsx:230 |
| `knowledge-settings-tab.set-graph-open-4.click` | knowledge-settings-tab | button / set-graph-open / onClick | packages/shell/src/components/KnowledgeSettingsTab.tsx:256 |
| `markdown-code-block.set-copied-1.click` | markdown-code-block | button / set-copied / onClick | packages/shell/src/components/MarkdownCodeBlock.tsx:47 |
| `markdown-code-block.set-error-2.click` | markdown-code-block | button / set-error / onClick | packages/shell/src/components/MarkdownCodeBlock.tsx:98 |
| `markdown-code-block.on-open-workspace-3.click` | markdown-code-block | button / on-open-workspace / onClick | packages/shell/src/components/MarkdownCodeBlock.tsx:141 |
| `nva-gesture-actions.on-manual-action-1.click` | nva-gesture-actions | button / on-manual-action / onClick | packages/shell/src/components/NvaGestureActions.tsx:27 |
| `onboarding-wizard.open-url-1.click` | onboarding-wizard | button / open-url / onClick | packages/shell/src/components/OnboardingWizard.tsx:1348 |
| `onboarding-wizard.open-url-2.click` | onboarding-wizard | button / open-url / onClick | packages/shell/src/components/OnboardingWizard.tsx:1359 |
| `onboarding-wizard.open-url-3.click` | onboarding-wizard | button / open-url / onClick | packages/shell/src/components/OnboardingWizard.tsx:1372 |
| `onboarding-wizard.set-speech-style-4.click` | onboarding-wizard | button / set-speech-style / onClick | packages/shell/src/components/OnboardingWizard.tsx:1448 |
| `onboarding-wizard.handle-vrm-select-5.click` | onboarding-wizard | button / handle-vrm-select / onClick | packages/shell/src/components/OnboardingWizard.tsx:1506 |
| `onboarding-wizard.handle-nva-select-6.click` | onboarding-wizard | button / handle-nva-select / onClick | packages/shell/src/components/OnboardingWizard.tsx:1539 |
| `onboarding-wizard.handle-bg-select-7.click` | onboarding-wizard | button / handle-bg-select / onClick | packages/shell/src/components/OnboardingWizard.tsx:1575 |
| `onboarding-wizard.go-next-8.click` | onboarding-wizard | button / go-next / onClick | packages/shell/src/components/OnboardingWizard.tsx:1629 |
| `onboarding-wizard.handle-naia-login-9.click` | onboarding-wizard | button / handle-naia-login / onClick | packages/shell/src/components/OnboardingWizard.tsx:1640 |
| `onboarding-wizard.handle-go-to-settings-10.click` | onboarding-wizard | button / handle-go-to-settings / onClick | packages/shell/src/components/OnboardingWizard.tsx:1663 |
| `onboarding-wizard.go-next-11.click` | onboarding-wizard | button / go-next / onClick | packages/shell/src/components/OnboardingWizard.tsx:1670 |
| `onboarding-wizard.set-tts-enabled-12.click` | onboarding-wizard | button / set-tts-enabled / onClick | packages/shell/src/components/OnboardingWizard.tsx:1693 |
| `onboarding-wizard.set-tts-enabled-13.click` | onboarding-wizard | button / set-tts-enabled / onClick | packages/shell/src/components/OnboardingWizard.tsx:1702 |
| `onboarding-wizard.set-web-voice-uri-14.select` | onboarding-wizard | select / set-web-voice-uri / onChange | packages/shell/src/components/OnboardingWizard.tsx:1714 |
| `onboarding-wizard.button-15.click` | onboarding-wizard | button / button / onClick | packages/shell/src/components/OnboardingWizard.tsx:1725 |
| `onboarding-wizard.toggle-local-voice-16.click` | onboarding-wizard | button / toggle-local-voice / onClick | packages/shell/src/components/OnboardingWizard.tsx:1743 |
| `onboarding-wizard.go-back-17.click` | onboarding-wizard | button / go-back / onClick | packages/shell/src/components/OnboardingWizard.tsx:1807 |
| `onboarding-wizard.handle-complete-18.click` | onboarding-wizard | button / handle-complete / onClick | packages/shell/src/components/OnboardingWizard.tsx:1818 |
| `onboarding-wizard.go-next-19.click` | onboarding-wizard | button / go-next / onClick | packages/shell/src/components/OnboardingWizard.tsx:1836 |
| `permission-modal.button-1.click` | permission-modal | button / button / onClick | packages/shell/src/components/PermissionModal.tsx:68 |
| `permission-modal.button-2.click` | permission-modal | button / button / onClick | packages/shell/src/components/PermissionModal.tsx:75 |
| `permission-modal.button-3.click` | permission-modal | button / button / onClick | packages/shell/src/components/PermissionModal.tsx:82 |
| `proactive-speech-settings-section.toggle-expanded-1.click` | proactive-speech-settings-section | button / toggle-expanded / onClick | packages/shell/src/components/ProactiveSpeechSettingsSection.tsx:38 |
| `proactive-speech-settings-section.select-2.select` | proactive-speech-settings-section | select / select / onChange | packages/shell/src/components/ProactiveSpeechSettingsSection.tsx:101 |
| `proactive-speech-settings-section.input-3.select` | proactive-speech-settings-section | input / input / onChange | packages/shell/src/components/ProactiveSpeechSettingsSection.tsx:160 |
| `proactive-speech-settings-section.input-4.select` | proactive-speech-settings-section | input / input / onChange | packages/shell/src/components/ProactiveSpeechSettingsSection.tsx:169 |
| `proactive-speech-settings-section.set-save-failed-5.click` | proactive-speech-settings-section | button / set-save-failed / onClick | packages/shell/src/components/ProactiveSpeechSettingsSection.tsx:221 |
| `ref-audio-section.on-preview-active-1.click` | ref-audio-section | button / on-preview-active / onClick | packages/shell/src/components/RefAudioSection.tsx:929 |
| `ref-audio-section.set-confirming-remove-2.click` | ref-audio-section | button / set-confirming-remove / onClick | packages/shell/src/components/RefAudioSection.tsx:937 |
| `ref-audio-section.on-remove-3.click` | ref-audio-section | button / on-remove / onClick | packages/shell/src/components/RefAudioSection.tsx:957 |
| `ref-audio-section.set-confirming-remove-4.click` | ref-audio-section | button / set-confirming-remove / onClick | packages/shell/src/components/RefAudioSection.tsx:965 |
| `ref-audio-section.button-5.click` | ref-audio-section | button / button / onClick | packages/shell/src/components/RefAudioSection.tsx:993 |
| `ref-audio-section.button-6.click` | ref-audio-section | button / button / onClick | packages/shell/src/components/RefAudioSection.tsx:1003 |
| `ref-audio-section.on-preview-take-7.click` | ref-audio-section | button / on-preview-take / onClick | packages/shell/src/components/RefAudioSection.tsx:1016 |
| `ref-audio-section.button-8.click` | ref-audio-section | button / button / onClick | packages/shell/src/components/RefAudioSection.tsx:1023 |
| `ref-audio-section.button-9.click` | ref-audio-section | button / button / onClick | packages/shell/src/components/RefAudioSection.tsx:1031 |
| `ref-audio-section.start-recording-10.click` | ref-audio-section | button / start-recording / onClick | packages/shell/src/components/RefAudioSection.tsx:1042 |
| `ref-audio-section.set-gender-filter-11.select` | ref-audio-section | select / set-gender-filter / onChange | packages/shell/src/components/RefAudioSection.tsx:1085 |
| `ref-audio-section.on-preview-preset-12.click` | ref-audio-section | button / on-preview-preset / onClick | packages/shell/src/components/RefAudioSection.tsx:1130 |
| `ref-audio-section.on-apply-preset-13.click` | ref-audio-section | button / on-apply-preset / onClick | packages/shell/src/components/RefAudioSection.tsx:1139 |
| `ref-audio-section.set-local-engine-14.click` | ref-audio-section | button / set-local-engine / onClick | packages/shell/src/components/RefAudioSection.tsx:1173 |
| `settings-tab.set-open-1.click` | settings-tab | button / set-open / onClick | packages/shell/src/components/SettingsTab.tsx:529 |
| `settings-tab.on-change-2.click` | settings-tab | button / on-change / onClick | packages/shell/src/components/SettingsTab.tsx:548 |
| `settings-tab.set-open-3.click` | settings-tab | div / set-open / onClick | packages/shell/src/components/SettingsTab.tsx:674 |
| `settings-tab.on-change-4.click` | settings-tab | div / on-change / onClick | packages/shell/src/components/SettingsTab.tsx:682 |
| `settings-tab.on-change-5.click` | settings-tab | div / on-change / onClick | packages/shell/src/components/SettingsTab.tsx:692 |
| `settings-tab.set-active-settings-tab-6.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:4077 |
| `settings-tab.set-active-settings-tab-7.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:4085 |
| `settings-tab.set-active-settings-tab-8.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:4093 |
| `settings-tab.set-active-settings-tab-9.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:4101 |
| `settings-tab.set-active-settings-tab-10.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:4109 |
| `settings-tab.set-active-settings-tab-11.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:4117 |
| `settings-tab.set-active-settings-tab-12.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:4125 |
| `settings-tab.set-active-settings-tab-13.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:4133 |
| `settings-tab.set-active-settings-tab-14.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:4141 |
| `settings-tab.button-15.click` | settings-tab | button / button / onClick | packages/shell/src/components/SettingsTab.tsx:4154 |
| `settings-tab.open-url-16.click` | settings-tab | button / open-url / onClick | packages/shell/src/components/SettingsTab.tsx:4189 |
| `settings-tab.handle-theme-change-17.click` | settings-tab | button / handle-theme-change / onClick | packages/shell/src/components/SettingsTab.tsx:4203 |
| `settings-tab.handle-clear-naia-bg-18.select` | settings-tab | select / handle-clear-naia-bg / onChange | packages/shell/src/components/SettingsTab.tsx:4219 |
| `settings-tab.handle-import-asset-19.click` | settings-tab | button / handle-import-asset / onClick | packages/shell/src/components/SettingsTab.tsx:4242 |
| `settings-tab.handle-delete-asset-20.click` | settings-tab | button / handle-delete-asset / onClick | packages/shell/src/components/SettingsTab.tsx:4253 |
| `settings-tab.set-error-21.click` | settings-tab | button / set-error / onClick | packages/shell/src/components/SettingsTab.tsx:4284 |
| `settings-tab.button-22.click` | settings-tab | button / button / onClick | packages/shell/src/components/SettingsTab.tsx:4327 |
| `settings-tab.set-avatar-provider-23.select` | settings-tab | select / set-avatar-provider / onChange | packages/shell/src/components/SettingsTab.tsx:4353 |
| `settings-tab.open-nva-avatar-creator-24.click` | settings-tab | button / open-nva-avatar-creator / onClick | packages/shell/src/components/SettingsTab.tsx:4387 |
| `settings-tab.handle-vrm-select-25.click` | settings-tab | button / handle-vrm-select / onClick | packages/shell/src/components/SettingsTab.tsx:4414 |
| `settings-tab.handle-vrm-select-26.click` | settings-tab | button / handle-vrm-select / onClick | packages/shell/src/components/SettingsTab.tsx:4439 |
| `settings-tab.handle-import-asset-27.click` | settings-tab | button / handle-import-asset / onClick | packages/shell/src/components/SettingsTab.tsx:4452 |
| `settings-tab.handle-delete-asset-28.click` | settings-tab | button / handle-delete-asset / onClick | packages/shell/src/components/SettingsTab.tsx:4463 |
| `settings-tab.button-29.click` | settings-tab | button / button / onClick | packages/shell/src/components/SettingsTab.tsx:4488 |
| `settings-tab.handle-import-asset-30.click` | settings-tab | button / handle-import-asset / onClick | packages/shell/src/components/SettingsTab.tsx:4502 |
| `settings-tab.handle-delete-asset-31.click` | settings-tab | button / handle-delete-asset / onClick | packages/shell/src/components/SettingsTab.tsx:4510 |
| `settings-tab.set-persona-disabled-32.select` | settings-tab | input / set-persona-disabled / onChange | packages/shell/src/components/SettingsTab.tsx:4536 |
| `settings-tab.set-speech-style-33.select` | settings-tab | select / set-speech-style / onChange | packages/shell/src/components/SettingsTab.tsx:4591 |
| `settings-tab.handle-apply-naia-defaults-34.click` | settings-tab | button / handle-apply-naia-defaults / onClick | packages/shell/src/components/SettingsTab.tsx:4655 |
| `settings-tab.start-lab-login-35.click` | settings-tab | button / start-lab-login / onClick | packages/shell/src/components/SettingsTab.tsx:4664 |
| `settings-tab.start-lab-login-36.click` | settings-tab | button / start-lab-login / onClick | packages/shell/src/components/SettingsTab.tsx:4687 |
| `settings-tab.button-37.click` | settings-tab | button / button / onClick | packages/shell/src/components/SettingsTab.tsx:4727 |
| `settings-tab.open-url-38.click` | settings-tab | button / open-url / onClick | packages/shell/src/components/SettingsTab.tsx:4742 |
| `settings-tab.open-url-39.click` | settings-tab | button / open-url / onClick | packages/shell/src/components/SettingsTab.tsx:4753 |
| `settings-tab.stop-open-code-project-agent-sessions-40.click` | settings-tab | button / stop-open-code-project-agent-sessions / onClick | packages/shell/src/components/SettingsTab.tsx:4772 |
| `settings-tab.set-show-lab-disconnect-41.click` | settings-tab | button / set-show-lab-disconnect / onClick | packages/shell/src/components/SettingsTab.tsx:4885 |
| `settings-tab.set-show-lab-disconnect-42.click` | settings-tab | button / set-show-lab-disconnect / onClick | packages/shell/src/components/SettingsTab.tsx:4895 |
| `settings-tab.set-active-settings-tab-43.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:4983 |
| `settings-tab.set-active-settings-tab-44.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:4991 |
| `settings-tab.select-profile-tts-provider-45.select` | settings-tab | select / select-profile-tts-provider / onChange | packages/shell/src/components/SettingsTab.tsx:5003 |
| `settings-tab.handle-toggle-cascade-46.click` | settings-tab | button / handle-toggle-cascade / onClick | packages/shell/src/components/SettingsTab.tsx:5029 |
| `settings-tab.set-active-settings-tab-47.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:5049 |
| `settings-tab.set-active-settings-tab-48.click` | settings-tab | button / set-active-settings-tab / onClick | packages/shell/src/components/SettingsTab.tsx:5078 |
| `settings-tab.handle-select-local-tier-49.select` | settings-tab | select / handle-select-local-tier / onChange | packages/shell/src/components/SettingsTab.tsx:5104 |
| `settings-tab.handle-provider-change-50.select` | settings-tab | select / handle-provider-change / onChange | packages/shell/src/components/SettingsTab.tsx:5232 |
| `settings-tab.button-51.click` | settings-tab | button / button / onClick | packages/shell/src/components/SettingsTab.tsx:5267 |
| `settings-tab.button-52.click` | settings-tab | button / button / onClick | packages/shell/src/components/SettingsTab.tsx:5290 |
| `settings-tab.button-53.click` | settings-tab | button / button / onClick | packages/shell/src/components/SettingsTab.tsx:5313 |
| `settings-tab.set-ollama-runtime-busy-54.click` | settings-tab | button / set-ollama-runtime-busy / onClick | packages/shell/src/components/SettingsTab.tsx:5409 |
| `settings-tab.set-ollama-runtime-busy-55.click` | settings-tab | button / set-ollama-runtime-busy / onClick | packages/shell/src/components/SettingsTab.tsx:5438 |
| `settings-tab.set-ollama-pull-tag-56.select` | settings-tab | select / set-ollama-pull-tag / onChange | packages/shell/src/components/SettingsTab.tsx:5481 |
| `settings-tab.set-ollama-pull-confirming-57.click` | settings-tab | button / set-ollama-pull-confirming / onClick | packages/shell/src/components/SettingsTab.tsx:5759 |
| `settings-tab.set-ollama-pull-confirming-58.click` | settings-tab | button / set-ollama-pull-confirming / onClick | packages/shell/src/components/SettingsTab.tsx:5770 |
| `settings-tab.set-ollama-pull-confirming-59.click` | settings-tab | button / set-ollama-pull-confirming / onClick | packages/shell/src/components/SettingsTab.tsx:5779 |
| `settings-tab.button-60.click` | settings-tab | button / button / onClick | packages/shell/src/components/SettingsTab.tsx:5789 |
| `settings-tab.button-61.click` | settings-tab | button / button / onClick | packages/shell/src/components/SettingsTab.tsx:5801 |
| `settings-tab.set-model-sort-mode-62.select` | settings-tab | select / set-model-sort-mode / onChange | packages/shell/src/components/SettingsTab.tsx:5837 |
| `settings-tab.set-model-63.select` | settings-tab | select / set-model / onChange | packages/shell/src/components/SettingsTab.tsx:5898 |
| `settings-tab.set-voice-64.select` | settings-tab | select / set-voice / onChange | packages/shell/src/components/SettingsTab.tsx:6012 |
| `settings-tab.handle-voice-preview-65.click` | settings-tab | button / handle-voice-preview / onClick | packages/shell/src/components/SettingsTab.tsx:6027 |
| `settings-tab.set-enable-tools-66.select` | settings-tab | input / set-enable-tools / onChange | packages/shell/src/components/SettingsTab.tsx:6079 |
| `settings-tab.handle-thinking-change-67.click` | settings-tab | button / handle-thinking-change / onClick | packages/shell/src/components/SettingsTab.tsx:6113 |
| `settings-tab.set-environment-awareness-68.select` | settings-tab | select / set-environment-awareness / onChange | packages/shell/src/components/SettingsTab.tsx:6162 |
| `settings-tab.set-environment-terminal-input-69.select` | settings-tab | input / set-environment-terminal-input / onChange | packages/shell/src/components/SettingsTab.tsx:6224 |
| `settings-tab.handle-save-70.click` | settings-tab | button / handle-save / onClick | packages/shell/src/components/SettingsTab.tsx:6237 |
| `settings-tab.set-tts-enabled-71.select` | settings-tab | input / set-tts-enabled / onChange | packages/shell/src/components/SettingsTab.tsx:6257 |
| `settings-tab.set-stt-provider-72.select` | settings-tab | select / set-stt-provider / onChange | packages/shell/src/components/SettingsTab.tsx:6323 |
| `settings-tab.save-config-73.select` | settings-tab | select / save-config / onChange | packages/shell/src/components/SettingsTab.tsx:6381 |
| `settings-tab.set-stt-model-modal-open-74.click` | settings-tab | button / set-stt-model-modal-open / onClick | packages/shell/src/components/SettingsTab.tsx:6419 |
| `settings-tab.select-profile-tts-provider-75.select` | settings-tab | select / select-profile-tts-provider / onChange | packages/shell/src/components/SettingsTab.tsx:6438 |
| `settings-tab.handle-toggle-cascade-76.click` | settings-tab | button / handle-toggle-cascade / onClick | packages/shell/src/components/SettingsTab.tsx:6508 |
| `settings-tab.set-voice-migration-notice-77.click` | settings-tab | button / set-voice-migration-notice / onClick | packages/shell/src/components/SettingsTab.tsx:6580 |
| `settings-tab.save-config-78.select` | settings-tab | select / save-config / onChange | packages/shell/src/components/SettingsTab.tsx:6609 |
| `settings-tab.select-79.select` | settings-tab | select / select / onChange | packages/shell/src/components/SettingsTab.tsx:6687 |
| `settings-tab.handle-voice-preview-80.click` | settings-tab | button / handle-voice-preview / onClick | packages/shell/src/components/SettingsTab.tsx:6699 |
| `settings-tab.select-81.select` | settings-tab | select / select / onChange | packages/shell/src/components/SettingsTab.tsx:6725 |
| `settings-tab.handle-voice-preview-82.click` | settings-tab | button / handle-voice-preview / onClick | packages/shell/src/components/SettingsTab.tsx:6736 |
| `settings-tab.stop-mic-test-83.click` | settings-tab | button / stop-mic-test / onClick | packages/shell/src/components/SettingsTab.tsx:6784 |
| `settings-tab.button-84.click` | settings-tab | button / button / onClick | packages/shell/src/components/SettingsTab.tsx:6823 |
| `settings-tab.handle-save-85.click` | settings-tab | button / handle-save / onClick | packages/shell/src/components/SettingsTab.tsx:6837 |
| `settings-tab.set-memory-embedding-provider-86.select` | settings-tab | input / set-memory-embedding-provider / onChange | packages/shell/src/components/SettingsTab.tsx:6886 |
| `settings-tab.set-memory-offline-model-87.select` | settings-tab | input / set-memory-offline-model / onChange | packages/shell/src/components/SettingsTab.tsx:6940 |
| `settings-tab.set-memory-embedding-device-88.select` | settings-tab | input / set-memory-embedding-device / onChange | packages/shell/src/components/SettingsTab.tsx:6971 |
| `settings-tab.handle-save-89.click` | settings-tab | button / handle-save / onClick | packages/shell/src/components/SettingsTab.tsx:7057 |
| `settings-tab.set-memory-adapter-90.select` | settings-tab | input / set-memory-adapter / onChange | packages/shell/src/components/SettingsTab.tsx:7103 |
| `settings-tab.set-backup-status-91.click` | settings-tab | button / set-backup-status / onClick | packages/shell/src/components/SettingsTab.tsx:7159 |
| `settings-tab.set-backup-status-92.click` | settings-tab | button / set-backup-status / onClick | packages/shell/src/components/SettingsTab.tsx:7190 |
| `settings-tab.delete-fact-confirm-93.click` | settings-tab | button / delete-fact-confirm / onClick | packages/shell/src/components/SettingsTab.tsx:7273 |
| `settings-tab.handle-save-94.click` | settings-tab | button / handle-save / onClick | packages/shell/src/components/SettingsTab.tsx:7304 |
| `settings-tab.set-agent-health-status-95.click` | settings-tab | button / set-agent-health-status / onClick | packages/shell/src/components/SettingsTab.tsx:7343 |
| `settings-tab.remove-allowed-tool-96.click` | settings-tab | button / remove-allowed-tool / onClick | packages/shell/src/components/SettingsTab.tsx:7392 |
| `settings-tab.set-allowed-tools-97.click` | settings-tab | button / set-allowed-tools / onClick | packages/shell/src/components/SettingsTab.tsx:7408 |
| `settings-tab.button-98.click` | settings-tab | button / button / onClick | packages/shell/src/components/SettingsTab.tsx:7433 |
| `settings-tab.open-path-99.click` | settings-tab | button / open-path / onClick | packages/shell/src/components/SettingsTab.tsx:7453 |
| `settings-tab.set-reset-clear-history-100.select` | settings-tab | input / set-reset-clear-history / onChange | packages/shell/src/components/SettingsTab.tsx:7481 |
| `settings-tab.button-101.click` | settings-tab | button / button / onClick | packages/shell/src/components/SettingsTab.tsx:7489 |
| `settings-tab.set-show-reset-confirm-102.click` | settings-tab | button / set-show-reset-confirm / onClick | packages/shell/src/components/SettingsTab.tsx:7496 |
| `settings-tab.handle-reset-103.click` | settings-tab | button / handle-reset / onClick | packages/shell/src/components/SettingsTab.tsx:7508 |
| `settings-tab.set-stt-model-modal-open-104.click` | settings-tab | div / set-stt-model-modal-open / onClick | packages/shell/src/components/SettingsTab.tsx:7526 |
| `settings-tab.stop-propagation-105.click` | settings-tab | div / stop-propagation / onClick | packages/shell/src/components/SettingsTab.tsx:7530 |
| `settings-tab.set-stt-model-106.select` | settings-tab | input / set-stt-model / onChange | packages/shell/src/components/SettingsTab.tsx:7563 |
| `settings-tab.handle-stt-model-download-107.click` | settings-tab | button / handle-stt-model-download / onClick | packages/shell/src/components/SettingsTab.tsx:7624 |
| `settings-tab.handle-stt-model-delete-108.click` | settings-tab | button / handle-stt-model-delete / onClick | packages/shell/src/components/SettingsTab.tsx:7647 |
| `settings-tab.set-stt-model-modal-open-109.click` | settings-tab | button / set-stt-model-modal-open / onClick | packages/shell/src/components/SettingsTab.tsx:7664 |
| `settings-tab.handle-sync-dialog-apply-110.click` | settings-tab | button / handle-sync-dialog-apply / onClick | packages/shell/src/components/SettingsTab.tsx:7682 |
| `settings-tab.set-sync-dialog-open-111.click` | settings-tab | button / set-sync-dialog-open / onClick | packages/shell/src/components/SettingsTab.tsx:7689 |
| `settings-tab.open-url-112.click` | settings-tab | a / open-url / onClick | packages/shell/src/components/SettingsTab.tsx:7719 |
| `settings-tab.open-url-113.click` | settings-tab | a / open-url / onClick | packages/shell/src/components/SettingsTab.tsx:7733 |
| `settings-tab.open-url-114.click` | settings-tab | a / open-url / onClick | packages/shell/src/components/SettingsTab.tsx:7748 |
| `settings-tab.handle-check-update-115.click` | settings-tab | button / handle-check-update / onClick | packages/shell/src/components/SettingsTab.tsx:7815 |
| `settings-tab.handle-install-116.click` | settings-tab | button / handle-install / onClick | packages/shell/src/components/SettingsTab.tsx:7830 |
| `settings-tab.handle-ui-font-scale-change-117.click` | settings-tab | button / handle-ui-font-scale-change / onClick | packages/shell/src/components/SettingsTab.tsx:4318 |
| `skills-tab.button-1.click` | skills-tab | button / button / onClick | packages/shell/src/components/SkillsTab.tsx:127 |
| `skills-tab.stop-propagation-2.click` | skills-tab | label / stop-propagation / onClick | packages/shell/src/components/SkillsTab.tsx:170 |
| `skills-tab.handle-toggle-cli-3.select` | skills-tab | input / handle-toggle-cli / onChange | packages/shell/src/components/SkillsTab.tsx:174 |
| `skills-tab.handle-recheck-4.click` | skills-tab | button / handle-recheck / onClick | packages/shell/src/components/SkillsTab.tsx:193 |
| `skills-tab.handle-login-5.click` | skills-tab | button / handle-login / onClick | packages/shell/src/components/SkillsTab.tsx:206 |
| `skills-tab.stop-propagation-6.click` | skills-tab | label / stop-propagation / onClick | packages/shell/src/components/SkillsTab.tsx:246 |
| `skills-tab.handle-toggle-gesture-7.select` | skills-tab | input / handle-toggle-gesture / onChange | packages/shell/src/components/SkillsTab.tsx:250 |
| `small-llm-section.handle-select-naia-1.select` | small-llm-section | input / handle-select-naia / onChange | packages/shell/src/components/SmallLlmSection.tsx:228 |
| `small-llm-section.handle-select-local-2.select` | small-llm-section | input / handle-select-local / onChange | packages/shell/src/components/SmallLlmSection.tsx:245 |
| `small-llm-section.handle-select-local-3.select` | small-llm-section | input / handle-select-local / onChange | packages/shell/src/components/SmallLlmSection.tsx:256 |
| `small-llm-section.handle-select-threshold-4.select` | small-llm-section | input / handle-select-threshold / onChange | packages/shell/src/components/SmallLlmSection.tsx:267 |
| `small-llm-section.handle-select-off-5.select` | small-llm-section | input / handle-select-off / onChange | packages/shell/src/components/SmallLlmSection.tsx:278 |
| `small-llm-section.handle-select-level-6.select` | small-llm-section | input / handle-select-level / onChange | packages/shell/src/components/SmallLlmSection.tsx:304 |
| `small-llm-section.handle-select-level-7.select` | small-llm-section | input / handle-select-level / onChange | packages/shell/src/components/SmallLlmSection.tsx:315 |
| `small-llm-section.handle-select-level-8.select` | small-llm-section | input / handle-select-level / onChange | packages/shell/src/components/SmallLlmSection.tsx:326 |
| `studio-nva-apply-dialog.open-login-settings-1.click` | studio-nva-apply-dialog | button / open-login-settings / onClick | packages/shell/src/components/StudioNvaApplyDialog.tsx:238 |
| `studio-nva-apply-dialog.button-2.click` | studio-nva-apply-dialog | button / button / onClick | packages/shell/src/components/StudioNvaApplyDialog.tsx:243 |
| `studio-nva-apply-dialog.button-3.click` | studio-nva-apply-dialog | button / button / onClick | packages/shell/src/components/StudioNvaApplyDialog.tsx:247 |
| `studio-nva-apply-dialog.button-4.click` | studio-nva-apply-dialog | button / button / onClick | packages/shell/src/components/StudioNvaApplyDialog.tsx:251 |
| `title-bar.on-toggle-app-1.click` | title-bar | button / on-toggle-app / onClick | packages/shell/src/components/TitleBar.tsx:39 |
| `title-bar.button-2.click` | title-bar | button / button / onClick | packages/shell/src/components/TitleBar.tsx:61 |
| `title-bar.button-3.click` | title-bar | button / button / onClick | packages/shell/src/components/TitleBar.tsx:69 |
| `title-bar.button-4.click` | title-bar | button / button / onClick | packages/shell/src/components/TitleBar.tsx:83 |
| `tool-activity.set-expanded-1.click` | tool-activity | button / set-expanded / onClick | packages/shell/src/components/ToolActivity.tsx:66 |
| `update-banner.handle-view-details-1.click` | update-banner | button / handle-view-details / onClick | packages/shell/src/components/UpdateBanner.tsx:47 |
| `update-banner.handle-update-2.click` | update-banner | button / handle-update / onClick | packages/shell/src/components/UpdateBanner.tsx:54 |
| `update-banner.on-dismiss-3.click` | update-banner | button / on-dismiss / onClick | packages/shell/src/components/UpdateBanner.tsx:61 |
| `update-prompt.set-snooze-for-month-1.select` | update-prompt | input / set-snooze-for-month / onChange | packages/shell/src/components/UpdatePrompt.tsx:122 |
| `update-prompt.handle-view-details-2.click` | update-prompt | button / handle-view-details / onClick | packages/shell/src/components/UpdatePrompt.tsx:138 |
| `update-prompt.on-later-3.click` | update-prompt | button / on-later / onClick | packages/shell/src/components/UpdatePrompt.tsx:147 |
| `update-prompt.handle-install-4.click` | update-prompt | button / handle-install / onClick | packages/shell/src/components/UpdatePrompt.tsx:155 |
| `work-progress-area.handle-refresh-1.click` | work-progress-area | button / handle-refresh / onClick | packages/shell/src/components/WorkProgressArea.tsx:91 |
| `work-progress-area.set-error-filter-active-2.click` | work-progress-area | button / set-error-filter-active / onClick | packages/shell/src/components/WorkProgressArea.tsx:125 |
| `work-progress-area.set-error-filter-active-3.click` | work-progress-area | button / set-error-filter-active / onClick | packages/shell/src/components/WorkProgressArea.tsx:142 |
| `work-progress-area.set-expanded-id-4.click` | work-progress-area | button / set-expanded-id / onClick | packages/shell/src/components/WorkProgressArea.tsx:152 |
| `wsl-setup-screen.button-1.click` | wsl-setup-screen | button / button / onClick | packages/shell/src/components/WslSetupScreen.tsx:116 |
| `wsl-setup-screen.handle-setup-2.click` | wsl-setup-screen | button / handle-setup / onClick | packages/shell/src/components/WslSetupScreen.tsx:148 |
| `browser-center-area.button-1.click` | browser-center-area | button / button / onClick | packages/shell/src/apps/browser/BrowserCenterArea.tsx:883 |
| `browser-center-area.button-2.click` | browser-center-area | button / button / onClick | packages/shell/src/apps/browser/BrowserCenterArea.tsx:891 |
| `browser-center-area.button-3.click` | browser-center-area | button / button / onClick | packages/shell/src/apps/browser/BrowserCenterArea.tsx:899 |
| `browser-center-area.handle-navigate-4.submit` | browser-center-area | form / handle-navigate / onSubmit | packages/shell/src/apps/browser/BrowserCenterArea.tsx:907 |
| `browser-center-area.handle-add-shortcut-5.click` | browser-center-area | button / handle-add-shortcut / onClick | packages/shell/src/apps/browser/BrowserCenterArea.tsx:930 |
| `browser-center-area.handle-add-bookmark-6.click` | browser-center-area | button / handle-add-bookmark / onClick | packages/shell/src/apps/browser/BrowserCenterArea.tsx:938 |
| `browser-center-area.toggle-bookmark-list-7.click` | browser-center-area | button / toggle-bookmark-list / onClick | packages/shell/src/apps/browser/BrowserCenterArea.tsx:946 |
| `browser-center-area.button-8.click` | browser-center-area | button / button / onClick | packages/shell/src/apps/browser/BrowserCenterArea.tsx:967 |
| `browser-center-area.toggle-toolbar-9.click` | browser-center-area | button / toggle-toolbar / onClick | packages/shell/src/apps/browser/BrowserCenterArea.tsx:1015 |
| `browser-center-area.toggle-all-10.select` | browser-center-area | input / toggle-all / onChange | packages/shell/src/apps/browser/BrowserCenterArea.tsx:1031 |
| `browser-center-area.set-one-11.select` | browser-center-area | input / set-one / onChange | packages/shell/src/apps/browser/BrowserCenterArea.tsx:1051 |
| `browser-center-area.toggle-toolbar-12.click` | browser-center-area | button / toggle-toolbar / onClick | packages/shell/src/apps/browser/BrowserCenterArea.tsx:1063 |
| `browser-meta-area.on-navigate-1.click` | browser-meta-area | button / on-navigate / onClick | packages/shell/src/apps/browser/BrowserMetaArea.tsx:63 |
| `browser-meta-area.handle-remove-2.click` | browser-meta-area | button / handle-remove / onClick | packages/shell/src/apps/browser/BrowserMetaArea.tsx:76 |
| `project-agent-panel.select-app-1.select` | project-agent-panel | input / select-app / onChange | packages/shell/src/apps/projects/ProjectAgentPanel.tsx:227 |
| `project-agent-panel.handle-start-2.click` | project-agent-panel | button / handle-start / onClick | packages/shell/src/apps/projects/ProjectAgentPanel.tsx:259 |
| `project-agent-panel.handle-stop-3.click` | project-agent-panel | button / handle-stop / onClick | packages/shell/src/apps/projects/ProjectAgentPanel.tsx:273 |
| `project-docs-panel.button-1.click` | project-docs-panel | button / button / onClick | packages/shell/src/apps/projects/ProjectDocsPanel.tsx:217 |
| `project-docs-panel.button-2.click` | project-docs-panel | button / button / onClick | packages/shell/src/apps/projects/ProjectDocsPanel.tsx:272 |
| `project-web-view-panel.open-project-web-view-1.click` | project-web-view-panel | button / open-project-web-view / onClick | packages/shell/src/apps/projects/ProjectWebViewPanel.tsx:141 |
| `projects-app.on-open-1.click` | projects-app | button / on-open / onClick | packages/shell/src/apps/projects/ProjectsApp.tsx:240 |
| `projects-app.set-show-reset-dialog-2.click` | projects-app | button / set-show-reset-dialog / onClick | packages/shell/src/apps/projects/ProjectsApp.tsx:702 |
| `projects-app.button-3.click` | projects-app | button / button / onClick | packages/shell/src/apps/projects/ProjectsApp.tsx:712 |
| `projects-app.set-show-reset-dialog-4.click` | projects-app | button / set-show-reset-dialog / onClick | packages/shell/src/apps/projects/ProjectsApp.tsx:780 |
| `projects-app.handle-confirm-class-reset-5.click` | projects-app | button / handle-confirm-class-reset / onClick | packages/shell/src/apps/projects/ProjectsApp.tsx:788 |
| `projects-app.button-6.click` | projects-app | button / button / onClick | packages/shell/src/apps/projects/ProjectsApp.tsx:812 |
| `projects-app.button-7.click` | projects-app | button / button / onClick | packages/shell/src/apps/projects/ProjectsApp.tsx:900 |
| `projects-app.button-8.click` | projects-app | button / button / onClick | packages/shell/src/apps/projects/ProjectsApp.tsx:911 |
| `projects-app.button-9.click` | projects-app | button / button / onClick | packages/shell/src/apps/projects/ProjectsApp.tsx:936 |
| `slides-center-area.set-focus-mode-1.click` | slides-center-area | button / set-focus-mode / onClick | packages/shell/src/apps/slides/SlidesCenterArea.tsx:684 |
| `slides-controls.on-action-1.click` | slides-controls | button / on-action / onClick | packages/shell/src/apps/slides/SlidesControls.tsx:70 |
| `slides-controls.on-action-2.click` | slides-controls | button / on-action / onClick | packages/shell/src/apps/slides/SlidesControls.tsx:78 |
| `slides-controls.on-action-3.click` | slides-controls | button / on-action / onClick | packages/shell/src/apps/slides/SlidesControls.tsx:98 |
| `slides-controls.on-toggle-repeat-4.click` | slides-controls | button / on-toggle-repeat / onClick | packages/shell/src/apps/slides/SlidesControls.tsx:105 |
| `slides-controls.on-action-5.click` | slides-controls | button / on-action / onClick | packages/shell/src/apps/slides/SlidesControls.tsx:114 |
| `slides-controls.on-toggle-fullscreen-6.click` | slides-controls | button / on-toggle-fullscreen / onClick | packages/shell/src/apps/slides/SlidesControls.tsx:133 |
| `slides-controls.on-toggle-recording-7.click` | slides-controls | button / on-toggle-recording / onClick | packages/shell/src/apps/slides/SlidesControls.tsx:141 |
| `slides-file-actions.on-pick-native-1.click` | slides-file-actions | input / on-pick-native / onClick | packages/shell/src/apps/slides/SlidesFileActions.tsx:41 |
| `slides-file-actions.on-toggle-focus-2.click` | slides-file-actions | button / on-toggle-focus / onClick | packages/shell/src/apps/slides/SlidesFileActions.tsx:82 |
| `slides-file-actions.on-show-notes-3.click` | slides-file-actions | button / on-show-notes / onClick | packages/shell/src/apps/slides/SlidesFileActions.tsx:90 |
| `slides-script-panel.on-begin-edit-1.click` | slides-script-panel | button / on-begin-edit / onClick | packages/shell/src/apps/slides/SlidesScriptPanel.tsx:47 |
| `slides-script-panel.on-download-2.click` | slides-script-panel | button / on-download / onClick | packages/shell/src/apps/slides/SlidesScriptPanel.tsx:57 |
| `slides-script-panel.on-hide-3.click` | slides-script-panel | button / on-hide / onClick | packages/shell/src/apps/slides/SlidesScriptPanel.tsx:68 |
| `slides-script-panel.on-apply-4.click` | slides-script-panel | button / on-apply / onClick | packages/shell/src/apps/slides/SlidesScriptPanel.tsx:92 |
| `slides-script-panel.on-cancel-5.click` | slides-script-panel | button / on-cancel / onClick | packages/shell/src/apps/slides/SlidesScriptPanel.tsx:101 |
| `slides-status.on-cancel-import-1.click` | slides-status | button / on-cancel-import / onClick | packages/shell/src/apps/slides/SlidesStatus.tsx:51 |
| `doc-tab-bar.on-select-1.click` | doc-tab-bar | div / on-select / onClick | packages/shell/src/apps/workspace/DocTabBar.tsx:38 |
| `doc-tab-bar.stop-propagation-2.click` | doc-tab-bar | button / stop-propagation / onClick | packages/shell/src/apps/workspace/DocTabBar.tsx:51 |
| `doc-tab-bar.stop-propagation-3.click` | doc-tab-bar | button / stop-propagation / onClick | packages/shell/src/apps/workspace/DocTabBar.tsx:63 |
| `editor.button-1.click` | editor | button / button / onClick | packages/shell/src/apps/workspace/Editor.tsx:796 |
| `editor.button-2.click` | editor | button / button / onClick | packages/shell/src/apps/workspace/Editor.tsx:807 |
| `editor.button-3.click` | editor | button / button / onClick | packages/shell/src/apps/workspace/Editor.tsx:828 |
| `editor.button-4.click` | editor | button / button / onClick | packages/shell/src/apps/workspace/Editor.tsx:837 |
| `editor.set-view-mode-5.click` | editor | button / set-view-mode / onClick | packages/shell/src/apps/workspace/Editor.tsx:856 |
| `editor.set-view-mode-6.click` | editor | button / set-view-mode / onClick | packages/shell/src/apps/workspace/Editor.tsx:867 |
| `editor.set-view-mode-7.click` | editor | button / set-view-mode / onClick | packages/shell/src/apps/workspace/Editor.tsx:875 |
| `editor.set-view-mode-8.click` | editor | button / set-view-mode / onClick | packages/shell/src/apps/workspace/Editor.tsx:886 |
| `editor.set-view-mode-9.click` | editor | button / set-view-mode / onClick | packages/shell/src/apps/workspace/Editor.tsx:895 |
| `editor.set-playback-rate-10.select` | editor | select / set-playback-rate / onChange | packages/shell/src/apps/workspace/Editor.tsx:961 |
| `editor.set-image-zoom-11.click` | editor | button / set-image-zoom / onClick | packages/shell/src/apps/workspace/Editor.tsx:988 |
| `editor.set-image-zoom-12.click` | editor | button / set-image-zoom / onClick | packages/shell/src/apps/workspace/Editor.tsx:996 |
| `editor.set-image-zoom-13.click` | editor | button / set-image-zoom / onClick | packages/shell/src/apps/workspace/Editor.tsx:1004 |
| `editor.set-image-zoom-14.click` | editor | button / set-image-zoom / onClick | packages/shell/src/apps/workspace/Editor.tsx:1025 |
| `editor.toggle-sort-15.click` | editor | th / toggle-sort / onClick | packages/shell/src/apps/workspace/Editor.tsx:1151 |
| `file-tree.button-1.click` | file-tree | button / button / onClick | packages/shell/src/apps/workspace/FileTree.tsx:175 |
| `file-tree.on-file-select-2.click` | file-tree | button / on-file-select / onClick | packages/shell/src/apps/workspace/FileTree.tsx:287 |
| `file-tree.handle-copy-relative-3.click` | file-tree | button / handle-copy-relative / onClick | packages/shell/src/apps/workspace/FileTree.tsx:418 |
| `file-tree.handle-copy-absolute-4.click` | file-tree | button / handle-copy-absolute / onClick | packages/shell/src/apps/workspace/FileTree.tsx:425 |
| `file-tree.handle-send-to-chat-5.click` | file-tree | button / handle-send-to-chat / onClick | packages/shell/src/apps/workspace/FileTree.tsx:435 |
| `herdr-workspace-rail.on-show-herdr-1.click` | herdr-workspace-rail | button / on-show-herdr / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceRail.tsx:71 |
| `herdr-workspace-rail.on-show-viewer-2.click` | herdr-workspace-rail | button / on-show-viewer / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceRail.tsx:80 |
| `herdr-workspace-rail.on-show-viewer-3.click` | herdr-workspace-rail | button / on-show-viewer / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceRail.tsx:89 |
| `herdr-workspace-rail.select-tab-4.click` | herdr-workspace-rail | button / select-tab / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceRail.tsx:115 |
| `herdr-workspace-rail.select-tab-5.click` | herdr-workspace-rail | button / select-tab / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceRail.tsx:123 |
| `herdr-workspace-rail.select-tab-6.click` | herdr-workspace-rail | button / select-tab / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceRail.tsx:131 |
| `herdr-workspace-rail.on-focus-workspace-7.click` | herdr-workspace-rail | button / on-focus-workspace / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceRail.tsx:146 |
| `herdr-workspace-rail.on-focus-agent-8.click` | herdr-workspace-rail | button / on-focus-agent / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceRail.tsx:157 |
| `herdr-workspace-surface.button-1.click` | herdr-workspace-surface | button / button / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceSurface.tsx:94 |
| `herdr-workspace-surface.button-2.click` | herdr-workspace-surface | button / button / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceSurface.tsx:117 |
| `herdr-workspace-surface.button-3.click` | herdr-workspace-surface | button / button / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceSurface.tsx:135 |
| `herdr-workspace-surface.button-4.click` | herdr-workspace-surface | button / button / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceSurface.tsx:145 |
| `herdr-workspace-surface.button-5.click` | herdr-workspace-surface | button / button / onClick | packages/shell/src/apps/workspace/HerdrWorkspaceSurface.tsx:174 |
| `markdown-preview.open-url-1.click` | markdown-preview | a / open-url / onClick | packages/shell/src/apps/workspace/MarkdownPreview.tsx:189 |
| `open-file-edit-review.on-approve-1.click` | open-file-edit-review | button / on-approve / onClick | packages/shell/src/apps/workspace/OpenFileEditReview.tsx:126 |
| `open-file-edit-review.on-reject-2.click` | open-file-edit-review | button / on-reject / onClick | packages/shell/src/apps/workspace/OpenFileEditReview.tsx:134 |
| `quick-open.on-close-1.click` | quick-open | div / on-close / onClick | packages/shell/src/apps/workspace/QuickOpen.tsx:107 |
| `quick-open.stop-propagation-2.click` | quick-open | div / stop-propagation / onClick | packages/shell/src/apps/workspace/QuickOpen.tsx:108 |
| `quick-open.handle-select-3.click` | quick-open | div / handle-select / onClick | packages/shell/src/apps/workspace/QuickOpen.tsx:127 |
| `terminal.div-1.context` | terminal | div / div / onContextMenu | packages/shell/src/apps/workspace/Terminal.tsx:471 |
| `terminal.set-toast-message-2.click` | terminal | div / set-toast-message / onClick | packages/shell/src/apps/workspace/Terminal.tsx:493 |
| `workspace-context-app.button-1.click` | workspace-context-app | button / button / onClick | packages/shell/src/apps/workspace/WorkspaceContextApp.tsx:91 |
| `workspace-context-app.button-2.click` | workspace-context-app | button / button / onClick | packages/shell/src/apps/workspace/WorkspaceContextApp.tsx:157 |
| `workspace-context-app.button-3.click` | workspace-context-app | button / button / onClick | packages/shell/src/apps/workspace/WorkspaceContextApp.tsx:170 |

## 로그인 검증 실패 신호 보완

기존 Rust는 잘못된 state·키를 로그만 남기고 버렸다. `naia_auth_rejected`라는 값 없는 로컬 신호를 추가하여 진행 중인 통계 로그인 시도만 `validation`으로 닫는다. 키·state·주소는 신호와 통계에 넣지 않는다. 설정/소개를 떠나면 진행 중인 시도는 cancel로 닫는다. 시도 시작 뒤 5분 만료와 저장 성공의 중복 방지는 통계 모듈에서 수행하며 실제 OAuth 동작은 바꾸지 않는다.

## 셸 루트 제어 추가 대조

| 이름표 | 화면 | 제어/핸들러 | 소스 (기준판 행) |
|---|---|---|---|
| `shell.set-global-toast-1.click` | shell | div / set-global-toast / onClick | packages/shell/src/App.tsx:1173 |

## 정본 묶음 이름표와 상세 누름의 관계

`packages/shell/src/lib/usage-control-aliases.ts`는 부록의 소개 링크·외모·배경·연결 세 갈래·음성, 홈 메뉴·바로가기, 설정 옵션·음성 시험·저장·업데이트 이름을 상세 누름에 함께 연결한다. 한 번 누름에는 상세 위치 사건과 묶음 의미 사건이 각각 생기므로 전체 사건 수를 누름 수로 읽지 않는다. `choice`는 이 파일과 `usage-events.ts`의 고정 허용값만 받고, 선택기의 실제 값·이름·경로를 읽지 않는다. 말투·배경의 세부 입력값은 보내지 않고 선택 발생만 센다. 이동은 현재 step과 back/next의 고정값이다. 소개 제공자 단계의 세 갈래는 naia_start/manual/later로 구별한다. 원 부록 이름은 집계 필터로 계속 사용할 수 있다.

동의 끄기는 storage 이벤트에 더해 값 없는 BroadcastChannel 신호로 다른 창을 중단한다. 저장소 쓰기 실패 때에도 살아 있는 창을 즉시 중지시키며, 성공적으로 저장한 재동의 이후에만 수집을 재개한다. 이미 수신 완료된 요청의 취소는 보장하지 않는다.

전송 형식 참고(구현 시 확인): [Microsoft 연결 문자열 문서](https://learn.microsoft.com/en-us/azure/azure-monitor/app/sdk-connection-string), [Microsoft 수집 경로 설명](https://github.com/microsoft/appinsights-telemetry-flow/blob/main/docs/architecture.md). 실제 자원과 CORS·수신 표·IP/접근 기록 정책은 아직 검증하지 않았으며 출시 관문이다.

## 최신 main에서 추가된 고정 제어

| 이름표 | 화면 | 제어/핸들러 | 소스 (병합 시점 행) |
|---|---|---|---|
| `ai-control-bar.main-merge-1.click` | ai-control-bar | button / onClick | packages/shell/src/components/AiControlBar.tsx:252 |
| `ai-control-bar.main-merge-2.click` | ai-control-bar | button / onClick | packages/shell/src/components/AiControlBar.tsx:290 |
| `bgm-player.main-merge-1.select` | bgm-player | input / onChange | packages/shell/src/components/BgmPlayer.tsx:2585 |
| `settings-tab.main-merge-1.select` | settings-tab | select / onChange | packages/shell/src/components/SettingsTab.tsx:7926 |
| `settings-tab.main-merge-2.select` | settings-tab | select / onChange | packages/shell/src/components/SettingsTab.tsx:7969 |
| `settings-tab.main-merge-3.click` | settings-tab | button / onClick | packages/shell/src/components/SettingsTab.tsx:8010 |
| `char-card-app.main-merge-1.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:527 |
| `char-card-app.main-merge-2.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:577 |
| `char-card-app.main-merge-3.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:605 |
| `char-card-app.main-merge-4.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:630 |
| `char-card-app.main-merge-5.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:687 |
| `char-card-app.main-merge-6.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:695 |
| `char-card-app.main-merge-7.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:721 |
| `char-card-app.main-merge-8.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:729 |
| `char-card-app.main-merge-9.select` | char-card-app | select / onChange | packages/shell/src/apps/charcard/CharCardApp.tsx:825 |
| `char-card-app.main-merge-10.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:845 |
| `char-card-app.main-merge-11.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:857 |
| `char-card-app.main-merge-12.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:868 |
| `char-card-app.main-merge-13.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:1018 |
| `char-card-app.main-merge-14.click` | char-card-app | button / onClick | packages/shell/src/apps/charcard/CharCardApp.tsx:1027 |
