// The canvas sidebar must share existing local records and its original text-node insertion path.
const { chromium } = require('../canvas/node_modules/playwright');
const { assertOfflineValidation } = require('./infinite_test_environment.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8770';
const output = 'data/infinite-validation';
const original = '主体与场景：\n花卉静物。\n\n风格与光影：\n油画，柔和自然光。';
const changed = '修改内容：\n将吊顶改为暖黄色。\n\n保留内容：\n保留“天味食品”原文与展台布局。';
const sourceIds = ['banana-prompt-quicker','davidwu-gpt-image2-prompts','freestylefly-gpt-image-2','awesome-gpt-image','awesome-gpt4o-image-prompts','youmind-gpt-image-2','youmind-nano-banana-pro'];
async function project(page) {
 return page.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('infinite-canvas');r.onsuccess=()=>{const db=r.result,tx=db.transaction('app_state'),q=tx.objectStore('app_state').get('infinite-canvas:canvas_store');q.onsuccess=()=>resolve(JSON.parse(q.result||'{}').state?.projects[0]);tx.oncomplete=()=>db.close()}}));
}
async function saved(page, predicate) { for(let i=0;i<80;i++){const value=await project(page);if(value&&predicate(value))return value;await page.waitForTimeout(100)}throw Error('Canvas did not persist expected insertion'); }
(async()=>{
 await assertOfflineValidation(origin);
 execFileSync('venv/bin/python',['-c',`import json,zipfile
p=dict(id='sidebar-prompts',title='侧栏提示词验收',nodes=[],connections=[],chatSessions=[],activeChatId=None,backgroundMode='dots',showImageInfo=True,viewport=dict(x=300,y=200,k=1))
with zipfile.ZipFile('data/infinite-validation/sidebar-prompts.zip','w') as z:z.writestr('projects.json',json.dumps(dict(app='infinite-canvas',version=3,projects=[dict(project=p,files=[])])))`]);
 const browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:1500,height:1000}});
  await context.addInitScript(({sourceIds})=>{const key='infinite-canvas:prompt_source_store_v2';if(!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify({state:{sources:[...sourceIds.map(id=>({id,builtIn:true,enabled:false})),{id:'sidebar-online',name:'在线验收来源',url:'https://fixture.invalid/sidebar.json',homepage:'https://fixture.invalid',enabled:true,builtIn:false}],schedule:{intervalMinutes:0,lastFetchedAt:''}},version:0}))},{sourceIds});
  const page=await context.newPage();const errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(r.url())});
  await page.route('https://fixture.invalid/sidebar.json',r=>r.fulfill({json:[{id:'remote-fixture',title:'在线模板保留',prompt:'Remote fixture',description:'',tags:[],coverUrl:'',referenceImageUrls:[]}]}));
  await page.goto(origin+'/infinite/prompts');await page.getByRole('button',{name:'新增本地提示词',exact:true}).click();
  const editor=()=>page.getByRole('dialog',{name:/^(新增|编辑)本地提示词$/});
  const save=async()=>{await editor().getByRole('button',{name:/保\s*存/}).click();await editor().waitFor({state:'hidden'})};
  await editor().getByRole('textbox',{name:/标题/}).fill('原有本地模板');await editor().getByRole('textbox',{name:/提示词正文/}).fill(original);await save();
  await page.goto(origin+'/infinite/canvas');const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'导入画布',exact:true}).click();await(await chooser).setFiles(output+'/sidebar-prompts.zip');await page.getByRole('heading',{name:'侧栏提示词验收',exact:true}).click();const projectUrl=page.url();
  const openSidebar=async()=>{await page.locator('aside').getByRole('button',{name:'提示词库',exact:true}).click();await page.locator('[data-canvas-prompt-library]').waitFor()};await openSidebar();
  const side=()=>page.locator('[data-canvas-prompt-library]');const local=()=>side().locator('[data-prompt-source="local-library"]');
  const row=title=>local().locator('[data-prompt-id]').filter({has:page.getByText(title,{exact:true})});
  await row('原有本地模板').waitFor();assert.equal(await local().locator('[data-prompt-id]').count(),1);
  await row('原有本地模板').getByRole('button',{name:'插入画布',exact:true}).click();const inserted=await saved(page,p=>p.nodes.some(n=>n.type==='text'&&n.metadata?.content===original));const text=inserted.nodes.find(n=>n.type==='text');assert.equal(text.title,'原有本地模板');
  await page.locator(`[data-node-toolbar="${text.id}"]`).getByRole('button',{name:'生成图片',exact:true}).click();
  const referenced=await saved(page,p=>p.nodes.some(n=>n.type==='config')&&p.connections.some(c=>c.fromNodeId===text.id));assert.equal(referenced.connections.find(c=>c.fromNodeId===text.id).toNodeId,referenced.nodes.find(n=>n.type==='config').id);
  await side().getByRole('button',{name:'新增本地提示词',exact:true}).click();await editor().getByRole('textbox',{name:/标题/}).fill('侧栏新增模板');await editor().getByRole('textbox',{name:/提示词正文/}).fill('保留主体，仅修改光线。');await save();await row('侧栏新增模板').waitFor();
  await row('侧栏新增模板').getByRole('button',{name:'编辑本地提示词',exact:true}).click();await editor().getByRole('textbox',{name:/标题/}).fill('侧栏修订模板');await editor().getByRole('textbox',{name:/提示词正文/}).fill(changed);await save();await row('侧栏修订模板').waitFor();
  await side().getByPlaceholder('搜索提示词').fill('不存在的内容');await row('侧栏修订模板').waitFor({state:'hidden'});await side().getByPlaceholder('搜索提示词').fill('吊顶');await row('侧栏修订模板').waitFor();await side().getByPlaceholder('搜索提示词').fill('');
  await row('侧栏修订模板').getByRole('button',{name:'查看详情',exact:true}).click();await page.getByRole('dialog',{name:'侧栏修订模板',exact:true}).getByText(changed,{exact:true}).waitFor();await page.keyboard.press('Escape');
  await page.screenshot({path:output+'/sidebar-local-prompts.png',animations:'disabled'});
  await side().locator('[data-prompt-source="sidebar-online"]').getByRole('button',{name:/在线验收来源/}).click();const remote=side().locator('[data-prompt-source="sidebar-online"]');await remote.getByText('在线模板保留',{exact:true}).waitFor();assert.equal(await remote.getByRole('button',{name:'编辑本地提示词',exact:true}).count(),0);
  await page.goto(origin+'/infinite/prompts');await page.getByText('本地提示词库',{exact:true}).click();await page.getByRole('heading',{name:'侧栏修订模板',exact:true}).waitFor();
  await page.goto(projectUrl);await openSidebar();await row('侧栏修订模板').waitFor();await row('原有本地模板').waitFor();assert.ok((await project(page)).nodes.some(n=>n.type==='text'&&n.metadata?.content===original));
  await row('侧栏修订模板').getByRole('button',{name:'删除本地提示词',exact:true}).click();await page.locator('.ant-popconfirm').getByRole('button',{name:/取\s*消/}).click();await row('侧栏修订模板').waitFor();
  await row('侧栏修订模板').getByRole('button',{name:'删除本地提示词',exact:true}).click();await page.locator('.ant-popconfirm').getByRole('button',{name:/删\s*除/}).click();await row('侧栏修订模板').waitFor({state:'hidden'});await row('原有本地模板').waitFor();
  await page.setViewportSize({width:390,height:844});await side().getByRole('button',{name:'新增本地提示词',exact:true}).click();await editor().getByRole('textbox',{name:/标题/}).fill('侧栏手机草稿');await page.waitForTimeout(350);await page.screenshot({path:output+'/sidebar-local-editor-mobile.png',animations:'disabled'});await editor().getByRole('button',{name:/取\s*消/}).click();
  assert.deepEqual(errors,[]);assert.deepEqual(posts,[]);const result={existingLocalRecordsVisible:true,localExpandedByDefault:true,sidebarCreateEditDelete:true,cancelDelete:true,searchAndDetails:true,insertedTextNode:true,multilinePreserved:true,textConnectedToImageConfig:true,sharedWithPromptCenter:true,refreshPersists:true,onlineSourcePreserved:true,postRequests:posts,browserErrors:errors};fs.writeFileSync(output+'/sidebar-local-prompts-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
