# 탭 스킬 — 패널 공통 AI 도구

뷰포트가 있는 모든 패널에서 사용 가능한 공통 AI 도구. 한 번 정의하면 패널에서 hook 한 줄로 적용.

## 아키텍처

```
AI가 skill_tab_screenshot 호출
  → useTabSkills hook (패널 컴포넌트)
    → invoke("capture_screen_region", {x, y, width, height})  ← CSS 논리 px
      → Rust: inner_position + scale_factor 변환
        → Windows:  GDI BitBlt → PNG (png crate)
        → macOS:    screencapture -R x,y,w,h -x path.png
        → Linux:    scrot -a x,y,w,h  →  import -crop (ImageMagick fallback)
```

## 파일

| 파일 | 역할 |
|------|------|
| `shell/src-tauri/src/capture.rs` | Rust 커맨드 + 플랫폼 백엔드 |
| `shell/src/lib/tab-skills.ts` | TS hook + descriptor 내보내기 |
| `shell/src-tauri/src/lib.rs` | `capture_screen_region` invoke_handler 등록 |

## 패널에 탭 스킬 추가하는 법

**`panel/index.tsx`** — tools 배열에 descriptor 추가:
```ts
import { TAB_SKILL_DESCRIPTORS } from "../../lib/tab-skills";

panelRegistry.register({
  tools: [...TAB_SKILL_DESCRIPTORS, ...패널고유도구],
  ...
});
```

**`PanelCenter컴포넌트.tsx`** — 핸들러 등록:
```ts
import { useTabSkills } from "../../lib/tab-skills";

export function MyPanel({ naia }: PanelCenterProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  useTabSkills(viewportRef, naia);
  // ...
  return <div ref={viewportRef} className="my-panel__viewport" />;
}
```

## 현재 스킬

### `skill_tab_screenshot`

- **Tier**: 0 (자동 허용)
- **설명**: OS 화면 버퍼에서 패널 뷰포트 영역을 직접 캡처
- **반환값**: OS 임시 디렉토리에 저장된 PNG 파일의 절대 경로
- **특이사항**: DOM이 아닌 화면을 읽으므로 네이티브 오버레이 패널(WebView2, X11 임베드)에도 동작

## 플랫폼 좌표 변환

```
screen_x = window.inner_position().x + css_x * scale_factor
screen_y = window.inner_position().y + css_y * scale_factor
```

`inner_position()` 사용 (outer_position 아님) → OS 타이틀바·윈도우 테두리 제외.

## 새 탭 스킬 추가 방법

1. `tab-skills.ts`에 `SKILL_TAB_<이름>: NaiaTool` descriptor 정의
2. `TAB_SKILL_DESCRIPTORS` 배열에 추가
3. `useTabSkills` `useEffect`에 핸들러 추가
4. Rust 커맨드 필요시 `capture.rs`에 추가
5. `lib.rs` invoke_handler에 등록
6. 패널은 `...TAB_SKILL_DESCRIPTORS`로 자동 적용
