import { Inflate, Zip, ZipPassThrough, strToU8 } from "fflate";
import { MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, type TransferManifest, validateManifest } from "./manifest";
import { assertTransferPath, validateMemoryStore } from "./policy";
import { hasSensitiveFields, sanitizeSettings } from "./sanitize";

export interface TransferLimits { files: number; fileBytes: number; totalBytes: number; archiveBytes: number; ratio: number; chunkBytes: number }
export interface TransferSource { list(): Promise<string[]>; read(path: string): AsyncIterable<Uint8Array> }
export interface ArchiveSource { size: number; read(offset: number, length: number): AsyncIterable<Uint8Array> }
export interface ArchiveOutput { write(chunk: Uint8Array): Promise<void> }
export interface TemporaryWriter<T> { open(path: string): Promise<T>; write(handle: T, chunk: Uint8Array): Promise<void>; commit(handles: T[]): Promise<void>; discard(handles: T[]): Promise<void> }
const defaults: TransferLimits = { files: MAX_FILES, fileBytes: MAX_FILE_BYTES, totalBytes: MAX_TOTAL_BYTES, archiveBytes: MAX_TOTAL_BYTES, ratio: 100, chunkBytes: 65536 };
// Parsed files and the ZIP central directory are read in full; ordinary files stream in chunks.
export const PARSED_FILE_LIMIT = 64 * 1024 * 1024;
const memoryPath = "naia-settings/memory/store.json";
const settingsPaths = new Set(["naia-settings/config.json", "naia-settings/ui-config.json"]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const json = (b: Uint8Array): unknown => JSON.parse(decoder.decode(b));
const special = (path: string) => path === memoryPath || settingsPaths.has(path);
function limitsFor(partial: Partial<TransferLimits> = {}): TransferLimits {
  const limits = { ...defaults, ...partial };
  for (const key of Object.keys(limits) as (keyof TransferLimits)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > defaults[key]) throw new Error("invalid limit");
  return limits;
}
// Incremental SHA-256 keeps a single 64-byte block regardless of file size.
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
class Sha256 {
  private h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  private block = new Uint8Array(64); private used = 0; private length = 0; private w = new Uint32Array(64);
  private compress(b: Uint8Array, p: number) {
    const w = this.w, r = (v: number, n: number) => (v >>> n) | (v << (32 - n));
    for (let i=0;i<16;i++) w[i] = ((b[p+i*4]<<24)|(b[p+i*4+1]<<16)|(b[p+i*4+2]<<8)|b[p+i*4+3]) >>> 0;
    for (let i=16;i<64;i++) { const x=w[i-15], y=w[i-2]; w[i]=(w[i-16]+(r(x,7)^r(x,18)^(x>>>3))+w[i-7]+(r(y,17)^r(y,19)^(y>>>10)))>>>0; }
    let [a,b0,c,d,e,f,g,h]=this.h;
    for (let i=0;i<64;i++) { const t1=(h+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0, t2=((r(a,2)^r(a,13)^r(a,22))+((a&b0)^(a&c)^(b0&c)))>>>0; h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b0;b0=a;a=(t1+t2)>>>0; }
    const v=[a,b0,c,d,e,f,g,h]; for(let i=0;i<8;i++) this.h[i]=(this.h[i]+v[i])>>>0;
  }
  update(data: Uint8Array) { this.length += data.length; let p=0; if(this.used){ const n=Math.min(64-this.used,data.length); this.block.set(data.subarray(0,n),this.used); this.used+=n;p=n; if(this.used===64){this.compress(this.block,0);this.used=0;} } while(p+64<=data.length){this.compress(data,p);p+=64;} if(p<data.length){this.block.set(data.subarray(p),0);this.used=data.length-p;} }
  digest(): string { const bits=this.length*8; this.block[this.used++]=0x80; if(this.used>56){this.block.fill(0,this.used);this.compress(this.block,0);this.used=0;} this.block.fill(0,this.used,56); const view=new DataView(this.block.buffer); view.setUint32(56,Math.floor(bits/0x100000000),false);view.setUint32(60,bits>>>0,false);this.compress(this.block,0);return Array.from(this.h,n=>n.toString(16).padStart(8,"0")).join(""); }
}
function join(chunks: Uint8Array[], size: number): Uint8Array { const b=new Uint8Array(size); let p=0; for(const c of chunks){b.set(c,p);p+=c.length;} return b; }
async function collect(source: AsyncIterable<Uint8Array>, max: number, chunkMax: number, reason = "buffer limit exceeded"): Promise<Uint8Array> { const chunks: Uint8Array[]=[];let size=0;for await(const c of source){if(c.length>chunkMax)throw new Error("chunk too large");if((size+=c.length)>max)throw new Error(reason);chunks.push(c.slice());}return join(chunks,size); }
function metadata(path: string, bytes: Uint8Array): number | null { if(path===memoryPath)return validateMemoryStore(json(bytes)); if(settingsPaths.has(path)&&hasSensitiveFields(json(bytes)))throw new Error("sensitive settings");return null; }

export async function createArchive(source: TransferSource, output: ArchiveOutput, format: { shellFormat: string; adkFormat: string }, requested?: Partial<TransferLimits>): Promise<{ manifest: TransferManifest; removed: number }> {
  const limits=limitsFor(requested), paths=await source.list(), names=new Set<string>(), entries: TransferManifest["files"]=[];
  if(paths.length>limits.files)throw new Error("too many files");
  // Check every parsed input and directory name before emitting any ZIP bytes.
  let directoryBytes = 46 + strToU8("manifest.json").length;
  // Bound the future manifest with the longest possible numeric fields and hashes.
  let manifestBytes = strToU8(JSON.stringify({schemaVersion:"naia-transfer-v1",exportedAt:new Date().toISOString(),...format,files:[],fileCount:limits.files,totalBytes:limits.totalBytes,memoryFacts:limits.totalBytes,conversationFiles:limits.files})).length;
  const parsedFiles = new Map<string, Uint8Array>(); let preflightRemoved = 0, preflightMemoryFacts: number | null = null;
  if(manifestBytes>PARSED_FILE_LIMIT)throw new Error("manifest exceeds 64 MiB parsed-file limit");
  for (const path of paths) {
    assertTransferPath(path); const key=path.toLowerCase(); if(names.has(key))throw new Error("duplicate path"); names.add(key);
    for(let p=key.indexOf("/");p!==-1;p=key.indexOf("/",p+1)) if(names.has(key.slice(0,p)))throw new Error("file and directory collision");
    for(const prior of names)if(prior.startsWith(`${key}/`))throw new Error("file and directory collision");
    const nameBytes = strToU8(`files/${path}`).length;
    if(nameBytes>65535)throw new Error("zip path too long");
    directoryBytes += 46 + nameBytes;
    manifestBytes += strToU8(JSON.stringify({path,size:limits.fileBytes,sha256:"0".repeat(64)})).length + 1;
    if(manifestBytes>PARSED_FILE_LIMIT)throw new Error("manifest exceeds 64 MiB parsed-file limit");
    if(directoryBytes>PARSED_FILE_LIMIT)throw new Error("central directory exceeds 64 MiB parsed-file limit");
    if(special(path)) {
      let data=await collect(source.read(path),Math.min(PARSED_FILE_LIMIT,limits.fileBytes),limits.chunkBytes,`parsed file exceeds limit: ${path}`);
      if(settingsPaths.has(path)){const clean=sanitizeSettings(json(data));preflightRemoved+=clean.removed;data=strToU8(JSON.stringify(clean.value));}
      if(data.length>PARSED_FILE_LIMIT||data.length>limits.fileBytes)throw new Error(`parsed file exceeds limit: ${path}`);
      const count=metadata(path,data);if(path===memoryPath)preflightMemoryFacts=count;
      parsedFiles.set(path,data);
    }
  }
  let totalBytes=0, removed=preflightRemoved, memoryFacts=preflightMemoryFacts, conversationFiles=0, archiveBytes=0;
  let queue: Uint8Array[]=[]; let zipError: Error|undefined;
  const zip=new Zip((err,chunk)=>{if(err)zipError=err;else queue.push(chunk);});
  const flush=async()=>{if(zipError)throw zipError;for(const chunk of queue){if((archiveBytes+=chunk.length)>limits.archiveBytes)throw new Error("archive too large");await output.write(chunk);}queue=[];};
  for(const path of paths){
    let chunks: AsyncIterable<Uint8Array>;
    if(special(path)) {
      const data=parsedFiles.get(path)!;
      chunks=(async function*(){for(let p=0;p<data.length;p+=limits.chunkBytes)yield data.subarray(p,p+limits.chunkBytes);})();
    } else chunks=source.read(path);
    const file=new ZipPassThrough(`files/${path}`);zip.add(file);await flush();const sha=new Sha256();let size=0;
    for await(const chunk of chunks){if(chunk.length>limits.chunkBytes)throw new Error("chunk too large");size+=chunk.length;totalBytes+=chunk.length;if(size>limits.fileBytes||totalBytes>limits.totalBytes)throw new Error("bundle too large");sha.update(chunk);file.push(chunk);await flush();}
    file.push(new Uint8Array(0),true);await flush(); entries.push({path,size,sha256:sha.digest()});
    if(path.startsWith("conversations/")&&path.endsWith(".jsonl"))conversationFiles++;
  }
  const manifest: TransferManifest={schemaVersion:"naia-transfer-v1",exportedAt:new Date().toISOString(),...format,files:entries,fileCount:entries.length,totalBytes,memoryFacts,conversationFiles};validateManifest(manifest);
  const data=strToU8(JSON.stringify(manifest));if(data.length>PARSED_FILE_LIMIT)throw new Error("manifest too large");const file=new ZipPassThrough("manifest.json");zip.add(file);await flush();for(let p=0;p<data.length;p+=limits.chunkBytes){file.push(data.subarray(p,p+limits.chunkBytes));await flush();}file.push(new Uint8Array(0),true);await flush();zip.end();await flush();return {manifest,removed};
}
interface Entry { path: string; method: number; size: number; compressed: number; offset: number; flags: number; crc: number; local: number; end: number }
async function range(source: ArchiveSource, offset: number, length: number, limits: TransferLimits): Promise<Uint8Array> { if(offset<0||length<0||offset+length>source.size)throw new Error("truncated zip");const b=await collect(source.read(offset,length),length,limits.chunkBytes);if(b.length!==length)throw new Error("truncated zip");return b; }
async function parseZip(source: ArchiveSource, limits: TransferLimits): Promise<Entry[]> {
  if(!Number.isSafeInteger(source.size)||source.size>limits.archiveBytes||source.size<22)throw new Error("archive too large or truncated");
  const tail=await range(source,source.size-22,22,limits), tv=new DataView(tail.buffer);if(tv.getUint32(0,true)!==0x06054b50||tv.getUint16(20,true)||tv.getUint16(4,true)||tv.getUint16(6,true))throw new Error("invalid zip end");
  const count=tv.getUint16(10,true), size=tv.getUint32(12,true), start=tv.getUint32(16,true);if(size>PARSED_FILE_LIMIT)throw new Error("central directory exceeds 64 MiB parsed-file limit");if(tv.getUint16(8,true)!==count||count<1||count>limits.files+1||start+size!==source.size-22)throw new Error("invalid central directory");
  const dir=await range(source,start,size,limits), v=new DataView(dir.buffer), u16=(p:number)=>{if(p<0||p+2>dir.length)throw new Error("truncated directory");return v.getUint16(p,true);},u32=(p:number)=>{if(p<0||p+4>dir.length)throw new Error("truncated directory");return v.getUint32(p,true);};
  let cursor=0,total=0;const entries: Entry[]=[],names=new Set<string>();
  for(let i=0;i<count;i++){
    if(u32(cursor)!==0x02014b50)throw new Error("invalid central entry");const flags=u16(cursor+8), method=u16(cursor+10),crc=u32(cursor+16),compressed=u32(cursor+20),expanded=u32(cursor+24),nl=u16(cursor+28),el=u16(cursor+30),cl=u16(cursor+32),disk=u16(cursor+34),attrs=u32(cursor+38),local=u32(cursor+42),next=cursor+46+nl+el+cl;
    if(next>size||!nl||el||cl||disk||(flags&~0x808)||(method!==0&&method!==8)||(((attrs>>>16)&0xf000)===0xa000))throw new Error("unsupported zip entry");
    const path=decoder.decode(dir.subarray(cursor+46,cursor+46+nl));if(path!=="manifest.json"){if(!path.startsWith("files/"))throw new Error("invalid path");assertTransferPath(path.slice(6));}const key=path.toLowerCase();if(names.has(key))throw new Error("duplicate path");names.add(key);
    if((path==="manifest.json"||special(path.slice(6)))&&expanded>PARSED_FILE_LIMIT)throw new Error(`parsed file exceeds 64 MiB limit: ${path}`);
    if(expanded>(path==="manifest.json"?PARSED_FILE_LIMIT:limits.fileBytes)||(expanded>0&&(!compressed||expanded/compressed>limits.ratio)))throw new Error("zip limits exceeded");if(path!=="manifest.json"&&(total+=expanded)>limits.totalBytes)throw new Error("zip total exceeded");
    const head=await range(source,local,30,limits),h=new DataView(head.buffer);if(h.getUint32(0,true)!==0x04034b50||h.getUint16(6,true)!==flags||h.getUint16(8,true)!==method||h.getUint16(26,true)!==nl||h.getUint16(28,true)!==0)throw new Error("local entry mismatch");
    if(!(flags&8)&&(h.getUint32(14,true)!==crc||h.getUint32(18,true)!==compressed||h.getUint32(22,true)!==expanded))throw new Error("local entry mismatch");
    if(decoder.decode(await range(source,local+30,nl,limits))!==path)throw new Error("local path mismatch");const offset=local+30+nl;let end=offset+compressed;
    if(flags&8){const descriptor=await range(source,end,16,limits),d=new DataView(descriptor.buffer);if(d.getUint32(0,true)!==0x08074b50||d.getUint32(4,true)!==crc||d.getUint32(8,true)!==compressed||d.getUint32(12,true)!==expanded)throw new Error("invalid descriptor");end+=16;}
    if(end>start)throw new Error("entry overlaps directory");entries.push({path,method,size:expanded,compressed,offset,flags,crc,local,end});cursor=next;
  }
  if(cursor!==size||!names.has("manifest.json"))throw new Error("zip directory mismatch");let pos=0;for(const e of entries.slice().sort((a,b)=>a.local-b.local)){if(e.local!==pos)throw new Error("unlisted or overlapping entry");pos=e.end;}if(pos!==start)throw new Error("unlisted local entry");return entries;
}
async function scanEntry(source: ArchiveSource, entry: Entry, limits: TransferLimits, onChunk?: (chunk: Uint8Array)=>Promise<void>): Promise<{hash:string; metadata:Uint8Array|null}> {
  const sha=new Sha256(), chunks:Uint8Array[]=[], capture=entry.path==="manifest.json"||special(entry.path.slice(6));let size=0,pending:Uint8Array[]=[];
  const append=(chunk:Uint8Array)=>{size+=chunk.length;if(size>entry.size)throw new Error("expanded size mismatch");sha.update(chunk);if(capture){if(size>PARSED_FILE_LIMIT)throw new Error("parsed file exceeds 64 MiB limit");chunks.push(chunk.slice());}if(onChunk)pending.push(chunk);};
  const inflate=entry.method===8?new Inflate(append):null;let consumed=0;
  for await(const data of source.read(entry.offset,entry.compressed)){
    if(data.length>limits.chunkBytes || (consumed+=data.length)>entry.compressed)throw new Error("invalid archive chunk");
    // Small compressed inputs bound the amount inflate can emit per push.
    for(let p=0;p<data.length;p+=1024){const part=data.subarray(p,p+1024);if(inflate)inflate.push(part,false);else append(part);for(const out of pending)await onChunk!(out);pending=[];}
  }
  if(consumed!==entry.compressed)throw new Error("truncated zip");if(inflate){inflate.push(new Uint8Array(0),true);for(const out of pending)await onChunk!(out);}if(size!==entry.size)throw new Error("expanded size mismatch");return {hash:sha.digest(),metadata:capture?join(chunks,size):null};
}
export async function validateArchive(source: ArchiveSource, requested?: Partial<TransferLimits>): Promise<{manifest:TransferManifest;memoryStatus:"present"|"web-long-term-memory-absent"}> {
  const limits=limitsFor(requested),entries=await parseZip(source,limits),byPath=new Map(entries.map(e=>[e.path,e])),me=byPath.get("manifest.json");if(!me)throw new Error("manifest missing");
  const manifest=validateManifest(json((await scanEntry(source,me,limits)).metadata!));if(manifest.fileCount>limits.files||manifest.totalBytes>limits.totalBytes||manifest.files.length+1!==entries.length)throw new Error("manifest mismatch");let memoryFacts:number|null=null;
  for(const item of manifest.files){const e=byPath.get(`files/${item.path}`);if(!e||e.size!==item.size)throw new Error("manifest file mismatch");const result=await scanEntry(source,e,limits);if(result.hash!==item.sha256)throw new Error("hash mismatch");if(result.metadata){const count=metadata(item.path,result.metadata);if(item.path===memoryPath)memoryFacts=count;}}
  if(memoryFacts!==manifest.memoryFacts)throw new Error("memory count mismatch");return {manifest,memoryStatus:memoryFacts===null?"web-long-term-memory-absent":"present"};
}
export async function extractArchive<T>(source: ArchiveSource, writer: TemporaryWriter<T>, requested?: Partial<TransferLimits>) {
  const validated=await validateArchive(source,requested),limits=limitsFor(requested),entries=await parseZip(source,limits),byPath=new Map(entries.map(e=>[e.path,e])),handles:T[]=[];
  try { for(const item of validated.manifest.files){const e=byPath.get(`files/${item.path}`);if(!e||e.size!==item.size)throw new Error("archive changed");const handle=await writer.open(item.path);handles.push(handle);const result=await scanEntry(source,e,limits,chunk=>writer.write(handle,chunk));if(result.hash!==item.sha256)throw new Error("archive changed");if(result.metadata)metadata(item.path,result.metadata);}await writer.commit(handles); }
  catch(error){await writer.discard(handles);throw error;}return validated;
}
