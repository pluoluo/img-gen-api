const { chromium } = require('../canvas/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const origin = 'http://127.0.0.1:8772';
async function assets(page) {
  return page.evaluate(() => new Promise((resolve,reject) => {
    const request=indexedDB.open('infinite-canvas');
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{const db=request.result;const tx=db.transaction('app_state');const read=tx.objectStore('app_state').get('infinite-canvas:asset_store');read.onsuccess=()=>resolve(JSON.parse(read.result||'{}').state?.assets||[]);tx.oncomplete=()=>db.close();};
  }));
}
(async()=>{
  assert.equal((await(await fetch(origin+'/api/v1/infinite/config')).json()).offline_validation,true);
  const browser=await chromium.launch();
  try {
    const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});
    const page=await context.newPage();const errors=[],writes=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',r=>{if(['POST','DELETE'].includes(r.method()))writes.push(r.url());});
    await page.goto(origin+'/gallery');
    await page.locator('.card img').first().click();
    await page.locator('#addAssetBtn').click();
    await page.getByRole('button',{name:'已加入资产',exact:true}).waitFor();
    assert(await page.locator('#addAssetBtn').isDisabled());
    let saved=await assets(page);assert.equal(saved.length,1);
    const first=saved[0];assert(first.data.storageKey);assert.equal(first.source,'旧图库');
    assert.equal(first.note,await page.locator('#modalPrompt').textContent());
    const record=(await(await fetch(origin+'/api/v1/gallery?limit=1')).json()).items[0];
    const original=Buffer.from(await(await fetch(origin+'/gallery/'+record.filename)).arrayBuffer());
    await page.reload();await page.locator('.card img').first().click();await page.locator('#addAssetBtn').click();await page.getByRole('button',{name:'已加入资产',exact:true}).waitFor();
    assert.equal((await assets(page)).length,1,'Repeated import must not duplicate');
    await page.locator('#nextBtn').click();
    let fail=true,release;
    await page.route('**/gallery/fixture-*.png',route=>fail?route.fulfill({status:404,body:'missing test original'}):route.continue());
    await page.locator('#addAssetBtn').click();
    await page.getByText(/加入失败：/).waitFor();
    assert(await page.locator('#addAssetBtn').isEnabled());assert.equal((await assets(page)).length,1);
    fail=false;
    await page.locator('#addAssetBtn').click();await page.getByRole('button',{name:'已加入资产',exact:true}).waitFor();
    assert.equal((await assets(page)).length,2);
    fs.mkdirSync('data/infinite-validation',{recursive:true});
    await page.screenshot({path:'data/infinite-validation/legacy-gallery-assets-desktop.png'});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'data/infinite-validation/legacy-gallery-assets-mobile.png'});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    const assetPage=await context.newPage();
    await assetPage.route('**/gallery/fixture-*.png',r=>r.fulfill({status:404,body:'gallery no longer available'}));
    await assetPage.goto(origin+'/infinite/assets');
    await assetPage.getByRole('heading',{name:first.title,exact:true}).waitFor();
    const card=assetPage.locator('div').filter({has:assetPage.getByRole('heading',{name:first.title,exact:true})});
    // Use the asset's download control to prove the saved original remains independent of the gallery URL.
    const headings=await assetPage.getByRole('heading').allTextContents();
    const download=assetPage.waitForEvent('download');
    await assetPage.getByRole('button',{name:/下\s*载/}).nth(1).click();
    const downloaded=await download;
    await downloaded.saveAs('data/infinite-validation/legacy-gallery-asset-download.png');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync('data/infinite-validation/legacy-gallery-asset-download.png')).digest('hex'),crypto.createHash('sha256').update(original).digest('hex'));
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
    fs.writeFileSync('data/infinite-validation/legacy-gallery-assets-result.json',JSON.stringify({assets:2,errors,writes,independentOriginal:true},null,2));
    console.log('Legacy detail asset import, metadata, persistence, duplicate prevention, failure/retry, independent original, and desktop/mobile passed.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
