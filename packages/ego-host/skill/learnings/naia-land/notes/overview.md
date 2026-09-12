# naia.land 개요

정본은 `projects/naia.land` 의 소스다. 아래 셀렉터는 **그 소스에서 읽어 적었고 실제 사이트에
접속해 확인하지 않았다.** 처음 쓸 때 스냅샷으로 한 번 대조한다.

## 주소 구조

- 모든 사람이 보는 페이지는 **로케일 접두사**를 갖는다: `/{lang}` 이 홈, `/{lang}/login`,
  `/{lang}/download`, `/{lang}/pricing`, `/{lang}/manual`, `/{lang}/blog`, `/{lang}/dashboard`.
- 로케일은 14개다: `en ko ja zh fr de ru es ar hi bn pt id vi`. 접두사 없는 `/` 는 리다이렉트이므로
  주소를 만들 때는 언제나 로케일을 넣는다.
- 정규 원본은 `https://www.naia.land` 다.

## 페이지 구조

- 머리글(`header`)은 sticky 이고 안에 `nav` 하나가 있다. 화면이 좁으면 같은 링크가 두 번째
  `nav`(모바일 시트)에도 나온다 — 셀렉터를 쓸 때 `header nav a` 로 좁힌다.
- 로그인·다운로드·대시보드는 클래스가 아니라 **주소로** 고른다. 클래스는 Tailwind 유틸리티라
  디자인이 바뀔 때마다 사라진다.
- 홈은 `Hero → UsbBoot → Features → Showcase → NaiaOmni → Comparison → Pricing → Faq` 순서의
  `section` 묶음이다. 첫 `h1` 이 Hero 의 제목이다.

## 안정 셀렉터

| 대상 | 셀렉터 |
|---|---|
| 머리글 로그인 링크 | `header nav a[href$="/login"]`, 없으면 `header a[href$="/login"]` |
| 머리글 다운로드 링크 | `header a[href$="/download"]` |
| 로그인한 사용자의 대시보드 링크 | `header a[href$="/dashboard"]` |
| Hero 의 주 행동 단추 | `main section:first-of-type a[href$="/login"]` (비로그인) / `…a[href$="/dashboard"]` (로그인) |
| 홈 제목 | `main h1` |
| 로그인 카드 | `main form` |
| 로그인 제출 단추 | `main form button[type="submit"]` |

## 로그인은 사람이 한다

로그인 카드에는 입력란이 없다. Google OAuth 로 나가는 `form` 하나뿐이고(Discord 단추는 소스에서
주석 처리돼 있다) 그 뒤는 외부 제공자 화면이다. 우리 작업 공간은 헤드리스·비로그인 격리라
그 화면을 넘어갈 수 없다.

`main form button[type="submit"]` 을 누르는 순간 사람이 필요한 구간이다. 누르지 말고 **멈추고
보고한다** — 어느 주소에 있고 무엇이 막혔는지. 자격증명을 찾거나 다른 경로로 같은 보호 자원에
접근하려 하지 않는다(SKILL.md "Login, captcha, and anything that needs a person").

`/{lang}/dashboard` 를 비로그인으로 열면 `/{lang}/login` 으로 밀려난다. 주소가 바뀐 것을 보고
"대시보드를 봤다"고 말하지 않는다.
