const { chromium } = require('../canvas/node_modules/playwright');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const origin = 'http://127.0.0.1:8772';
const directory = '/home/sahn/image-api/data/infinite-validation/gallery-filter-test';
(async () => {
  assert.equal((await (await fetch(origin + '/api/v1/infinite/config')).json()).offline_validation, true);
  execFileSync('venv/bin/python', ['-c', `from image_api.services import gallery as g
from PIL import Image
assert str(g.GALLERY_DIR) == '${directory}'
c=g._get_conn()
assert c.execute('SELECT COUNT(*) FROM images').fetchone()[0] == 0, 'Use a fresh isolated gallery'
for i in range(32):
 name=f'fixture-{i}.png'
 Image.new('RGB',(40,40),(80+i*4,100,150)).save(g.GALLERY_DIR/name)
 created=f'2020-01-{i+1:02d}T12:00:00' if i<30 else '2026-11-08T12:00:00'
 c.execute('INSERT INTO images VALUES (?,?,?,?,?,?,?,?,?,?)',(str(i),created,'test','test',f'时间筛选测试 {i}','','',1,None,name))
c.commit()`], {env:{...process.env,GALLERY_DATA_DIR:directory}});
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: {width:1280,height:900} });
    const errors = [], writes = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => {if (['POST','DELETE'].includes(r.method())) writes.push(r.url());});
    await page.goto(origin + '/gallery');
    const summary = page.locator('#filterSummary');
    await page.getByText(/全部时间 · 共 32 张作品/).waitFor();
    const filter = async (start,end,count) => {
      await page.locator('#filterStart').fill(start);
      await page.locator('#filterEnd').fill(end);
      await page.getByRole('button',{name:'筛选作品',exact:true}).click();
      await page.waitForFunction(count => document.getElementById('filterSummary').textContent.includes(`共 ${count} 张作品`),count);
    };
    await filter('2020-01-01','2020-01-30',30);
    assert.equal(await page.locator('.card').count(),24);
    await page.locator('#loadMoreBtn').click();
    await page.waitForFunction(()=>document.querySelectorAll('.card').length===30);
    assert(await page.locator('#loadMoreBtn').isHidden());
    assert.equal(await page.locator('.created-date').count(),30);
    await filter('2020-01-02','2020-01-02',1);
    assert.equal(await page.locator('.card').first().getAttribute('data-id'),'1');
    await filter('2025-01-01','',2);
    await filter('','2019-01-01',0);
    await page.getByText('这个时间范围内没有作品',{exact:true}).waitFor();
    await page.locator('#filterStart').fill('2025-01-01');
    await page.getByRole('button',{name:'筛选作品',exact:true}).click();
    await page.getByText('开始日期不能晚于结束日期，当前列表未改变。',{exact:true}).waitFor();
    await page.locator('#filterClear').click();
    await page.getByText(/全部时间 · 共 32 张作品/).waitFor();
    await page.locator('#selectBtn').click();
    await page.locator('.card input').first().check();
    await filter('2020-01-01','2020-01-30',30);
    assert(await page.locator('#batchToolbar').isHidden());
    assert.equal(await page.locator('.card input:checked').count(),0);
    await page.locator('#cleanupOpen').click();
    await page.locator('#cleanupPreview').click();
    await page.getByText(/共有 30 张作品/).waitFor();
    await page.locator('#cleanupView').click();
    await page.locator('#cleanupDialog').waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.getElementById('filterSummary').textContent.includes('不限 至')&&document.getElementById('filterSummary').textContent.includes('共 30 张作品'));
    assert.equal(await page.locator('#filterStart').inputValue(),'');
    const cutoff = await page.locator('#filterEnd').inputValue();
    assert(cutoff);
    await page.locator('#cleanupOpen').click();
    assert(await page.locator('#cleanupDelete').isDisabled());
    await page.locator('#cleanupClose').click();
    fs.mkdirSync('data/infinite-validation',{recursive:true});
    await page.screenshot({path:'data/infinite-validation/gallery-time-filter-desktop.png'});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'data/infinite-validation/gallery-time-filter-mobile.png'});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('.card img').first().click();
    await page.locator('#modal.show').waitFor();
    await page.locator('#closeModal').click();
    assert.deepEqual(errors,[]);
    assert(writes.every(url=>url.endsWith('/gallery/cleanup/preview')),'No writes beyond read-only previews');
    assert.equal((await(await fetch(origin+'/api/v1/gallery')).json()).total,32);
    fs.writeFileSync('data/infinite-validation/gallery-time-filter-result.json',JSON.stringify({errors,writes,cutoff,remaining:32},null,2));
    console.log('Date filtering: inclusive bounds, pagination, totals, one-sided ranges, invalid/empty, reset selection, cleanup review, fresh confirmation and mobile passed. No images deleted.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
