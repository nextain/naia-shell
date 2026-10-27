import functools, json, os, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[2]/'dist-cafelua-tarot'
out=Path('/var/home/luke/alpha-adk/.agents/progress/naia-appstore-dev-demo-20261027/shots-tarot-012')
class Handler(SimpleHTTPRequestHandler):
 def translate_path(self,path):
  decoded=unquote(path).split('?',1)[0]
  if decoded=='/host': return str(root/'host-test.html')
  if decoded.startswith('/apps/land.naia.cafelua-tarot/'): return str(root/decoded.removeprefix('/apps/land.naia.cafelua-tarot/'))
  return str(root/decoded.lstrip('/'))
 def log_message(self,*args): pass
# Host page is in memory: the package output is not edited for this test.
 def do_GET(self):
  if self.path=='/host':
   html=b'''<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;background:#15131a;color:#eee;font:14px sans-serif;display:flex}aside{display:none;width:340px;padding:20px}body.chat aside{display:block}iframe{border:0;width:100%;height:100vh}body.chat iframe{width:calc(100% - 340px)}.bubble{padding:14px;background:#39334a;margin:14px 0;border-radius:9px}</style></head><body><aside><strong>Naia</strong><div class="bubble">\xea\xb3\xa0\xeb\xaf\xbc\xec\x9d\x84 \xec\x9d\xb4\xec\x95\xbc\xea\xb8\xb0\xed\x95\xb4 \xec\xa3\xbc\xec\x84\xb8\xec\x9a\x94.</div><div class="bubble" id="chat-text"></div></aside><iframe sandbox="allow-scripts allow-same-origin" src="/apps%2Fland.naia.cafelua-tarot/index.html"></iframe><script>let n=0,pending={};onmessage=e=>{let m=e.data;if(m.type==='naia-tool-result'&&pending[m.id]){pending[m.id](m);delete pending[m.id]}};window.callTool=(args)=>new Promise(resolve=>{let id=String(++n);pending[id]=resolve;document.querySelector('iframe').contentWindow.postMessage({type:'naia-tool-call',id,tool:'skill_cafelua_tarot',args},'*')});window.locale=()=>document.querySelector('iframe').contentWindow.postMessage({type:'naia-app:locale',locale:'ko'},'*');</script></body></html>'''
   self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.end_headers();self.wfile.write(html)
  else: super().do_GET()
server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
records={}
with sync_playwright() as p:
 browser=p.chromium.launch();page=browser.new_page(viewport={'width':960,'height':640},locale='ko-KR');errs=[];bad=[]
 page.on('pageerror',lambda e:errs.append(str(e)));page.on('console',lambda m:errs.append(m.text) if m.type=='error' else None);page.on('response',lambda r:bad.append(f'{r.status} {r.url}') if r.status>=400 else None)
 page.goto(f'http://127.0.0.1:{server.server_port}/host');page.wait_for_timeout(1000);page.evaluate('locale()');page.wait_for_timeout(1000)
 frame=page.frame_locator('iframe')
 def call(args):
  r=page.evaluate('(a)=>callTool(a)',args)
  if 'error' in r: raise Exception(str(r))
  return r['result']
 def shot(name):
  page.screenshot(path=str(out/name));records[name]={'console_errors':len(errs),'http_errors':len(bad),'errors':list(errs),'http':list(bad)}
 shot('01-table.png');call({'action':'start_reading','question':'요즘 일이 손에 안 잡혀요','spread':'celtic'});page.wait_for_timeout(500);shot('02-spread.png')
 for i in range(3): call({'action':'reveal_next'})
 page.wait_for_timeout(600);page.evaluate("document.body.classList.add('chat');document.querySelector('#chat-text').textContent='이 카드는 지금의 자리와 앞선 카드의 흐름을 함께 살펴보게 합니다.'");page.set_viewport_size({'width':1300,'height':640});page.wait_for_timeout(400);shot('03-reveal.png')
 page.evaluate("document.body.classList.remove('chat')");page.set_viewport_size({'width':960,'height':640});frame.locator('.card.flipped').last.click();shot('04-meaning.png');frame.locator('.meaning-close').click()
 for i in range(7): call({'action':'reveal_next'})
 call({'action':'get_reading'});call({'action':'finish'});page.wait_for_timeout(600);shot('05-finish.png')
 opened=call({'action':'open_story','card':0,'part':1});read=call({'action':'read_aloud'});assert read['text']; first=read['page']
 page.evaluate("document.body.classList.add('chat')");page.evaluate('(s)=>document.querySelector("#chat-text").textContent=s',read['text']);page.set_viewport_size({'width':1300,'height':640});page.wait_for_timeout(800);shot('06-book-reading.png')
 for i in range(30):
  read=call({'action':'read_aloud'})
  if read['page']>first: break
 else: raise AssertionError('read_aloud did not advance page')
 assert call({'action':'stop_reading'})['page']>=first
 page.evaluate("document.body.classList.remove('chat')");page.set_viewport_size({'width':390,'height':760});frame.get_by_role('button',name='← 탁자로 돌아가기').click();page.reload();page.wait_for_timeout(1000);page.evaluate('locale()');page.wait_for_timeout(1000);shot('07-narrow-table.png');call({'action':'start_reading','spread':'celtic'});page.wait_for_timeout(500);shot('08-narrow-spread.png');call({'action':'open_story','card':0});page.wait_for_timeout(500);shot('09-narrow-book.png')
 browser.close()
server.shutdown();(out/'capture-results.json').write_text(json.dumps(records,ensure_ascii=False,indent=2));print(json.dumps(records,ensure_ascii=False,indent=2))
