# IR 키오스크 지식 (S1)

범위: UC-KIOSK-KNOWLEDGE-S1 / FR-KIOSK-KNOWLEDGE-S1. 2026-11-05 기준.

`knowledge/*.md`는 외부 자료에서 공개 가능한 주장만 새로 쓴 원고다. 각 원고 끝에 근거 파일 경로가 있다.
최신 경기 IR 교정·제품 상태 문서를 우선하며 이전 IR은 브랜드와 철학의 보조 근거로 사용한다.
확인 전 계정 수, 고객 이름, 개인 이름, 비공개 재무/계약 수치와 인증 정보는 넣지 않는다.
릴리스 다운로드와 커뮤니티 가입은 활성 사용자와 구분하고 항상 기준일을 밝힌다.
출시·등록·선정·계획도 구분한다. 이 지식은 최신 서비스 현황을 실시간 조회하지 않는다.

`kb-compiler/`는 같은 회사 컴파일러의 browser-safe 부분집합이다(원본 커밋은 그 README 참조).
MarkdownExtractAdapter → compile → `{version:1,kb}` envelope → KnowledgeService/BM25 경로다.
검증한 20문항은 검색 평가이며 모델 생성 답변의 사실성 평가를 뜻하지 않는다.

원고 변경 후 저장소 루트 build를 수행하고 Shell에서 다음 순서로 갱신한다:

```sh
UPDATE_KIOSK_KB=1 pnpm test src/lib/kiosk-demo/knowledge.test.ts -t 'locally compiles'
pnpm test src/lib/kiosk-demo/knowledge.test.ts
```

웹 빌드: `VITE_NAIA_KIOSK_DEMO=1`과 `--mode web`을 함께 사용한다.
기존 웹 빌드와 동일하게 `NAIA_WEB_AGENT_DIR`(browser-agent 브랜치), `NAIA_WEB_ADK_REPO`가 필요하다.
부팅 ADK 준비 뒤 OPFS `naia-adk/naia-settings/knowledge.json` 및 `knowledge/kiosk-demo/kb.json`을 초기화한다.
이미 있는 설정과 KB는 보존한다. compile 명령은 번들 원고만 재컴파일한다; 임의 파일 접근이나 모델 호출이 없다.
scope는 안전한 한 경로 세그먼트만 받는다. 설정에서 번들 외 소스를 지정하면 실패한다.

Worker는 매 대화 전 같은 OPFS 설정과 KB를 읽고 데스크톱 `makeKnowledgeSkillsExecutor`에 backend로 주입한다.
모델에 `skill_knowledge_search`와 `skill_knowledge_ask`를 노출하며 기존 persona에 근거 우선 안내를 덧붙인다.
깃발이 꺼지면 기존 명령표의 desktop-only와 기존 Worker 실행기·부팅 경로를 그대로 사용한다.
배포·실 공급자 호출·음성 시연은 S7/S5 통합 범위다.
