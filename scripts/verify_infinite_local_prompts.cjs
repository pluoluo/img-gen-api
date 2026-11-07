// Local prompt CRUD, offline use and picker integration in disposable browser storage.
const { chromium } = require('../canvas/node_modules/playwright');
const { assertOfflineValidation } = require('./infinite_test_environment.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8770';
const output = 'data/infinite-validation';
const body = '主体与场景：\n盛开的花卉与绿叶。\n\n风格与光影：\n古典油画，柔和自然光。';
const edited = body + '\n\n细节与约束：\n保留“天味食品”原文，不添加水印。';
const online = { id: 'online-fixture', title: '在线来源保留验收', prompt: 'Online prompt fixture', description: '在线来源', tags: ['在线'], coverUrl: '', referenceImageUrls: [] };
const sourceIds = ['banana-prompt-quicker','davidwu-gpt-image2-prompts','freestylefly-gpt-image-2','awesome-gpt-image','awesome-gpt4o-image-prompts','youmind-gpt-image-2','youmind-nano-banana-pro'];
(async () => {
  await assertOfflineValidation(origin);
  execFileSync('venv/bin/python', ['-c', `import json,zipfile
p=dict(id='local-prompt-test',title='本地提示词插入验收',nodes=[dict(id='image-input',type='image',title='图片输入',position=dict(x=100,y=100),width=300,height=240,metadata=dict(model='image-api::gpt-image-2.5-flare',count=1,status='idle'))],connections=[],chatSessions=[],activeChatId=None,backgroundMode='dots',showImageInfo=True,viewport=dict(x=300,y=200,k=1))
with zipfile.ZipFile('data/infinite-validation/local-prompt-canvas.zip','w') as z:z.writestr('projects.json',json.dumps(dict(app='infinite-canvas',version=3,projects=[dict(project=p,files=[])])))`]);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 1050 }, permissions: ['clipboard-read','clipboard-write'] });
    await context.addInitScript(({ sourceIds }) => {
      const key='infinite-canvas:prompt_source_store_v2'; if (localStorage.getItem(key)) return;
      localStorage.setItem(key, JSON.stringify({ state: { sources: [...sourceIds.map(id => ({id,builtIn:true,enabled:false})),{ id:'online-test',name:'在线验收来源',url:'https://fixture.invalid/prompts.json',homepage:'https://fixture.invalid',enabled:true,builtIn:false }],schedule:{intervalMinutes:0,lastFetchedAt:''}},version:0 }));
    }, { sourceIds });
    const page = await context.newPage(); const errors=[], posts=[]; let unavailable=false, sourceRequests=0;
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if(r.method()==='POST') posts.push(r.url()); });
    await page.route('https://fixture.invalid/prompts.json', route => { sourceRequests++; return unavailable ? route.abort() : route.fulfill({ json:[online] }); });
    await page.goto(origin+'/infinite/prompts'); await page.getByRole('heading',{name:online.title,exact:true}).waitFor();
    const local = () => page.getByText('本地提示词库',{exact:true});
    await local().click(); await page.getByText('没有找到匹配的提示词',{exact:true}).waitFor();
    await page.getByRole('button',{name:'新增本地提示词',exact:true}).click();
    const editor = () => page.getByRole('dialog',{name:/^(新增|编辑)本地提示词$/});
    const save = async () => { await editor().getByRole('button',{name:/保\s*存/}).click(); };
    await save(); await editor().getByText('请填写标题',{exact:true}).waitFor(); await editor().getByText('请填写提示词正文',{exact:true}).waitFor();
    await editor().getByRole('textbox',{name:/标题/}).fill('油画花卉模板'); await editor().getByRole('textbox',{name:/提示词正文/}).fill(body);
    await editor().getByRole('combobox',{name:'标签',exact:true}).fill('油画'); await editor().getByRole('combobox',{name:'标签',exact:true}).press('Enter');
    await editor().getByRole('textbox',{name:'备注',exact:true}).fill('本地多段提示词'); await save(); await editor().waitFor({state:'hidden'});
    await page.getByRole('heading',{name:'油画花卉模板',exact:true}).waitFor();
    await page.screenshot({path:output+'/local-prompts-desktop.png',animations:'disabled'});
    await page.reload(); await local().click(); await page.getByRole('heading',{name:'油画花卉模板',exact:true}).waitFor();
    await page.getByPlaceholder('搜索标题、内容或标签').fill('没有匹配项'); await page.getByRole('heading',{name:'油画花卉模板',exact:true}).waitFor({state:'hidden'});
    await page.getByPlaceholder('搜索标题、内容或标签').fill('油画'); await page.getByRole('heading',{name:'油画花卉模板',exact:true}).waitFor();
    await page.getByRole('button',{name:'编辑本地提示词',exact:true}).click(); await editor().getByRole('textbox',{name:/标题/}).fill('油画花卉 · 修订'); await editor().getByRole('textbox',{name:/提示词正文/}).fill(edited); await save(); await editor().waitFor({state:'hidden'});
    await page.getByRole('heading',{name:'油画花卉 · 修订',exact:true}).waitFor();
    const card = page.locator('.ant-card').filter({has:page.getByRole('heading',{name:'油画花卉 · 修订',exact:true})});
    await card.getByRole('button',{name:'复制',exact:true}).click(); assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),edited);
    await page.getByRole('heading',{name:'油画花卉 · 修订',exact:true}).click(); await page.getByRole('dialog').getByText(edited,{exact:true}).waitFor(); await page.keyboard.press('Escape');
    await page.setViewportSize({width:390,height:844}); await page.getByRole('button',{name:'新增本地提示词',exact:true}).click();
    await editor().getByRole('textbox',{name:/标题/}).fill('移动端草稿'); await page.waitForTimeout(350); await page.screenshot({path:output+'/local-prompt-editor-mobile.png',animations:'disabled'});
    await editor().getByRole('button',{name:/取\s*消/}).click(); await page.setViewportSize({width:1500,height:1050});
    unavailable=true;
    await page.goto(origin+'/infinite/image'); await page.getByRole('button',{name:'查看提示词库',exact:true}).click();
    const picker=()=>page.getByRole('dialog',{name:'提示词库',exact:true}); await picker().getByText('本地提示词库',{exact:true}).click(); await picker().getByRole('heading',{name:'油画花卉 · 修订',exact:true}).click();
    await picker().waitFor({state:'hidden'}); assert.equal(await page.locator('textarea').first().inputValue(),edited);
    await page.getByRole('button',{name:'查看提示词库',exact:true}).click(); await picker().getByRole('button',{name:'新增本地提示词',exact:true}).click();
    await editor().getByRole('textbox',{name:/标题/}).fill('选择器新增模板'); await editor().getByRole('textbox',{name:/提示词正文/}).fill('只修改吊顶颜色，保留布局。'); await save(); await editor().waitFor({state:'hidden'});
    await picker().getByRole('heading',{name:'选择器新增模板',exact:true}).click(); assert.equal(await page.locator('textarea').first().inputValue(),'只修改吊顶颜色，保留布局。');
    await page.goto(origin+'/infinite/canvas'); const chooser=page.waitForEvent('filechooser'); await page.getByRole('button',{name:'导入画布',exact:true}).click(); await(await chooser).setFiles(output+'/local-prompt-canvas.zip'); await page.getByRole('heading',{name:'本地提示词插入验收',exact:true}).click();
    await page.locator('[data-node-id="image-input"]').click(); const panel=page.locator('[data-node-panel="image-input"]'); await panel.getByRole('button',{name:'提示词库',exact:true}).click(); await picker().getByText('本地提示词库',{exact:true}).click(); await picker().getByRole('heading',{name:'油画花卉 · 修订',exact:true}).click();
    assert.equal(await panel.getByRole('textbox').innerText(),edited);
    await page.waitForTimeout(1200); // Allow the existing canvas autosave and viewport save to settle.
    await page.waitForFunction(expected => new Promise(resolve => {
      const r=indexedDB.open('infinite-canvas');r.onsuccess=()=>{const db=r.result,tx=db.transaction('app_state'),q=tx.objectStore('app_state').get('infinite-canvas:canvas_store');q.onsuccess=()=>{const state=JSON.parse(q.result||'{}').state;resolve(state?.projects.some(p=>p.nodes.some(n=>n.id==='image-input'&&n.metadata?.prompt===expected)))};tx.oncomplete=()=>db.close()};
    }),edited);
    await page.reload(); await page.locator('[data-node-id="image-input"]').click(); await page.waitForFunction(expected=>document.querySelector('[data-node-panel="image-input"] [contenteditable="true"]')?.innerText===expected,edited);
    await panel.getByRole('button',{name:'提示词库',exact:true}).click(); await picker().getByRole('button',{name:'新增本地提示词',exact:true}).click();
    await editor().getByRole('button',{name:/保\s*存/}).focus(); await page.keyboard.press('Delete'); await editor().getByRole('button',{name:/取\s*消/}).click(); await page.keyboard.press('Escape');
    await page.locator('[data-node-id="image-input"]').waitFor();
    await page.goto(origin+'/infinite/prompts'); await local().click(); await page.getByRole('heading',{name:'油画花卉 · 修订',exact:true}).waitFor();
    const remove=page.locator('.ant-card').filter({has:page.getByRole('heading',{name:'油画花卉 · 修订',exact:true})}).getByRole('button',{name:'删除本地提示词',exact:true});
    await remove.click(); await page.getByRole('button',{name:/取\s*消/}).click(); await page.getByRole('heading',{name:'油画花卉 · 修订',exact:true}).waitFor();
    await remove.click(); await page.locator('.ant-popconfirm').getByRole('button',{name:/删\s*除/}).click(); await page.getByRole('heading',{name:'油画花卉 · 修订',exact:true}).waitFor({state:'hidden'});
    await page.reload(); await local().click(); assert.equal(await page.getByRole('heading',{name:'油画花卉 · 修订',exact:true}).count(),0); await page.getByRole('heading',{name:'选择器新增模板',exact:true}).waitFor();
    const stored=await page.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('infinite-canvas');r.onsuccess=()=>{const db=r.result,tx=db.transaction('local_prompts'),q=tx.objectStore('local_prompts').getAll();q.onsuccess=()=>resolve(q.result);tx.oncomplete=()=>db.close()}})); assert.equal(stored.length,1); assert.equal(stored[0].title,'选择器新增模板'); assert.equal(await page.evaluate(()=>Object.values(localStorage).some(value=>value.includes('选择器新增模板'))),false);
    unavailable=false; await page.getByText('在线验收来源',{exact:true}).click(); await page.getByRole('heading',{name:online.title,exact:true}).waitFor();
    assert.deepEqual(errors,[]); assert.deepEqual(posts,[]);
    const result={createEditDelete:true,requiredFields:true,tagsAndSearch:true,multilineClipboard:true,refreshPersists:true,modalCancelPreserves:true,localAvailableWithoutOnlineSource:true,pickerCanCreate:true,workbenchInsert:true,canvasInsertAndRefresh:true,editorIsolatesCanvasShortcuts:true,onlineSourcePreserved:true,indexedDbOnly:true,remainingLocalPrompts:stored.length,sourceRequests,postRequests:posts,browserErrors:errors};fs.writeFileSync(output+'/local-prompts-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
