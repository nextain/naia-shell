// #824 P04: bounded three-hour isolated CPU soak, exact project ownership.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
const dir=process.env.TMPDIR;
const base=process.env.NAIA_TEST_URL;
const model=process.env.NAIA_TEST_MODEL;
const qualityPath=process.env.NAIA_QUALITY_REPORT ?? `${dir}/r9-persona-report.json`;
assert(qualityPath.startsWith(`${dir}/`) && !qualityPath.split("/").includes(".."));
assert(dir?.startsWith('/') && /^http:\/\/127\.0\.0\.1:\d+$/.test(base));
assert(/^[a-z0-9][a-z0-9._-]*:[a-zA-Z0-9._-]+$/.test(model ?? ''));
assert.equal(process.env.NAIA_TEST_PROJECT, 'naia-026-r9');
const name='naia-026-r9_inference_1';
const inspect=()=>JSON.parse(execFileSync('podman',['inspect',name],{encoding:'utf8'}))[0];
const c=inspect();assert.equal(c.Config.Labels['io.podman.compose.project'],'naia-026-r9');assert(!c.HostConfig.Devices?.length);const cg=readFileSync(`/proc/${c.State.Pid}/cgroup`,'utf8').trim().split(':').at(-1); const memoryMax=Number(readFileSync(`/sys/fs/cgroup${cg}/memory.max`,'utf8')); const cpuMax=readFileSync(`/sys/fs/cgroup${cg}/cpu.max`,'utf8').trim().split(' ').map(Number);assert(memoryMax>0 && memoryMax<=12*1024**3);assert(cpuMax[0]/cpuMax[1]<=4);
const report={startedAt:new Date().toISOString(),model,memoryMax,cpuMax,qualityPath,durationHours:3,scope:'CPU public proxy API streaming/cancel + post-evaluation restart recovery; no UI/OPFS/GPU',container:c.Id,cycles:[],errors:[],status:'running'};
const persist=()=>{writeFileSync(`${dir}/r9-soak-report.json.tmp`,JSON.stringify(report,null,2));renameSync(`${dir}/r9-soak-report.json.tmp`,`${dir}/r9-soak-report.json`)};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const deadline=Date.now()+3*60*60*1000;
persist();
try{while(Date.now()<deadline){
 const start=Date.now(); const row={at:new Date().toISOString(),cycle:report.cycles.length+1};
 try{
 const health=await fetch(`${base}/healthz`,{signal:AbortSignal.timeout(10000)});assert.equal(health.status,200);
 const models=await fetch(`${base}/local-llm/v1/models`,{signal:AbortSignal.timeout(10000)});assert.equal(models.status,200);row.models=(await models.json()).data.map(x=>x.id);assert(row.models.includes(model));
 // Do not interrupt an active quality evaluation. Still record health/resource samples.
 const quality=existsSync(qualityPath)?JSON.parse(readFileSync(qualityPath)):null;
 row.qualityInProgress=!quality?.finishedAt; row.qualityModel=quality?.model; row.qualityTurn=quality?.samples?.length ?? 0;
 if(!row.qualityInProgress){
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),180000);
  try{const res=await fetch(`${base}/local-llm/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:model,messages:[{role:'system',content:'너는 한국어로 말하는 우주 탐험가 나이아야.'},{role:'user',content:'별을 여행하는 이야기를 길게 들려 줘.'}],temperature:0,max_tokens:256,stream:true}),signal:controller.signal});assert.equal(res.status,200);const reader=res.body.getReader();const decoder=new TextDecoder();let content='';let bytes=0;
   while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;content+=decoder.decode(r.value,{stream:true});
    let visible='';for(const line of content.split('\n')){if(!line.startsWith('data:'))continue;try{const delta=JSON.parse(line.slice(5)).choices?.[0]?.delta?.content;if(typeof delta==='string'&&delta.trim()){visible=delta;break;}}catch{}}
    if(visible){row.firstContentMs=Date.now()-start;row.firstContent=visible.slice(0,80);controller.abort();row.cancelled=true;break;}
   }assert(row.cancelled,'No streamed content to cancel');row.streamBytes=bytes;}finally{clearTimeout(timeout);controller.abort();}
  if(row.cycle%6===0){const t=Date.now();execFileSync('podman',['stop','--time','5',name]);execFileSync('podman',['start',name]);execFileSync('podman',['update','--cpus','4','--memory','12g',name]);let ready=false;while(Date.now()-t<30000){try{ready=(await fetch(`${base}/local-llm/v1/models`,{signal:AbortSignal.timeout(2000)})).status===200;}catch{}if(ready)break;await sleep(250);}assert(ready,'Recovery exceeded 30s');row.stopStartMs=Date.now()-t;}
 }
 row.resources=JSON.parse(execFileSync('podman',['stats','--no-stream','--format','json',name],{encoding:'utf8'}));row.passed=true;
 }catch(e){row.error=String(e);report.errors.push({cycle:row.cycle,error:String(e)});}
 row.elapsedMs=Date.now()-start;report.cycles.push(row);persist();console.log(JSON.stringify(row));await sleep(Math.min(120000,Math.max(0,deadline-Date.now())));
}report.coverage={cancelled:report.cycles.filter(c=>c.passed&&c.cancelled).length,restarted:report.cycles.filter(c=>c.passed&&Number.isFinite(c.stopStartMs)).length};assert(report.coverage.cancelled>=10 && report.coverage.restarted>=1,'Insufficient actual inference/cancel/restart coverage');report.status=report.errors.length?'failed':'completed';}catch(e){report.status='failed';report.errors.push({fatal:String(e)});}finally{
 report.finishedAt=new Date().toISOString();persist();
 // This script owns only these exact isolated test containers; retain model files.
 for(const n of ['naia-026-r9_web_1',name,'naia-026-r9_network_1']){try{const item=JSON.parse(execFileSync('podman',['inspect',n],{encoding:'utf8'}))[0];assert.equal(item.Config.Labels['io.podman.compose.project'],'naia-026-r9');execFileSync('podman',['stop','--time','10',n]);}catch(e){report.errors.push({cleanup:n,error:String(e)});}}
 if(report.errors.length) report.status='failed';
 report.cleanupAt=new Date().toISOString();persist();
 if(report.status === "failed") process.exitCode=1;
}
