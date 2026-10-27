import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Book, type BookHandle } from "./Book";
import { assetUrl } from "./assets";
import { createBrowserAudioController, type TarotAudioController } from "./audio";
import { FALLBACK_TAROT_CARDS } from "./data/fallbackCards";
import type { DrawnCard } from "./data/types";
import { normalizeAppLocale, appText, type AppLocale } from "./i18n";
import { drawCelticCross, type TarotReading } from "./reading";
import { createTarotToolHandler } from "./tools";
import { ui } from './ui';
import "./tarot.css";

function TarotApp() {
 const [locale,setLocale]=useState<AppLocale>(()=>normalizeAppLocale(navigator.language.split('-')[0]));
 const [reading,setReading]=useState<TarotReading|null>(null); const readingRef=useRef<TarotReading|null>(null);
 const [screen,setScreen]=useState<'table'|'book'>('table'); const screenRef=useRef(screen); screenRef.current=screen;
 const [finished,setFinished]=useState(false); const [selected,setSelected]=useState<DrawnCard|null>(null);
 const [anchor,setAnchor]=useState({left:0,top:0});
 const meaningDrag=useRef<number|null>(null);
 const [notice,setNotice]=useState(''); const [muted,setMuted]=useState(false); const book=useRef<BookHandle>(null);
 const audio=useRef<TarotAudioController|null>(null); const ko=locale==='ko'; const t=(a:string,b:string)=>ko?a:b;
 function store(r:TarotReading){readingRef.current=r;setReading(r)}
 function showNotice(s:string){setNotice(s);window.setTimeout(()=>setNotice(''),3500)}
 useEffect(()=>{const bgm=new Audio(assetUrl('sounds/taro-bgm.mp3')); const a=createBrowserAudioController(bgm,()=>{}); audio.current=a; void a.startBgm(); const retry=()=>{if(!a.isMuted)void a.startBgm()}; window.addEventListener('pointerdown',retry,{once:true}); return()=>{window.removeEventListener('pointerdown',retry);a.dispose()}},[]);
 const handler=useRef<(args:Record<string,unknown>)=>unknown>(()=>({}));
 handler.current=createTarotToolHandler({
  getReading:()=>readingRef.current,
  startReading:(question,spread)=>{const r=drawCelticCross(question,Math.random,Date.now(),spread);store(r);setFinished(false);setScreen('table');setSelected(null);return r},
  setReading:store,onReveal:()=>{void audio.current?.playFlip()},finish:()=>{setFinished(true);setScreen('table')},
  openStory:(card,part)=>{let item=typeof card==='number'?FALLBACK_TAROT_CARDS.find(c=>c.id===card):FALLBACK_TAROT_CARDS.find(c=>c.nameEn.toLowerCase()===String(card).toLowerCase()||c.nameKr===card||String(c.id)===card); if(!item && card!==undefined)throw Error('Card not found'); setScreen('book'); return book.current!.open(item ? (part===1?2:25)+item.id : 0) as unknown as Record<string,unknown>},
  readAloud:()=>{setScreen('book');return book.current!.read() as unknown as Record<string,unknown>},stopReading:()=>book.current!.stop(),status:()=>({screen:screenRef.current,spread:readingRef.current?.spread??null,revealed:readingRef.current?.cards.filter(c=>c.isFlipped).length??0,total:readingRef.current?.cards.length??0,finished})
 });
 useEffect(()=>{const onMessage=async(e:MessageEvent)=>{if(e.source!==window.parent||!e.data||typeof e.data!=='object')return; const m=e.data;if(m.type==='naia-app:locale'&&typeof m.locale==='string'){const l=normalizeAppLocale(m.locale);setLocale(l);document.documentElement.lang=l;document.documentElement.dir=l==='ar'?'rtl':'ltr';return} if(m.type==='naia-tool-call'&&m.tool==='skill_cafelua_tarot'&&typeof m.id==='string'){try{const result=await handler.current(m.args??{});window.parent.postMessage({type:'naia-tool-result',id:m.id,result},e.origin||'*')}catch(error){window.parent.postMessage({type:'naia-tool-result',id:m.id,error:error instanceof Error?error.message:String(error)},e.origin||'*')}}}; window.addEventListener('message',onMessage);return()=>window.removeEventListener('message',onMessage)},[]);
 const cards=reading?.cards??[]; const last=cards.filter(c=>c.isFlipped).length; const current=last?cards[last-1]:null;
 const displayName=(c:DrawnCard)=>ko?c.card.nameKr:c.card.nameEn; const position=(c:DrawnCard)=>ko?c.position.nameKr:c.position.nameEn;
 return <main className="tarot-app" style={{backgroundImage:`linear-gradient(180deg,rgba(0,0,0,.34),rgba(0,0,0,.12) 45%,rgba(0,0,0,.52)),url('${assetUrl('lounge-background-img/lounge-night.webp')}')`}}>
 <div className={screen==='table'?'table-screen':'table-screen hidden'}>
 <header className="table-header"><strong>{reading?(reading.question||ui(locale,'today')):appText(locale,'title')}</strong><div><button aria-label={appText(locale,'stories')} onClick={()=>{setScreen('book');void book.current?.open(0)}}>▤</button><button aria-label={muted?appText(locale,'unmute'):appText(locale,'mute')} aria-pressed={muted} onClick={()=>{audio.current?.setMuted(!muted);setMuted(!muted)}}>{muted?'♩':'♫'}</button></div></header>
 <section className={`table-area ${reading?.spread==='three'?'three':'celtic'}`} aria-label={ui(locale,'table')}>
 {!reading?<div className="deck">{[0,1,2,3].map(i=><img key={i} src={assetUrl('tarot/card-back.webp')} alt={i===3?t('덮인 카드 더미','Deck of cards'):''} />)}</div>:cards.map((c,i)=><div className={`card-place card-${i+1}`} key={c.card.id}><button className={`card ${c.isFlipped?'flipped':''} ${!finished&&last===i+1?'current':''}`} aria-label={`${position(c)}: ${c.isFlipped?displayName(c):ui(locale,'faceDown')}`} onClick={(event)=>c.isFlipped?(setAnchor({left:event.currentTarget.getBoundingClientRect().left,top:event.currentTarget.getBoundingClientRect().top}),setSelected(c)):showNotice(ui(locale,'nextHint'))}><img className={c.isFlipped&&c.isReversed?'reversed':''} src={assetUrl(c.isFlipped?c.card.imagePath:'tarot/card-back.webp')} alt="" /></button><span>{i===0&&reading.spread!=='three'?t('현재 / 장애','Present / Challenge'):i===1&&reading.spread!=='three'?'':position(c)}</span></div>)}
 </section>
 <footer className={`table-footer ${finished?'summary':''}`} role="status">{finished?<><div>{ui(locale,'storyCards')}</div><div className="story-buttons">{cards.map(c=><button key={c.card.id} onClick={()=>{setScreen('book');void book.current?.open(2+c.card.id)}}><img src={assetUrl(c.card.imagePath)} alt="" />{displayName(c)}</button>)}</div><small>{ui(locale,'newQuestion')}</small></>:notice||!reading?<>{notice||ui(locale,'prompt')} {!notice&&<small>{ui(locale,'examples')}</small>}</>:current?<>{last} / {cards.length} · {position(current)} · {displayName(current)} ({current.isReversed?appText(locale,'reversed'):appText(locale,'upright')})</>:ui(locale,'laid')}</footer>
 {selected&&<div className="meaning-overlay" onClick={()=>setSelected(null)}><section role="dialog" aria-label={displayName(selected)} className="meaning" style={window.innerWidth>=720?{position:"absolute",left:Math.min(window.innerWidth-296,anchor.left+75),top:Math.max(0,Math.min(window.innerHeight-280,anchor.top-48))}:undefined} onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==="Escape")setSelected(null)}} onPointerDown={e=>{if(window.innerWidth<720 && e.clientY-e.currentTarget.getBoundingClientRect().top<30){meaningDrag.current=e.clientY;e.currentTarget.setPointerCapture(e.pointerId)}}} onPointerUp={e=>{if(meaningDrag.current!==null && e.clientY-meaningDrag.current>40)setSelected(null);meaningDrag.current=null}}><button className="meaning-close" onClick={()=>setSelected(null)} aria-label={ui(locale,'close')}>×</button><img src={assetUrl(selected.card.imagePath)} alt=""/><div><h2>{selected.card.id}. {displayName(selected)}</h2><p>{selected.card.keywords.join(' · ')}</p><b>{appText(locale,'upright')}</b><p>{selected.card.upright.join(' · ')}</p><b>{appText(locale,'reversed')}</b><p>{selected.card.reversed.join(' · ')}</p></div></section></div>}
 </div><div className={`book-layer ${screen==='book'?'':'hidden'}`}><Book ref={book} locale={locale} onBack={()=>setScreen('table')} /></div>
 </main>
}
createRoot(document.getElementById('root')!).render(<TarotApp/>);
