# 브라우저용 kb-compiler 부분집합

`nextain/naia-kb-compiler`의 순수 TypeScript 모듈을 원본 디렉토리 구조로 보관한다.
Node 파일·네트워크·모델·임베딩 의존성을 제외한 로컬 Markdown compile와 BM25 serve 경로다.
미사용 변수 2곳의 이름/parameter property만 Shell의 엄격한 typecheck에 맞춰 바꿨다. 알고리즘을 보존하며 업데이트 시 원본 커밋과 차이를 확인한다. 공개 패키지가 아니므로 임시 절대 경로 의존성을 만들지 않는다.
403edb026ad4676b07158e76863eea79d57554b8
