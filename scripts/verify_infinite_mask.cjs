// Paint through the real editor and inspect the generated PNG payload. No paid calls.
const {chromium}=require('../canvas/node_modules/playwright');
const {assertOfflineValidation}=require('./infinite_test_environment.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const origin=process.env.INFINITE_TEST_URL||'http://127.0.0.1:8770';
let source;
(async()=>{await assertOfflineValidation(origin);source=fs.readFileSync('data/infinite-validation/fixture.png').toString('base64');const browser=await chromium.launch({headless:true});const summaries=[];
 try{for(const deferred of [false,true]){
  const context=await browser.newContext({viewport:{width:1440,height:960}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));let submissions=[];
  await page.route('**/api/v1/infinite/generate',async route=>{submissions.push(route.request().postDataJSON());await route.fulfill({json:{task_id:'mask-fixture'}})});
  await page.route('**/api/v1/tasks/mask-fixture',route=>route.fulfill({json:{status:'completed',images:[{base64:source}]}}));
  await page.goto(`${origin}/infinite/canvas`);await page.getByRole('button',{name:'新建画布',exact:true}).first().click();await page.waitForURL('**/infinite/canvas/*');
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'上传资产',exact:true}).click();await(await chooser).setFiles('data/infinite-validation/fixture.png');
  await page.locator('[data-node-id]').first().hover();await page.getByRole('button',{name:'添加蒙版遮罩后局部修改',exact:true}).click();
  const dialog=page.getByRole('dialog');const canvas=dialog.locator('canvas:visible');await canvas.waitFor();const box=await canvas.boundingBox();assert(box);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.up();
  await dialog.getByPlaceholder('例如：把选中区域改成金属材质，保持原图光影').fill('Turn only the painted area red');
  const submitted=page.waitForRequest('**/api/v1/infinite/generate');
  await dialog.getByRole('button',{name:deferred?'导出到画布':'立刻生成',exact:true}).click();
  if(deferred){await page.getByRole('button',{name:'生成',exact:true}).waitFor();assert.equal(submissions.length,0);await page.getByRole('button',{name:'生成',exact:true}).click();}
  const request=await submitted;const body=request.postDataJSON();assert.equal(body.preserve_outside_mask,true);assert.equal(body.image_base64s.length,1);assert.equal(body.image_base64s[0],source);assert(body.prompt.includes('Turn only the painted area red'));
  const pixels=await page.evaluate(async mask=>{const bitmap=await createImageBitmap(await(await fetch(`data:image/png;base64,${mask}`)).blob());const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);return{width:c.width,height:c.height,center:Array.from(ctx.getImageData(c.width/2,c.height/2,1,1).data),outside:Array.from(ctx.getImageData(0,0,1,1).data)}} ,body.mask_base64);
  assert.equal(pixels.center[3],0);assert.deepEqual(pixels.outside,[255,255,255,255]);assert.equal(pixels.width,1024);assert.equal(pixels.height,1024);assert.deepEqual(errors,[]);
  await page.screenshot({path:`data/infinite-validation/mask-${deferred?'deferred':'immediate'}.png`});summaries.push({deferred,submissions:submissions.length,referenceCount:body.image_base64s.length,preserveOutside:true,mask:pixels});await context.close();
 }}finally{await browser.close()}
 fs.writeFileSync('data/infinite-validation/mask-result.json',JSON.stringify(summaries,null,2));console.log(JSON.stringify(summaries));
})().catch(error=>{console.error(error);process.exit(1)});
