// Native clipboard acceptance in a disposable browser, without paid generation.
const { chromium } = require('../canvas/node_modules/playwright');
const { assertOfflineValidation } = require('./infinite_test_environment.cjs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8770';
const output = 'data/infinite-validation';
async function read(page) {
  return page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('infinite-canvas');
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('app_state');
      const result = tx.objectStore('app_state').get('infinite-canvas:canvas_store');
      result.onsuccess = () => resolve(JSON.parse(result.result || '{}').state?.projects[0]);
      tx.oncomplete = () => db.close();
    };
  }));
}
async function saved(page, count) {
  for (let i = 0; i < 80; i++) {
    const project = await read(page);
    if (project?.nodes.length === count) return project;
    await page.waitForTimeout(100);
  }
  throw new Error('Expected '+count+' persisted nodes, got '+(await read(page))?.nodes.length);
}
(async () => {
  await assertOfflineValidation(origin);
  execFileSync('venv/bin/python', ['scripts/create_infinite_archive_fixture.py']);
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext({viewport:{width:1600,height:1000},permissions:['clipboard-read','clipboard-write']});
    const source = await context.newPage();
    await source.goto(origin+'/infinite/config.js');
    const page = await context.newPage();
    // Prove that canvas pasting works without the permission-gated async Clipboard API.
    await page.addInitScript(() => Object.defineProperty(navigator,'clipboard',{value:undefined,configurable:true}));
    const errors=[], posts=[];
    page.on('pageerror', e=>errors.push(e.message));
    page.on('request', r=>{if(r.method()==='POST')posts.push(r.url());});
    await page.goto(origin+'/infinite/canvas');
    const chooser=page.waitForEvent('filechooser');
    await page.getByRole('button',{name:'导入画布',exact:true}).click();
    await (await chooser).setFiles(output+'/archive-complete.zip');
    await page.getByRole('heading',{name:'迁移验收画布',exact:true}).click();
    await page.locator('[data-node-id="fixture-image"] img').first().evaluate(img=>img.decode());
    await page.keyboard.press('Escape');
    await page.locator('body').click({position:{x:1300,y:780}});
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    const copied=await saved(page,8);
    assert.equal(copied.connections.length,4);
    await page.keyboard.press('Escape');
    const writeImage=async()=>{
      await source.bringToFront();
      await source.evaluate(async()=>{
        const c=document.createElement('canvas');c.width=128;c.height=96;
        const ctx=c.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,64,96);
        const blob=await new Promise(resolve=>c.toBlob(resolve));
        await navigator.clipboard.write([new ClipboardItem({'image/png':blob,'text/plain':new Blob(['image fallback text'],{type:'text/plain'})})]);
      });
      await page.bringToFront();
    };
    const writeText=async(text)=>{
      await source.bringToFront();await source.evaluate(text=>navigator.clipboard.writeText(text),text);await page.bringToFront();
    };
    await writeImage();await page.keyboard.press('Control+v');
    let state=await saved(page,9);
    const image=state.nodes.find(n=>!copied.nodes.some(old=>old.id===n.id));
    assert.equal(image.type,'image');assert.equal(image.metadata.naturalWidth,128);assert.equal(image.metadata.naturalHeight,96);
    assert.equal(image.metadata.mimeType,'image/png');
    const content=await page.evaluate(key=>new Promise(resolve=>{
      const r=indexedDB.open('infinite-canvas');r.onsuccess=()=>{
        const db=r.result,tx=db.transaction('image_files'),q=tx.objectStore('image_files').get(key);
        q.onsuccess=async()=>{
          const bitmap=await createImageBitmap(q.result),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;
          const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);
          resolve({red:Array.from(ctx.getImageData(10,10,1,1).data),transparent:Array.from(ctx.getImageData(100,10,1,1).data)});
        };tx.oncomplete=()=>db.close();
      };
    }),image.metadata.storageKey);
    assert.deepEqual(content,{red:[255,0,0,255],transparent:[0,0,0,0]});
    await page.keyboard.press('Escape');await page.waitForTimeout(250);
    await page.keyboard.press('Control+z');await saved(page,8);
    await page.keyboard.press('Control+Shift+z');await saved(page,9);
    await page.keyboard.press('Escape');
    await writeText('外部复制的文字');await page.keyboard.press('Control+v');
    state=await saved(page,10);assert.equal(state.nodes.at(-1).metadata.content,'外部复制的文字');
    await page.keyboard.press('Escape');
    const foreignMarkerAllowed=await page.evaluate(()=>{
      const data=new DataTransfer();data.setData('application/x-infinite-canvas-nodes','nodes');
      return document.body.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
    });
    assert.equal(foreignMarkerAllowed,true);assert.equal((await read(page)).nodes.length,10);
    const text=page.locator('[data-node-id="fixture-text"]');
    await text.dblclick({position:{x:70,y:65}});
    const editor=text.locator('textarea');await editor.fill('输入框：');
    await writeText('正常粘贴');await editor.focus();await editor.press('End');await page.keyboard.press('Control+v');
    assert.equal(await editor.inputValue(),'输入框：正常粘贴');await page.keyboard.press('Escape');
    await saved(page,10);
    // Images must not create nodes while an input, contenteditable, or dialog owns the paste.
    await page.evaluate(()=>{
      for(const html of ['<textarea id="paste-test-input"></textarea>','<div id="paste-test-editable" contenteditable="true"></div>','<div role="dialog"><button id="paste-test-dialog">Dialog</button></div>'])document.body.insertAdjacentHTML('beforeend',html);
    });
    await writeImage();
    for(const id of ['paste-test-input','paste-test-editable','paste-test-dialog']) {
      await page.locator('#'+id).focus();await page.keyboard.press('Control+v');
      await page.waitForTimeout(200);assert.equal((await read(page)).nodes.length,10);
    }
    await page.evaluate(()=>{
      document.querySelector('#paste-test-input').remove();document.querySelector('#paste-test-editable').remove();document.querySelector('#paste-test-dialog').parentElement.remove();document.activeElement?.blur();
    });
    await page.keyboard.press('Escape');await page.locator('body').click({position:{x:1300,y:780}});
    // Multi-image file payloads retain their original MIME and bytes.
    const cancelled=await page.evaluate(()=>{
      const d=new DataTransfer();for(const name of ['one','two'])d.items.add(new File(['<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><circle cx="40" cy="30" r="20" fill="blue"/></svg>'],name+'.svg',{type:'image/svg+xml'}));
      return !document.body.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));
    });
    assert.equal(cancelled,true);state=await saved(page,12);
    const added=state.nodes.filter(n=>['one.svg','two.svg'].includes(n.title));assert.equal(added.length,2);
    assert.ok(Math.abs(added[1].position.x-added[0].position.x-36)<1e-6);
    assert.ok(added.every(n=>n.metadata.mimeType==='image/svg+xml'&&n.metadata.naturalWidth===80));
    await page.reload();state=await saved(page,12);
    await page.locator(`[data-node-id="${image.id}"] img`).first().evaluate(img=>img.decode());
    assert.equal(state.nodes.find(n=>n.id===image.id).metadata.storageKey,image.metadata.storageKey);
    assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);
    await page.screenshot({path:output+'/clipboard-desktop.png'});
    const result={nativeKeyboardPaste:true,asyncClipboardUnavailable:true,imagePriorityAfterNodeCopy:true,transparentPixels:true,undoRedo:true,textPaste:true,inputAndDialogIsolation:true,multipleImages:true,refresh:true,errors,posts};
    fs.writeFileSync(output+'/clipboard-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
