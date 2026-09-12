// #582 S2b — marker 를 명령줄에 달고 그냥 잠자는 프로세스.
// 조정 테스트가 "우리 것"(marker 일치)과 "남의 것"(marker 불일치)을 **실제 프로세스**로 만든다.
// 인자는 `node <이 파일> --naia-ego-marker=<값>` 로 넘어와 /proc/<pid>/cmdline 에 그대로 남는다.
setTimeout(() => process.exit(0), 60_000);
