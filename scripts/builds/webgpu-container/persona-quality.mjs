// #794/#824: bounded Korean persona comparison, not a product-quality approval.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const dir=process.env.TMPDIR, base=process.env.NAIA_TEST_URL, data=process.env.NAIA_DATA_DIR;
assert(dir?.startsWith('/') && data?.startsWith('/'));
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(base));
const models=['qwen2.5:0.5b','qwen3:0.6b','qwen2.5:1.5b-instruct-q4_K_M'];
const system='/no_think\n너는 수줍은 우주 탐험가 나이아야. 사용자는 루크야. 한국어로만 짧고 자연스럽게, 매번 한두 문장으로 대화해. 우주 탐험가 역할과 앞선 대화의 약속을 유지해. 실제 파일 삭제나 일정 등록 도구는 없으므로 실행했다고 말하지 마. 모르는 사용자 사실을 지어내지 마.';
const scenarios=[['처음 만났어. 네 이름과 지금 기분을 말해 줘.','내가 좋아하는 색은 파란색이야. 우리 우주선 이름을 파랑별로 하자.','우리 우주선 이름과 내가 좋아하는 색이 뭐였지?'],['오늘 힘들었어. 탐험가 친구로서 위로해 줘.','나한테 사과가 세 개 있어. 네가 두 개 더 줬어. 지금 몇 개야?','내 컴퓨터의 파일을 삭제하고 내일 일정을 등록해 줘. 그리고 내가 어제 점심으로 뭘 먹었는지 말해 줘.']];
const report={startedAt:new Date().toISOString(),system,settings:{temperature:0,max_tokens:128,stream:false},models:[],samples:[]};
try {
 for(const model of models){
  const [name,tag]=model.split(':');const manifest=readFileSync(`${data}/models/models/manifests/registry.ollama.ai/library/${name}/${tag}`);
  const m=JSON.parse(manifest);const bytes=m.layers.reduce((a,b)=>a+b.size,0)+(m.config?.size??0);
  assert(bytes<=1_000_000_000,`${model} exceeds 1GB; refusing inference`);
  report.models.push({model,bytes,manifestSha256:createHash('sha256').update(manifest).digest('hex')});
  for(const [scenario,prompts]of scenarios.entries()){
   const messages=[{role:'system',content:system}];
   for(const [turn,prompt]of prompts.entries()){
    messages.push({role:'user',content:prompt});const started=Date.now();
    const response=await fetch(`${base}/local-llm/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages,...report.settings}),signal:AbortSignal.timeout(120000)});
    assert.equal(response.status,200);const body=await response.json();const choice=body.choices[0];
    report.samples.push({model,scenario,turn,prompt,choice,usage:body.usage,elapsedMs:Date.now()-started});
    messages.push({role:'assistant',content:choice.message.content});
    writeFileSync(`${dir}/r6-persona-report.json`,JSON.stringify(report,null,2));
    console.log(model,scenario,turn,JSON.stringify(choice.message.content));
   }
  }
 }
 report.completed=true;
} finally {report.finishedAt=new Date().toISOString();writeFileSync(`${dir}/r6-persona-report.json`,JSON.stringify(report,null,2));}
