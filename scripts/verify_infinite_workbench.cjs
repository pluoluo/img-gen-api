// Real browser persistence and fixture task responses. No paid requests.
const {chromium}=require('../canvas/node_modules/playwright');
const {assertOfflineValidation}=require('./infinite_test_environment.cjs');
const assert=require('node:assert/strict');const fs=require('node:fs');
const origin=process.env.INFINITE_TEST_URL||'http://127.0.0.1:8770';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
async function records(page,store){return page.evaluate(name=>new Promise((resolve,reject)=>{const request=indexedDB.open('infinite-canvas');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;if(!db.objectStoreNames.contains(name)){db.close();resolve([]);return}const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>{resolve(r.result);db.close()};r.onerror=()=>reject(r.error)}}),store)}
async function until(page,check){for(let i=0;i<60;i++){const result=await check();if(result)return result;await page.waitForTimeout(150)}throw Error('persistence condition timed out')}
(async()=>{await assertOfflineValidation(origin);const browser=await chromium.launch({headless:true});const results=[];
try{for(const scenario of ['pending','lost-response','query-error','partial-batch','references','missing-result-cache']){
 const context=await browser.newContext({viewport:{width:1440,height:960}});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 let complete=false,posts=[],lookups=0,queries={};const count=(scenario==='partial-batch'||scenario==='missing-result-cache')?2:1;
 await page.route('**/api/v1/infinite/generate',async route=>{const body=route.request().postDataJSON();posts.push(body);if(scenario==='lost-response')await route.abort('failed');else await route.fulfill({json:{task_id:`workbench-${posts.length}`}})});
 await page.route('**/api/v1/submissions/*',async route=>{lookups++;await route.fulfill({json:{task_id:'workbench-1'}})});
 await page.route('**/api/v1/tasks/workbench-*',async route=>{const id=route.request().url().split('/').pop();queries[id]=(queries[id]||0)+1;
  if(scenario==='query-error'&&!complete)return route.fulfill({status:500,json:{detail:'Query interrupted; original task remains available'}});
  const done=complete||((scenario==='partial-batch'||scenario==='missing-result-cache')&&id==='workbench-1');await route.fulfill({json:done?{status:'completed',images:[{base64:png}]}:{status:'running',images:[]}});
 });
 await page.goto(`${origin}/infinite/image`);const prompt=`Workbench recovery ${scenario}`;await page.getByPlaceholder('描述画面主体、风格、构图、光线和用途').fill(prompt);if(count===2)await page.getByRole('button',{name:'2 张',exact:true}).click();
 if(scenario==='references'){
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:/^上\s*传$/}).click();
  await(await chooser).setFiles([{name:'ref-one.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')},{name:'ref-two.png',mimeType:'image/png',buffer:fs.readFileSync('data/infinite-validation/fixture.png')}]);
  await page.getByText('暂无参考图，可将图片拖到这里',{exact:true}).waitFor({state:'hidden'});
 }
 await page.getByRole('button',{name:'开始生成',exact:true}).click();
 const saved=await until(page,async()=>{const all=await records(page,'image_api_workbench_jobs');return all.length===count&&posts.length===count?all:null});assert(saved.every(job=>job.task?.clientRequestId));assert(!JSON.stringify(saved).includes('apiKey'));assert(!JSON.stringify(saved).includes(png));
 if(scenario==='references')assert.deepEqual(posts[0].image_base64s,[png,fs.readFileSync('data/infinite-validation/fixture.png').toString('base64')]);
 if(scenario==='partial-batch'||scenario==='missing-result-cache')await until(page,async()=>(await records(page,'image_api_workbench_jobs')).some(job=>job.image));
 if(scenario==='missing-result-cache'){
  const completed=(await records(page,'image_api_workbench_jobs')).find(job=>job.image);
  await page.evaluate(key=>new Promise((resolve,reject)=>{const open=indexedDB.open('infinite-canvas');open.onsuccess=()=>{const db=open.result;const tx=db.transaction('image_files','readwrite');tx.objectStore('image_files').delete(key);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error)}}),completed.image.storageKey);
 }
 if(scenario==='query-error'){
  await page.getByRole('button',{name:/重\s*试/}).waitFor({timeout:6000}).catch(async e=>{console.error('ERROR UI',await page.locator('body').innerText());throw e});await page.getByPlaceholder('描述画面主体、风格、构图、光线和用途').fill('Changed after submission; must not replace original snapshot');complete=true;await page.getByRole('button',{name:/重\s*试/}).click();
 }else{await page.reload();complete=true;}
 const logs=await until(page,async()=>{const items=await records(page,'image_generation_logs');return items.length===1&&items[0].successCount===count&&items[0].images.length===count?items:null});
 await until(page,async()=>(await records(page,'image_api_workbench_jobs')).length===0);
 assert.equal(posts.length,count,'recovery must not create replacement paid tasks');assert.equal(logs[0].prompt,prompt);assert.equal(logs[0].imageCount,count);assert.equal(new Set(logs[0].images.map(image=>image.id)).size,count);assert(logs[0].images.every(image=>image.storageKey&&!image.dataUrl));assert.deepEqual(errors,[]);
 if(scenario==='lost-response')assert.equal(lookups,1);if(scenario==='partial-batch')assert.equal(queries['workbench-1'],1,'already-stored successful slot must not be fetched again');if(scenario==='missing-result-cache')assert.equal(queries['workbench-1'],2,'missing local pixels should be fetched from the same task');
 await page.screenshot({path:`data/infinite-validation/workbench-${scenario}.png`});
 results.push({scenario,generationPosts:posts.length,identityLookups:lookups,historyRecords:logs.length,imagesRecovered:logs[0].images.length,browserErrors:errors});await context.close();
}}finally{await browser.close()}
fs.writeFileSync('data/infinite-validation/workbench-result.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
})().catch(error=>{console.error(error);process.exit(1)});
