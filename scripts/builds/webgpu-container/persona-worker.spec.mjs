// #824 P04: actual UI -> Worker -> local proxy -> model -> DOM and OPFS.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
const dir=process.env.TMPDIR,base=process.env.NAIA_TEST_URL,source=process.env.NAIA_WEB_SOURCE_DIR,model=process.env.NAIA_TEST_MODEL;
assert(dir?.startsWith('/')&&source?.startsWith('/')&&/^http:\/\/127\.0\.0\.1:\d+$/.test(base));
assert(/^[a-z0-9][a-z0-9._-]*:[a-zA-Z0-9._-]+$/.test(model??''));
const fixture=JSON.parse(readFileSync(new URL('./persona-ko.fixture.json',import.meta.url),'utf8'));
const {chromium,expect}=createRequire(`${source}/packages/shell/package.json`)('@playwright/test');
const report={startedAt:new Date().toISOString(),model,promptVersion:fixture.version,uiProfile:fixture.uiProfile,system:fixture.system,prompts:fixture.prompts,scope:'Actual packaged UI/Worker/nginx/CPU model/DOM/OPFS; unmodified requests, no GPU/device approval',samples:[],errors:[]};
const persist=()=>{writeFileSync(`${dir}/r9-worker-persona-report.json.tmp`,JSON.stringify(report,null,2));renameSync(`${dir}/r9-worker-persona-report.json.tmp`,`${dir}/r9-worker-persona-report.json`);};
persist();
const browser=await chromium.launch({args:['--no-sandbox']});
let page;
try{
 const context=await browser.newContext({viewport:{width:1024,height:900}});
 await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 page=await context.newPage();page.on('pageerror',e=>report.errors.push(String(e)));
 await page.goto(base);
 await page.waitForFunction(()=>window.__NAIA_WEB_ADK_STATUS__&&window.__NAIA_WEB_ADK_STATUS__().phase!=='checking',null,{timeout:60000});
 if(await page.evaluate(()=>window.__NAIA_WEB_ADK_STATUS__().phase)==='needs-setup')await page.getByTestId('web-workspace-start-default').click();
 await page.waitForFunction(()=>window.__NAIA_WEB_ADK_STATUS__().phase==='ready',null,{timeout:60000});
 await page.evaluate(async({system,model})=>{
  const root=await navigator.storage.getDirectory();const ws=await root.getDirectoryHandle('naia-adk');const settings=await ws.getDirectoryHandle('naia-settings');const file=await settings.getFileHandle('config.json');const c=JSON.parse(await(await file.getFile()).text());
  Object.assign(c,{provider:'local-container',model,persona:system,personaDisabled:false,agentName:'나이아',userName:'루크',locale:'ko',speechStyle:'formal',ttsEnabled:false,enableTools:false,enableThinking:false,webAutoDefaultModel:false,onboardingComplete:true});
  c.llmRoles={...(c.llmRoles??{}),main:{...(c.llmRoles?.main??{}),provider:'local-container',model,apiKey:''}};
  const w=await file.createWritable();await w.write(JSON.stringify(c));await w.close();
 },{system:fixture.system,model});
 await page.reload();await page.waitForFunction(()=>window.__NAIA_WEB_ADK_STATUS__?.().phase==='ready',null,{timeout:60000});
 await page.locator('.app-bar-settings').click();await page.locator('[data-settings-tab="brain"]').click();
 await page.locator('#provider-select').selectOption('local-container');
 const models=page.getByTestId('local-container-models').locator('select');await expect(models).toBeVisible();await models.selectOption(model);
 await expect(page.locator('#tools-toggle')).toBeDisabled();await expect(page.locator('#tools-toggle')).not.toBeChecked();
 await page.locator('.app-bar-settings').click();
 const input=page.locator('.naia-chat-area .chat-input');await expect(input).toBeEnabled({timeout:60000});
 const requests=[];page.on('request',r=>{if(r.url().endsWith('/local-llm/v1/chat/completions')){requests.push(r.postDataJSON());report.requests=requests;persist();}});
 for(const [i,prompt]of fixture.prompts.entries()){
  report.activeTurn=i+1;persist();
  const count=await page.locator('.chat-message.assistant:not(.streaming)').count();const start=Date.now();
  const responseEvent=page.waitForResponse(r=>r.url().endsWith('/local-llm/v1/chat/completions'),{timeout:300000});
  await input.fill(prompt);await input.press('Enter');const response=await responseEvent;assert.equal(response.status(),200);
  await expect(page.locator('.chat-message.assistant:not(.streaming)')).toHaveCount(count+1,{timeout:300000});
  await expect(page.locator('.chat-cancel-btn')).toHaveCount(0,{timeout:300000});
  const bubble=page.locator('.chat-message.assistant:not(.streaming)').last();await expect(bubble.locator('.message-content')).toBeVisible();
  const content=await bubble.locator('.message-content').innerText();
  let wire='';let streamCaptureError;try{wire=await response.text();}catch(e){streamCaptureError=String(e);}
  const frames=wire.split('\n').filter(l=>l.startsWith('data:')).flatMap(l=>{try{return[JSON.parse(l.slice(5))];}catch{return[];}});
  const request=requests.at(-1);assert.equal(request.model,model);assert.equal(request.temperature,0);assert(!request.tools?.length);assert(content.trim());
  const finish=frames.flatMap(f=>f.choices??[]).find(c=>c.finish_reason)?.finish_reason;
  report.samples.push({turn:i+1,prompt,content,request,finishReason:finish??"dom-committed",streamCaptureError,usage:frames.findLast(f=>f.usage)?.usage,elapsedMs:Date.now()-start});persist();console.log(i+1,JSON.stringify(content));
 }
 report.persisted=await page.evaluate(async()=>{const root=await navigator.storage.getDirectory();const ws=await root.getDirectoryHandle('naia-adk');const conv=await ws.getDirectoryHandle('conversations');const rows=[];for await(const[name,h]of conv.entries()){if(h.kind==='file'&&name.endsWith('.jsonl'))rows.push(...(await(await h.getFile()).text()).trim().split('\n').filter(Boolean).map(JSON.parse));}return rows;});
 assert(report.persisted.length>=44);assert(report.samples.every(s=>['stop','dom-committed'].includes(s.finishReason)));
 assert.equal(report.errors.length,0);report.completed=true;
 await page.screenshot({path:`${dir}/r9-worker-persona-final.png`});
}catch(e){report.error=String(e);if(page){report.lastDom=await page.content().catch(()=>"unavailable");await page.screenshot({path:`${dir}/r9-worker-persona-failure.png`}).catch(()=>{});}process.exitCode=1;}finally{report.finishedAt=new Date().toISOString();persist();await browser.close();}
