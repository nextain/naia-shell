import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test("real ChatArea lazy boundaries and recursive tree at 390px", async ({ page }, testInfo) => {
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const requested = new Set<string>();
	await page.route("**/*", async (route) => {
		const url = new URL(route.request().url());
		if (!["127.0.0.1", "localhost"].includes(url.hostname))
			return route.abort();
		if (url.pathname === "/")
			return route.fulfill({
				contentType: "text/html",
				body: '<html><body><div id="probe"></div></body></html>',
			});
		if (/\/(PermissionModal|ChatMarkdown)\.tsx/.test(url.pathname))
			{ requested.add(url.pathname); await gate; }
		await route.continue();
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await page.evaluate(async () => {
		const load = (path: string) => import(/* @vite-ignore */ path);
		const refresh = await load("/@react-refresh");
		refresh.default.injectIntoGlobalHook(window);
		Object.assign(window, {
			$RefreshReg$: () => {},
			$RefreshSig$: () => (type: unknown) => type,
			__vite_plugin_react_preamble_installed__: true,
		});
		const { default: React } = await load("/node_modules/.vite/deps/react.js");
		const {
			default: { createRoot },
		} = await load("/node_modules/.vite/deps/react-dom_client.js");
		await load("/src/styles/global.css");
 await load("/src/styles/web-mode.css");
		const state = { decision: "", opened: "", selected: "" };
 localStorage.setItem("naia-config", JSON.stringify({provider:"gemini",model:"gemini-test",apiKey:"test",enableTts:false,enableTools:false}));
 let callbackId = 0;
 const callbacks = new Map();
		Object.assign(window, {
			probe: state,
			__TAURI_INTERNALS__: {
 metadata: {currentWindow:{label:"main"},currentWebview:{windowLabel:"main",label:"main"}},
 transformCallback: (fn: unknown) => { const id = ++callbackId; callbacks.set(id, fn); return id; },
 unregisterCallback: (id: number) => callbacks.delete(id),
 convertFileSrc: (path: string) => path,
				invoke: async (command: string, args: { parent: string }) => {
					if (command === "send_to_agent_command") { const message = JSON.parse((args as any).message); if(message.type === "approval_response") state.decision = message.decision; return null; }
 if (command === "plugin:event|listen") return 1;
 if (command === "plugin:store|load") return 1;
 if (command === "plugin:store|get") return [null, false];
 if (command === "read_naia_config") return localStorage.getItem("naia-config");
 if (command === "read_naia_ui_config") return "";
 if (/list_|get_all_facts|read_openclaw_memory_files/.test(command) && command !== "workspace_list_dirs") return [];
 if (command !== "workspace_list_dirs") return null;
					await new Promise((resolve) => setTimeout(resolve, 500));
					const entries: Record<string, unknown[]> = {
						"/work": [{ name: "src", path: "/work/src", is_dir: true }],
						"/work/src": [
							{ name: "nested", path: "/work/src/nested", is_dir: true },
						],
						"/work/src/nested": [
							{
								name: "App.tsx",
								path: "/work/src/nested/App.tsx",
								is_dir: false,
							},
						],
					};
					return entries[args.parent] || [];
				},
			},
		});
		const { appRegistry } = await load("/src/lib/app-registry.ts");
		appRegistry.getApi = () => ({
			openFile: (path: string) => {
				state.opened = path;
			},
		});
        const { ChatArea } = await load("/src/components/ChatArea.tsx");
        const { useChatStore } = await load("/src/stores/chat.ts");
        Object.assign(window, {chatProbeStore:useChatStore});
        useChatStore.setState({messages:[{id:"r9",role:"assistant",content:"파일 /work/src/nested/App.tsx 확인",timestamp:Date.now()}],pendingApproval:{requestId:"r9",toolCallId:"t9",toolName:"read_file",args:{path:"/work/src/nested/App.tsx"},tier:1,description:"Read file"}});

		const { FileTree } = await load("/src/apps/workspace/FileTree.tsx");
		const h = React.createElement;
		const root = createRoot(document.getElementById("probe"));
        root.render(h(React.Fragment, null,
            h("div", {className:"naia-chat-area",style:{position:"relative",width:"100%",height:480}}, h(ChatArea)),
            h("div", {className:"workspace-app",style:{width:"100%"}}, h(FileTree, {workspaceRoot:"/work",openFilePath:"/work/src/nested/App.tsx",onFileSelect:(path:string)=>{state.selected=path;}}))
        ));
	});
    await expect.poll(() => [...requested].filter(p => /ChatMarkdown|PermissionModal/.test(p)).length).toBe(2);
    // The real DeferredChatMarkdown boundary renders its raw-text fallback.
    await expect(page.locator(".message-content")).toContainText("/work/src/nested/App.tsx");
    await expect(page.locator(".message-content p")).toHaveCount(0);
    await expect(page.locator(".permission-modal")).toHaveCount(0);
    release();
    await expect(page.locator(".message-content p")).toBeVisible();
    await expect(page.locator(".permission-modal")).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("r9-permission-390.png"),
	});
	await page.keyboard.press("Alt+n");
	await expect
		.poll(() => page.evaluate(() => (window as any).probe.decision))
		.toBe("reject");
	await page
		.getByRole("button", { name: "/work/src/nested/App.tsx", exact: true })
		.click();
	await expect
		.poll(() => page.evaluate(() => (window as any).probe.opened))
		.toBe("/work/src/nested/App.tsx");
	const file = page.locator(".workspace-tree__node--open");
	await expect(file).toContainText("App.tsx");
	await file.focus();
	await page.keyboard.press("Enter");
	await expect
		.poll(() => page.evaluate(() => (window as any).probe.selected))
		.toBe("/work/src/nested/App.tsx");
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth),
	).toBeLessThanOrEqual(390);
	await page.screenshot({ path: testInfo.outputPath("r9-tree-390.png") });
    await page.evaluate(async () => {
      const load=(path:string)=>import(/* @vite-ignore */path);
      const {createAgentBridge}=await load("/src/lib/web-runtime/agent-bridge.ts");
      const {useChatStore}=await load("/src/stores/chat.ts");
      useChatStore.getState().startStreaming();
      const worker={posted:[] as any[],postMessage(message:unknown,transfer:unknown[]){this.posted.push({message,transfer});},addEventListener(){}};
      const bridge=createAgentBridge({createWorker:()=>worker,emit:(_event:string,raw:string)=>{const chunk=JSON.parse(raw);if(chunk.type==="text")useChatStore.getState().appendStreamChunk(chunk.text);if(chunk.type==="finish")useChatStore.getState().finishStreaming();},getFs:()=>({readText:async()=>null,writeBytes:async()=>{throw new Error("test journal persistence failure");}})});
      bridge.start({model:null});const port=worker.posted[0].transfer[0] as MessagePort;port.start();
      bridge.sendLine(JSON.stringify({type:"chat_request",requestId:"r9-failure",sessionId:"r9-failure",messages:[{role:"user",content:"test"}]}));
      port.postMessage(JSON.stringify({type:"text",requestId:"r9-failure",text:"generated reply"}));
      port.postMessage(JSON.stringify({type:"finish",requestId:"r9-failure"}));
      Object.assign(window,{failureProbePort:port});
    });
    await expect(page.getByTestId("conversation-save-warning")).toBeVisible();
    await expect(page.locator(".chat-message.assistant").last()).toContainText("generated reply");
    expect(await page.evaluate(()=>(window as any).chatProbeStore.getState().messages.some((m:any)=>/Save failed|저장 실패/.test(m.content)))).toBe(false);
    expect(await page.evaluate(()=>!!([...document.querySelectorAll(".chat-message.assistant")].at(-1)!.compareDocumentPosition(document.querySelector('[data-testid="conversation-save-warning"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await page.screenshot({path:testInfo.outputPath("r9-save-failure-390.png")});
    await page.evaluate(()=>{(window as any).failureProbePort.close();(window as any).chatProbeStore.getState().newConversation();});
    await expect(page.getByTestId("conversation-save-warning")).toHaveCount(0);
});

test("OPFS restore confirmation, account isolation and shared transfer lock", async ({ page }, testInfo) => {
 await page.route("**/*", route => {
  const u = new URL(route.request().url());
  if (!["localhost", "127.0.0.1"].includes(u.hostname)) return route.abort();
  if (u.pathname === "/") return route.fulfill({contentType:"text/html",body:'<html><body><div id="probe"></div></body></html>'});
  return route.continue();
 });
 await page.setViewportSize({width:390,height:844});
 await page.goto("/");
 const zip = await page.evaluate(async () => {
  const load = (path:string) => import(/* @vite-ignore */ path);
  const refresh = await load("/@react-refresh");refresh.default.injectIntoGlobalHook(window);
  Object.assign(window, {$RefreshReg$:()=>{}, $RefreshSig$:()=>(type:unknown)=>type,__vite_plugin_react_preamble_installed__:true,__TAURI_INTERNALS__:{invoke:async()=>null}});
  const {default:React}=await load("/node_modules/.vite/deps/react.js");
  const {default:{createRoot}}=await load("/node_modules/.vite/deps/react-dom_client.js");
  await load("/src/styles/global.css");
 await load("/src/styles/web-mode.css");
  const {WebMemoryTransfer}=await load("/src/components/WebMemoryTransfer.tsx");
  const {useChatStore}=await load("/src/stores/chat.ts");
  const {createArchive}=await load("/src/lib/transfer/archive.ts");
  const {restoreWebTransfer}=await load("/src/lib/transfer/restore-web.ts");
  const {downloadWebTransfer,loadTransfer}=await load("/src/lib/transfer/entry.ts");
  const {appendWebConversationMessages}=await load("/src/lib/web-runtime/web-workspace-commands.ts");
  const {createOpfsWebFs}=await load("/src/lib/web-runtime/web-fs.ts");
  const root=await navigator.storage.getDirectory();
  const workspace=await root.getDirectoryHandle("naia-adk",{create:true});
  const docs=await workspace.getDirectoryHandle("docs",{create:true});
  const write=async(dir:FileSystemDirectoryHandle,name:string,text:string)=>{const h=await dir.getFileHandle(name,{create:true});const w=await h.createWritable();await w.write(text);await w.close();};
  await write(docs,"r9.txt","original");
  const other=await (await workspace.getDirectoryHandle("conversations",{create:true})).getDirectoryHandle("u-other",{create:true});
  await write(other,"private.jsonl","other-account-original");
  const text=new TextEncoder().encode("restored");const chunks:Uint8Array[]=[];
  await createArchive({list:async()=>["docs/r9.txt"],async *read(){yield text;}},{write:async(b:Uint8Array)=>{chunks.push(b.slice());}},{shellFormat:"0.2.6",adkFormat:"1"});
  const file=new File(chunks,"r9.zip",{type:"application/zip"});
  Object.assign(window,{transferProbe:{useChatStore,file,restoreWebTransfer,downloadWebTransfer,loadTransfer,appendWebConversationMessages,fs:createOpfsWebFs(()=>navigator.storage.getDirectory()),readDoc:async()=>(await(await docs.getFileHandle("r9.txt")).getFile()).text(),readOther:async()=>(await(await other.getFileHandle("private.jsonl")).getFile()).text()}});
  createRoot(document.getElementById("probe")).render(React.createElement(WebMemoryTransfer));
  return Array.from(new Uint8Array(await file.arrayBuffer()));
 });
 const panel=page.getByTestId("web-memory-transfer");
 await expect(panel).toBeVisible();
 // Forge a valid ZIP/manifest aimed at a different account's namespace.
 const {unzipSync,zipSync,strFromU8,strToU8}=await import("fflate");
 const entries=unzipSync(new Uint8Array(zip));const manifest=JSON.parse(strFromU8(entries["manifest.json"]));
 const old=manifest.files[0].path;const foreign="conversations/u-other/private.jsonl";
 manifest.files[0].path=foreign;entries[`files/${foreign}`]=entries[`files/${old}`];delete entries[`files/${old}`];entries["manifest.json"]=strToU8(JSON.stringify(manifest));
 await page.getByTestId("memory-transfer-import").setInputFiles({name:"foreign.zip",mimeType:"application/zip",buffer:Buffer.from(zipSync(entries))});
 await expect(panel.locator(':scope > [role="alert"]')).toBeVisible();
 expect(await page.evaluate(()=>(window as any).transferProbe.readOther())).toBe("other-account-original");
 await page.getByTestId("memory-transfer-import").setInputFiles({name:"r9.zip",mimeType:"application/zip",buffer:Buffer.from(zip)});
 await expect(page.locator("dialog[open]")).toBeVisible();
 await page.evaluate(()=>{const p=(window as any).transferProbe;const get=p.useChatStore.getState;p.useChatStore.getState=()=>{p.useChatStore.getState=get;return {...get(),isStreaming:true};};(document.querySelector('[data-testid="memory-transfer-restore"]') as HTMLButtonElement).click();p.useChatStore.getState=get;});
 await expect(page.locator('dialog[open] [role="status"]')).toBeEmpty();
 expect(await page.evaluate(()=>(window as any).transferProbe.readDoc())).toBe("original");
 await page.evaluate(()=>(window as any).transferProbe.useChatStore.setState({isStreaming:true}));
 await expect(page.getByTestId("memory-transfer-restore")).toBeDisabled();
 await expect(page.locator('dialog[open] [role="status"]')).not.toBeEmpty();
 expect(await page.evaluate(()=>(window as any).transferProbe.readDoc())).toBe("original");
 expect(await page.evaluate(async()=>{const p=(window as any).transferProbe;try{await p.restoreWebTransfer(p.file);return "allowed";}catch(e){return String(e);}})).toContain("chat busy");
 await page.screenshot({path:testInfo.outputPath("r9-restore-wait-390.png")});
 await page.evaluate(()=>(window as any).transferProbe.useChatStore.setState({isStreaming:false}));
 await expect(page.locator('dialog[open] [role="status"]')).toBeEmpty();
 await page.getByTestId("memory-transfer-restore").click();
 await expect(page.locator('dialog[open] [role="status"]')).toContainText(/완료|restor/i);
 expect(await page.evaluate(()=>(window as any).transferProbe.readDoc())).toBe("restored");
 expect(await page.evaluate(()=>(window as any).transferProbe.readOther())).toBe("other-account-original");
 await page.screenshot({path:testInfo.outputPath("r9-restore-success-390.png")});
 // Hold the exact transaction lock; both real append and export must queue behind it.
 await page.evaluate(async()=>{
  const p=(window as any).transferProbe;p.appended=false;p.exported=false;
  let acquired!:()=>void;const locked=new Promise<void>(r=>{acquired=r;});
  p.held=navigator.locks.request("naia-memory-transfer",()=>new Promise<void>(release=>{p.release=release;acquired();}));await locked;
  p.append=p.appendWebConversationMessages("u-r9",[{role:"user",content:"after restore",timestamp:1}],p.fs).then(()=>{p.appended=true;});
  p.export=p.loadTransfer().then((t:unknown)=>p.downloadWebTransfer(t,"naia-adk/conversations")).then(()=>{p.exported=true;});
 });
 await page.waitForTimeout(200);
 expect(await page.evaluate(()=>[(window as any).transferProbe.appended,(window as any).transferProbe.exported])).toEqual([false,false]);
 const downloaded=page.waitForEvent("download");
 await page.evaluate(async()=>{const p=(window as any).transferProbe;p.release();await Promise.all([p.held,p.append,p.export]);});
 const archivePath=testInfo.outputPath("r9-serialized-export.zip");
 await (await downloaded).saveAs(archivePath);
 const {readFile}=await import("node:fs/promises");
 expect(Object.keys(unzipSync(await readFile(archivePath)))).toContain("files/conversations/u-r9.jsonl");
 expect(await page.evaluate(()=>[(window as any).transferProbe.appended,(window as any).transferProbe.exported])).toEqual([true,true]);
 expect(await page.evaluate(async()=>{const p=(window as any).transferProbe;return p.fs.readText("naia-adk/conversations/u-r9.jsonl");})).toContain("after restore");
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});


test("automatic mapped-account and in-flight append regression", async ({baseURL}, info) => {
 const output=dirname(info.outputPath("r9-account-transfer-report.json"));mkdirSync(output,{recursive:true});
 execFileSync(process.execPath,[fileURLToPath(new URL("../../../scripts/builds/webgpu-container/account-transfer.spec.mjs",import.meta.url))],{env:{...process.env,TMPDIR:output,NAIA_TEST_URL:baseURL,NAIA_WEB_SOURCE_DIR:fileURLToPath(new URL("../../../",import.meta.url))},timeout:45000});
});
