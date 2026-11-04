// #824 P04: explicit CPU proxy API quality evidence; never auto-select/pull.
import {writeFileSync,readFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
const dir=process.env.TMPDIR;
const base=process.env.NAIA_TEST_URL;
const data=process.env.NAIA_DATA_DIR;
if (!dir?.startsWith('/') || !data?.startsWith('/') || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('Explicit absolute TMPDIR/data and loopback URL required');
const model=process.env.NAIA_TEST_MODEL;
if (!/^[a-z0-9][a-z0-9._-]*:[a-zA-Z0-9._-]+$/.test(model ?? '')) throw Error('Explicit library model:tag required');
const fixture=JSON.parse(readFileSync(new URL('./persona-ko.fixture.json',import.meta.url),'utf8'));
const {system,prompts}=fixture;
const report={startedAt:new Date().toISOString(),promptVersion:fixture.version,model,system,settings:{temperature:0,max_tokens:512,stream:false},prompts,samples:[],scope:'CPU nginx public API; not Worker/UI acceptance'};
const [name,tag]=model.split(':');const manifest=readFileSync(`${data}/models/models/manifests/registry.ollama.ai/library/${name}/${tag}`);report.manifestSha256=createHash('sha256').update(manifest).digest('hex');report.bytes=JSON.parse(manifest).layers.reduce((s,l)=>s+l.size,0);
const persist=()=>{writeFileSync(`${dir}/r9-persona-report.json.tmp`,JSON.stringify(report,null,2));renameSync(`${dir}/r9-persona-report.json.tmp`,`${dir}/r9-persona-report.json`)};
persist();
const messages=[{role:'system',content:system}];
try{for(const [turn,prompt]of prompts.entries()){
 messages.push({role:'user',content:prompt});const start=Date.now();
 const response=await fetch(`${base}/local-llm/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages,...report.settings}),signal:AbortSignal.timeout(300000)});
 if(!response.ok)throw Error(`${response.status}: ${await response.text()}`);
 const body=await response.json();const choice=body.choices[0];report.samples.push({turn:turn+1,prompt,choice,usage:body.usage,elapsedMs:Date.now()-start});messages.push(choice.message);persist();console.log(turn+1,JSON.stringify(choice.message.content));
}report.completed=true;}catch(e){report.error=String(e);process.exitCode=1;}finally{report.finishedAt=new Date().toISOString();persist();}
