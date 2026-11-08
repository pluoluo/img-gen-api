const { chromium } = require('../canvas/node_modules/playwright');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const origin = 'http://127.0.0.1:8772';
const directory = '/home/sahn/image-api/data/infinite-validation/cleanup-gallery-test';
const env = { ...process.env, GALLERY_DATA_DIR: directory };
function python(code) { return execFileSync('venv/bin/python', ['-c', code], { env, encoding: 'utf8' }); }
(async () => {
  const config = await (await fetch(origin + '/api/v1/infinite/config')).json();
  assert.equal(config.offline_validation, true, 'Requires the isolated cleanup test server');
  python(`from image_api.services import gallery as g
from PIL import Image
assert str(g.GALLERY_DIR) == '${directory}'
c=g._get_conn()
assert c.execute('SELECT COUNT(*) FROM images').fetchone()[0] == 0, 'Use a fresh isolated gallery'
for i in range(32):
 name=f'fixture-{i}.png'
 Image.new('RGB',(12,12),'blue').save(g.GALLERY_DIR/name)
 c.execute('INSERT INTO images VALUES (?,?,?,?,?,?,?,?,?,?)',(str(i),'2020-01-01T12:00:00' if i<30 else '2026-11-08T12:00:00','test','test',f'测试作品 {i}','','',1,None,name))
c.commit()`);
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', e => errors.push(e.message));
    let deletes = 0;
    page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/gallery/cleanup')) deletes++; });
    await page.goto(origin + '/gallery');
    assert(await page.locator('#cleanupDialog').isHidden());
    await page.locator('#cleanupOpen').click();
    await page.locator('.card').first().waitFor();
    await page.locator('#cleanupPreview').click();
    await page.getByText(/共有 30 张作品/).waitFor();
    await page.locator('#cleanupClose').click();
    assert.equal(deletes, 0);
    await page.locator('#cleanupOpen').click();
    for (const months of ['1','6','3']) {
      await page.locator('#cleanupPeriod').selectOption(months);
      assert(await page.locator('#cleanupDelete').isDisabled());
      await page.locator('#cleanupPreview').click();
      await page.getByText(/共有 30 张作品/).waitFor();
    }
    fs.mkdirSync('data/infinite-validation', { recursive: true });
    await page.screenshot({ path: 'data/infinite-validation/gallery-cleanup-desktop.png' });
    python(`from image_api.services import gallery as g
c=g._get_conn();c.execute("UPDATE images SET created_at='2020-01-02T12:00:00' WHERE id='0'");c.commit()`);
    await page.locator('#cleanupDelete').click();
    await page.getByText('待删除作品已变化，请重新预览并确认').waitFor();
    assert(await page.locator('#cleanupDelete').isDisabled());
    await page.locator('#cleanupPeriod').selectOption('custom');
    await page.locator('#cleanupDate').fill('2024-01-01');
    await page.locator('#cleanupPreview').click();
    await page.getByText(/2024-01-01 00:00.*共有 30 张作品/).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'data/infinite-validation/gallery-cleanup-mobile.png' });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const dialog = await page.locator('#cleanupDialog').boundingBox();
    assert(dialog.x >= 0 && dialog.x + dialog.width <= 390);
    await page.locator('#cleanupDelete').click();
    await page.locator('#cleanupDialog').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
    const remaining = await (await fetch(origin + '/api/v1/gallery')).json();
    assert.equal(remaining.total, 2);
    await page.locator('#cleanupOpen').click();
    await page.locator('#cleanupPreview').click();
    await page.getByText(/共有 0 张作品/).waitFor();
    assert(await page.locator('#cleanupDelete').isDisabled());
    assert.deepEqual(errors, []);
    const files = python(`from image_api.services import gallery as g
assert not (g.GALLERY_DIR/'fixture-0.png').exists()
assert (g.GALLERY_DIR/'fixture-30.png').exists()
print('files verified')`).trim();
    fs.writeFileSync('data/infinite-validation/gallery-cleanup-result.json', JSON.stringify({ deletes, remaining: remaining.total, errors, files }, null, 2));
    console.log('Gallery cleanup: presets, preview, cancel, stale confirmation, custom date, mobile, deletion, files and empty preview passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
