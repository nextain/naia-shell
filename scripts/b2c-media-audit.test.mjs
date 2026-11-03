import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditMedia } from './b2c-media-audit.mjs';
test('UC-B2C-026-R6 real codec, alpha, stacked, damage and snapshot evidence', () => {
 const dir = mkdtempSync(join(tmpdir(), 'media-r6-'));
 const ff = args => { const r = spawnSync('ffmpeg', ['-v','error','-y',...args]); assert.equal(r.status, 0, r.stderr.toString()); };
 try {
  // Transparent left half and opaque right half, real VP9 alpha bytes.
  const rgba = Buffer.alloc(16*16*4);
  for(let i=0;i<256;i++){ rgba[i*4]=255; rgba[i*4+3]=i%16<8?0:255; }
  writeFileSync(join(dir,'frame.rgba'),rgba);
  ff(['-f','rawvideo','-pixel_format','rgba','-video_size','16x16','-i',join(dir,'frame.rgba'),'-frames:v','1','-c:v','libvpx-vp9','-pix_fmt','yuva420p',join(dir,'alpha.webm')]);
  ff(['-f','lavfi','-i','color=red:s=16x16:d=0.1','-c:v','libx264','-pix_fmt','yuv420p',join(dir,'opaque.mp4')]);
  const stack=Buffer.alloc(16*32*4,255);
  for(let y=16;y<32;y++)for(let x=0;x<8;x++)for(let c=0;c<3;c++)stack[(y*16+x)*4+c]=0;
  writeFileSync(join(dir,'stack.rgba'),stack);
  ff(['-f','rawvideo','-pixel_format','rgba','-video_size','16x32','-i',join(dir,'stack.rgba'),'-frames:v','1','-c:v','libx264','-pix_fmt','yuv420p',join(dir,'stack.mp4')]);
  const audit=(file,mode,extra={})=>auditMedia({file,mode,expected:'success',...extra},dir);
  assert.equal(audit('alpha.webm','alpha',{codec:'vp9'}).passed,true);
  assert.equal(audit('opaque.mp4','opaque',{codec:'h264'}).passed,true);
  assert.equal(audit('opaque.mp4','alpha').passed,false);
  assert.equal(audit('alpha.webm','opaque').passed,false);
  assert.equal(audit('opaque.mp4','opaque',{codec:'vp9'}).passed,false);
  assert.equal(audit('stack.mp4','stacked').passed,true);
  assert.equal(audit('opaque.mp4','stacked').passed,false);
  writeFileSync(join(dir,'broken.mp4'),'broken bytes');
  writeFileSync(join(dir,'before.json'),'{"theme":"old"}');
  writeFileSync(join(dir,'after.json'),'{"theme":"old"}');
  const fail={expected:'decode-failure',before:'before.json',after:'after.json'};
  assert.equal(audit('broken.mp4','alpha',fail).snapshotPreserved,true);
  assert.equal(audit('opaque.mp4','alpha',fail).passed,false);
  assert.equal(audit('missing.mp4','alpha',fail).passed,false);
  assert.equal(audit('broken.mp4','alpha',{...fail,after:'missing.json'}).passed,false);
  writeFileSync(join(dir,'after.json'),'{"theme":"new"}');
  assert.equal(audit('broken.mp4','alpha',fail).passed,false);
  writeFileSync(join(dir,'input.json'),JSON.stringify({file:'opaque.mp4',mode:'alpha',expected:'success'}));
  const cli=spawnSync(process.execPath,[resolve('scripts/b2c-media-audit.mjs'),join(dir,'input.json')]);
  assert.equal(cli.status,1); assert.equal(JSON.parse(cli.stdout).nativeAcceptance,false);
  writeFileSync(join(dir,'after.json'),'{"theme":"old"}');
  writeFileSync(join(dir,'input.json'),JSON.stringify({file:'broken.mp4',mode:'alpha',...fail}));
  const noTools=spawnSync(process.execPath,[resolve('scripts/b2c-media-audit.mjs'),join(dir,'input.json')],{env:{...process.env,PATH:dir}});
  assert.equal(noTools.status,1); // Missing decoder is never successful expected failure evidence.
  writeFileSync(join(dir,'before.json'),'null'); writeFileSync(join(dir,'after.json'),'null');
  assert.equal(audit('broken.mp4','alpha',fail).passed,false);
  assert.equal(audit('opaque.mp4','bogus').passed,false);
  assert.equal(audit('opaque.mp4','opaque',{expected:'bogus'}).passed,false);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
