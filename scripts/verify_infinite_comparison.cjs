// Compare local fixture images in a disposable browser. Providers are disabled server-side.
const { chromium } = require('../canvas/node_modules/playwright');
const { assertOfflineValidation } = require('./infinite_test_environment.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8770';
const output = 'data/infinite-validation';
async function project(page) {
  return page.evaluate(() => new Promise(resolve => {
    const r = indexedDB.open('infinite-canvas');
    r.onsuccess = () => {
      const db = r.result, tx = db.transaction('app_state'), q = tx.objectStore('app_state').get('infinite-canvas:canvas_store');
      q.onsuccess = () => resolve(JSON.parse(q.result || '{}').state?.projects[0]);
      tx.oncomplete = () => db.close();
    };
  }));
}
const stableNodes = nodes => JSON.parse(JSON.stringify(nodes, (_key, value) => typeof value === "string" && value.startsWith("blob:") ? "blob:ephemeral" : value));
(async () => {
  await assertOfflineValidation(origin);
  execFileSync('venv/bin/python', ['scripts/create_infinite_archive_fixture.py']);
  execFileSync('venv/bin/python', ['-c', `import io,json,zipfile
from PIL import Image
with zipfile.ZipFile('data/infinite-validation/archive-complete.zip') as source,zipfile.ZipFile('data/infinite-validation/comparison.zip','w') as target:
 for name in source.namelist():
  raw=source.read(name)
  if name=='projects.json':
   manifest=json.loads(raw);project=manifest['projects'][0]['project'];project['id']='comparison-fixture';project['title']='图片对比验收'
   def image(id,x,y,key):return dict(id=id,type='image',title=id,position=dict(x=x,y=y),width=200,height=150,metadata=dict(storageKey=key,content='blob:old/'+id,status='success') if key else {})
   project['nodes'] += [image('compare-b',500,250,'image:reference'),image('empty-image',750,250,None),image('portrait',750,0,'image:source')]
   raw=json.dumps(manifest).encode()
  if name=='files/image-source':
   buf=io.BytesIO();Image.new('RGBA',(80,120),'red').save(buf,format='PNG');raw=buf.getvalue()
  target.writestr(name,raw)`]);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [], posts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
    await page.goto(origin + '/infinite/canvas');
    await page.evaluate(() => localStorage.setItem('canvas-image-quick-tools-v7', JSON.stringify({ ids: ['annotate', 'view'], annotationVersion: 1, showLabels: false })));
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '导入画布', exact: true }).click();
    await (await chooser).setFiles(output + '/comparison.zip');
    await page.getByRole('heading', { name: '图片对比验收', exact: true }).click();
    const image = () => page.locator('[data-node-id="fixture-image"]');
    await image().locator('img').first().evaluate(img => img.decode());
    let before;
    for (let i = 0; i < 80; i++) { before = await project(page); if (before?.nodes?.length === 7) break; await page.waitForTimeout(100); }
    assert.equal(before.nodes.length, 7);
    const start = async () => { await image().click(); await page.getByRole('button', { name: 'AB 对比', exact: true }).click(); await page.getByRole('button', { name: /选择另一张图片进行 AB 对比/ }).waitFor(); };
    const dialog = () => page.getByRole('dialog', { name: 'AB 图片对比' });
    const slider = () => dialog().getByRole('slider', { name: '对比分隔线' });
    await start();
    await page.locator('[data-node-id="fixture-text"]').click();
    await page.locator('[data-node-id="empty-image"]').click();
    await image().click();
    assert.equal(await dialog().count(), 0);
    await page.keyboard.press('Delete'); await page.waitForTimeout(600);
    assert.equal((await project(page)).nodes.length, 7);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /选择另一张图片进行 AB 对比/ }).waitFor({ state: 'detached' });
    await start(); await page.locator('[data-node-id="compare-b"]').click();
    await slider().waitFor();
    assert.equal(await slider().getAttribute('aria-valuenow'), '50');
    const stage = () => page.locator('[data-image-comparison]');
    const drag = async (from, to) => {
      const box = await stage().boundingBox();
      await page.mouse.move(box.x + box.width * from, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width * to, box.y + box.height / 2, { steps: 15 }); await page.mouse.up();
    };
    await drag(.5, .7);
    assert.ok(Math.abs(Number(await slider().getAttribute('aria-valuenow')) - 70) <= 1);
    await page.screenshot({ path: output + '/comparison-desktop.png', animations: 'disabled' });
    await stage().screenshot({ path: output + '/comparison-pixels.png', animations: 'disabled' });
    execFileSync('venv/bin/python', ['-c', `from PIL import Image
image=Image.open('data/infinite-validation/comparison-pixels.png').convert('RGB');w,h=image.size
assert image.getpixel((int(w*.3),int(h*.8))) == (0,128,0)
assert image.getpixel((int(w*.8),int(h*.8))) == (0,0,255)`]);
    await drag(.7, .2);
    assert.ok(Math.abs(Number(await slider().getAttribute('aria-valuenow')) - 20) <= 1);
    await slider().focus(); await page.keyboard.press('Home'); assert.equal(await slider().getAttribute('aria-valuenow'), '0');
    await page.keyboard.press('End'); assert.equal(await slider().getAttribute('aria-valuenow'), '100');
    await page.keyboard.press('ArrowLeft'); assert.equal(await slider().getAttribute('aria-valuenow'), '99');
    await page.keyboard.press('ArrowRight'); assert.equal(await slider().getAttribute('aria-valuenow'), '100');
    await dialog().getByRole('button', { name: '交换 A / B', exact: true }).click();
    await dialog().getByAltText('A：compare-b', { exact: true }).waitFor();
    await dialog().getByAltText('B：fixture-image', { exact: true }).waitFor();
    await page.keyboard.press('Delete'); await page.keyboard.press('Control+z'); await page.waitForTimeout(600);
    assert.deepEqual(stableNodes((await project(page)).nodes), stableNodes(before.nodes));
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'detached' });
    await start(); await page.locator('[data-node-id="portrait"]').click(); await slider().waitFor();
    assert.equal(await dialog().getByAltText('B：portrait').evaluate(img => getComputedStyle(img).objectFit), 'contain');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: output + '/comparison-mobile.png', animations: 'disabled' });
    const mobileBox = await stage().boundingBox(); assert.ok(mobileBox.width <= 390 && mobileBox.height < 844);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mobileBox.x + mobileBox.width * .5, y: mobileBox.y + mobileBox.height / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mobileBox.x + mobileBox.width * .8, y: mobileBox.y + mobileBox.height / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok(Math.abs(Number(await slider().getAttribute('aria-valuenow')) - 80) <= 1);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await cdp.detach();
    await dialog().getByRole('button', { name: '关闭对比' }).click(); await dialog().waitFor({ state: 'detached' });
    assert.deepEqual(stableNodes((await project(page)).nodes), stableNodes(before.nodes));
    assert.deepEqual((await project(page)).connections, before.connections);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(origin + '/'); await page.getByRole('tab', { name: '画布工作区 · 预览' }).click();
    const embedded = page.frameLocator('iframe[title="画布工作区"]');
    await embedded.getByRole('heading', { name: '图片对比验收', exact: true }).click();
    await embedded.locator('[data-node-id="fixture-image"]').click(); await embedded.getByRole('button', { name: 'AB 对比', exact: true }).click();
    await embedded.locator('[data-node-id="compare-b"]').click(); await embedded.getByRole('slider', { name: '对比分隔线' }).waitFor();
    await page.waitForFunction(() => document.querySelector('iframe').style.position === 'fixed');
    const full = await page.locator('iframe').boundingBox(); assert.equal(full.x, 0); assert.equal(full.y, 0); assert.equal(full.height, 1000);
    await page.keyboard.press('Escape'); await embedded.getByRole('dialog', { name: 'AB 图片对比' }).waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('iframe').style.position !== 'fixed');
    assert.deepEqual(stableNodes((await project(page)).nodes), stableNodes(before.nodes)); assert.deepEqual((await project(page)).connections, before.connections);
    assert.deepEqual(posts, []); assert.deepEqual(errors, []);
    const result = { entryMigrates: true, pickAnotherImage: true, invalidAndSelfDisabled: true, cancelPicker: true, draggableDivider: true, leftRightPixelsCorrect: true, keyboardSlider: true, swap: true, closeAndEscape: true, aspectRatioPreserved: true, mobileFits: true, touchDrag: true, embeddedFullscreenRestores: true, graphUnchanged: true, postRequests: posts, browserErrors: errors };
    fs.writeFileSync(output + '/comparison-result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
