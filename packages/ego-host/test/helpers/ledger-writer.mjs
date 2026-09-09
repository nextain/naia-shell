// #582 S2c — 장부를 쉬지 않고 저장하는 자식 프로세스.
// 테스트가 이 프로세스를 아무 때나 SIGKILL 하고 `spaces.json` 이 여전히 온전한지 본다.
// 원자적 저장(임시 파일 + rename)이 아니면 언젠가는 반쯤 쓰인 파일에서 죽는다.
import { createLedger } from "../../src/supervisor/ledger.mjs";

const adkDir = process.argv[2];
if (!adkDir) {
  console.error("사용법: ledger-writer.mjs <adkDir>");
  process.exit(2);
}

const ledger = createLedger({ adkDir });
let n = 0;
// 큰 이름을 쓴다. 쓰기 한 번이 길수록 "쓰는 도중"에 걸릴 확률이 커진다.
const padding = "가".repeat(4096);
for (;;) {
  n += 1;
  await ledger.create(`공간-${n}-${padding}`);
  if (n % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
}
