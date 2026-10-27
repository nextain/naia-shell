import { expect, test } from '@playwright/test';

test('Naia leads a reading and reads the original book across pages', async ({ page }) => {
  await page.setViewportSize({width:960,height:640});
  await page.goto('/index.html');
  await page.evaluate(() => {window.postMessage({type:'naia-app:locale',locale:'ko'},'*')});
  async function call(args:Record<string,unknown>) {
    return page.evaluate(async (args) => {
      const id=String(Math.random());
      return await new Promise<Record<string,any>>((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('Tool timed out')),15000);
        const listener=(e:MessageEvent)=>{if(e.data?.type==='naia-tool-result'&&e.data.id===id){clearTimeout(timer);window.removeEventListener('message',listener);resolve(e.data)}};
        window.addEventListener('message',listener);
        window.postMessage({type:'naia-tool-call',id,tool:'skill_cafelua_tarot',args},'*');
      });
    },args);
  }
  await expect(page.getByText('나이아에게 고민을 말해 보세요.')).toBeVisible();
  expect((await call({action:'reveal_next'})).error).toBeTruthy();
  expect((await call({action:'start_reading',spread:'celtic'})).result.total).toBe(10);
  await expect(page.locator('.card')).toHaveCount(10);
  await page.locator('.card-3 .card').click();
  await expect(page.getByText("나이아에게 '다음'이라고 말해 보세요.")).toBeVisible();
  for(let i=0;i<10;i++) expect((await call({action:'reveal_next'})).result.number).toBe(i+1);
  await page.locator('.card.flipped').last().click(); await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'닫기'}).click();
  expect((await call({action:'get_reading'})).result.cards).toHaveLength(10);
  await call({action:'finish'}); await expect(page.locator('.story-buttons button')).toHaveCount(10);
  expect((await call({action:'open_story',card:0})).result.chapter_title).toBeTruthy();
  const first=(await call({action:'read_aloud'})).result; expect(first.text.length).toBeGreaterThan(0);
  await expect(page.locator('.naia-reading-highlight').first()).toBeVisible();
  const original = await page.locator('.naia-reading-highlight').evaluateAll(nodes => nodes.map(node => document.querySelector(`.library-reader-measure-source p[data-reader-paragraph="${(node as HTMLElement).dataset.readerParagraph}"]`)?.textContent));
  expect(first.text).toBe(original.join('\n\n'));
  let next=first; for(let i=0;i<30&&next.page===first.page;i++) next=(await call({action:'read_aloud'})).result;
  expect(next.page).toBeGreaterThan(first.page); expect((await call({action:'stop_reading'})).result.page).toBe(next.page);
  await expect(page.locator('.naia-reading-highlight')).toHaveCount(0);
  expect((await call({action:'read_aloud'})).result).toEqual({stopped:true});
  await call({action:'open_story',card:0}); await call({action:'read_aloud'});
  await page.getByRole('button',{name:'멈춤',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:"나이아에게 '그만'이라고 말해 보세요."})).toBeVisible();
  await expect(page.locator('.naia-reading-highlight')).toHaveCount(0);
  expect((await call({action:'read_aloud'})).result).toEqual({stopped:true});
  await page.setViewportSize({width:390,height:760}); await page.getByRole('button',{name:'← 탁자로 돌아가기'}).click();
  expect((await call({action:'start_reading',spread:'three'})).result.total).toBe(3);
  await expect(page.locator('.card')).toHaveCount(3);
  await expect(page.locator('.table-area')).toBeVisible();
  await call({action:'reveal_next'}); await page.locator('.card.flipped').click();
  const dialog=page.getByRole('dialog'); await expect(dialog).toBeVisible();
  const box=await dialog.boundingBox(); if(!box) throw new Error('Missing meaning panel');
  await page.mouse.move(box.x+box.width/2,box.y+12); await page.mouse.down();
  await page.mouse.move(box.x+box.width/2,box.y+75); await page.mouse.up(); await expect(dialog).toHaveCount(0);
  await call({action:'open_story',card:0});
  await expect(page.locator('.book-icon').first()).toBeVisible();
});
