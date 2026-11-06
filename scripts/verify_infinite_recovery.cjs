// Uses fixture tasks; never calls a paid model endpoint.
const { chromium } = require('../canvas/node_modules/playwright');
const {assertOfflineValidation}=require('./infinite_test_environment.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8770';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
async function readNodes(page) {
 return page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('infinite-canvas');
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
   const db = open.result;
   const req = db.transaction('app_state').objectStore('app_state').get('infinite-canvas:canvas_store');
   req.onsuccess = () => { const value = JSON.parse(req.result || '{}'); resolve(value.state?.projects[0]?.nodes || []); db.close(); };
   req.onerror = () => reject(req.error);
  };
 }));
}
(async () => {
 await assertOfflineValidation(origin);
  const browser = await chromium.launch({ headless: true });
 const summaries = [];
 try {
  for (const lostResponse of [false, true]) {
   const context = await browser.newContext({viewport:{width:1440,height:960}});
   await context.addInitScript(() => {
    const key = 'infinite-canvas:ai_config_store';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({state:{config:{canvasImageCount:'1'}}}));
   });
   const page = await context.newPage();
   const errors=[];page.on('pageerror', e => errors.push(e.message));
   let submissions=0, lookups=0, complete=false;
   const taskId = lostResponse ? 'lost-response-task' : 'pending-task';
   await page.route('**/api/v1/infinite/generate', async route => {
    submissions++;
    if (lostResponse) await route.abort('failed');
    else await route.fulfill({json:{task_id:taskId}});
   });
   await page.route('**/api/v1/submissions/*', async route => { lookups++; await route.fulfill({json:{task_id:taskId}}); });
   await page.route(`**/api/v1/tasks/${taskId}`, route => route.fulfill({json: complete ? {status:'completed',images:[{base64:png}]} : {status:'running',images:[]}}));
   await page.goto(`${origin}/infinite/canvas`);
   await page.getByRole('button',{name:'新建画布',exact:true}).first().click();
   await page.waitForURL('**/infinite/canvas/*');
   await page.getByRole('button',{name:'图片',exact:true}).click();
   await page.locator('[contenteditable=true]').fill('Recovery acceptance');
   const submitted = page.waitForRequest('**/api/v1/infinite/generate');
   await page.getByRole('button',{name:'生成',exact:true}).click();
   await submitted;
   // The journal must already exist at the moment POST is sent.
   const before = await readNodes(page);
   assert(before.some(node => node.metadata?.images?.some(image=>image.imageApiTask?.clientRequestId)));
   await page.reload();
   complete=true;
   for(let i=0;i<40;i++) {
    const nodes=await readNodes(page);
    if(nodes.some(node=>node.metadata?.status==='success' && node.metadata?.content)) break;
    await page.waitForTimeout(200);
   }
   const after=await readNodes(page);
   assert(after.some(node=>node.metadata?.status==='success' && node.metadata?.content),JSON.stringify(after));
   assert.equal(submissions,1,'refresh must not create a second paid submission');
   if(lostResponse)assert.equal(lookups,1,'unknown submission must be resolved by identity');
   assert.deepEqual(errors,[]);
   await page.screenshot({path:`data/infinite-validation/recovery-${lostResponse?'unconfirmed':'pending'}.png`});
   summaries.push({lostResponse,submissions,identityLookups:lookups,resultRecovered:true,browserErrors:errors});
   await context.close();
  }
  const external = await browser.newContext();
  await external.addInitScript(() => localStorage.setItem('infinite-canvas:ai_config_store',JSON.stringify({state:{config:{
    imageModel:'external::custom-image',model:'external::custom-image',channels:[{id:'external',name:'自选渠道',baseUrl:'https://example.test',apiKey:'test-only',apiFormat:'openai',models:[{name:'custom-image',capability:'image'}]}]
  }}})));
  const settingsPage = await external.newPage();
  await settingsPage.goto(`${origin}/infinite/image`);
  await settingsPage.getByText('custom-image（自选渠道）',{exact:true}).waitFor();
  summaries.push({externalImageSelectionPreserved:true});
  await external.close();
  fs.writeFileSync('data/infinite-validation/recovery-result.json',JSON.stringify(summaries,null,2));
  console.log(JSON.stringify(summaries));
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
