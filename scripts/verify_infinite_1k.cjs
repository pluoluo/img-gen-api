// 1K parameter and routing acceptance. All generation requests are intercepted.
const { chromium } = require('../canvas/node_modules/playwright');
const { assertOfflineValidation } = require('./infinite_test_environment.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8770';
const output = 'data/infinite-validation';
async function project(page) {
  return page.evaluate(() => new Promise(resolve => {
    const r = indexedDB.open('infinite-canvas'); r.onsuccess = () => { const db = r.result, tx = db.transaction('app_state'), q = tx.objectStore('app_state').get('infinite-canvas:canvas_store'); q.onsuccess = () => resolve(JSON.parse(q.result || '{}').state?.projects[0]); tx.oncomplete = () => db.close(); };
  }));
}
async function saved(page, predicate) {
  for (let i = 0; i < 80; i++) { const value = await project(page); if (value && predicate(value)) return value; await page.waitForTimeout(100); }
  throw Error('Expected canvas state not persisted');
}
(async () => {
  await assertOfflineValidation(origin);
  const policy = await (await fetch(origin + '/api/v1/gpt-route')).json(); assert.equal(policy.one_k_max_pixels, 1572864); assert.ok(policy.rule.includes('总像素'));
  execFileSync('venv/bin/python', ['scripts/create_infinite_archive_fixture.py']);
  execFileSync('venv/bin/python', ['-c', `import json,zipfile,copy
with zipfile.ZipFile('data/infinite-validation/archive-complete.zip') as source,zipfile.ZipFile('data/infinite-validation/pixel-budget.zip','w') as target:
 for name in source.namelist():
  raw=source.read(name)
  if name=='projects.json':
   data=json.loads(raw);project=data['projects'][0]['project'];project['id']='pixel-budget';project['title']='1K像素预算验收';image=project['nodes'][1];image['metadata'].update(model='image-api::gpt-image-2.5-flare',size='1024x1024',quality='low',count=1);other=copy.deepcopy(image);other.update(id='unchanged-image',title='保留独立设置',position=dict(x=500,y=250));project['nodes'].append(other);raw=json.dumps(data).encode()
  target.writestr(name,raw)`]);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }); const errors = [], requests = [], otherPosts = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (r.method() === 'POST' && !r.url().endsWith('/api/v1/infinite/generate')) otherPosts.push(r.url()); });
    await page.route('**/api/v1/infinite/generate', async route => { requests.push(route.request().postDataJSON()); await route.fulfill({ json: { task_id: 'pixel-budget-image' } }); });
    await page.route('**/api/v1/tasks/pixel-budget-image', route => route.fulfill({ json: { status: 'completed', images: [{ base64: fs.readFileSync(output + '/fixture.png').toString('base64') }] } }));
    await page.goto(origin + '/infinite/canvas'); const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '导入画布', exact: true }).click(); await (await chooser).setFiles(output + '/pixel-budget.zip'); await page.getByRole('heading', { name: '1K像素预算验收', exact: true }).click();
    await page.locator('[data-node-id="fixture-image"]').click();
    const panel = page.locator('[data-node-panel="fixture-image"]'); await panel.getByRole('button').filter({ hasText: /张/ }).last().click();
    const settings = page.locator('.canvas-image-settings-popover');
    assert.equal(await settings.getByRole('spinbutton', { name: 'W', exact: true }).inputValue(), '1024');
    await settings.getByRole('button', { name: '1k', exact: true }).click();
    const expected = { '1:1': [1248,1248], '4:3': [1440,1088], '3:4': [1088,1440], '3:2': [1536,1024], '2:3': [1024,1536], '16:9': [1664,944], '9:16': [944,1664], '21:9': [1920,816], '9:21': [816,1920] };
    for (const [ratio, [width, height]] of Object.entries(expected)) {
      await settings.getByRole('button', { name: ratio, exact: true }).click();
      assert.equal(Number(await settings.getByRole('spinbutton', { name: 'W', exact: true }).inputValue()), width);
      assert.equal(Number(await settings.getByRole('spinbutton', { name: 'H', exact: true }).inputValue()), height);
      await panel.getByRole('button').filter({ hasText: '1k' }).waitFor();
      assert.ok(width * height <= policy.one_k_max_pixels && width * height >= .99 * policy.one_k_max_pixels);
    }
    await settings.getByRole('button', { name: '16:9', exact: true }).click(); await settings.getByRole('button', { name: '设为画布默认', exact: true }).click();
    await page.screenshot({ path: output + '/pixel-budget-settings.png', animations: 'disabled' });
    await page.mouse.click(1450, 950);
    const original = await saved(page, p => p.nodes.find(n => n.id === 'fixture-image').metadata.size === '1664x944');
    assert.equal(original.nodes.find(n => n.id === 'unchanged-image').metadata.size, '1024x1024');
    await page.locator('button[aria-label="图片"]').click(); const next = await saved(page, p => p.nodes.length === 6); const created = next.nodes.find(n => !original.nodes.some(old => old.id === n.id));
    const nextPanel = page.locator(`[data-node-panel="${created.id}"]`); await nextPanel.getByRole('button').filter({ hasText: '1k' }).waitFor();
    await nextPanel.getByRole('textbox').fill('A green leaf'); await nextPanel.getByRole('button', { name: '生成', exact: true }).click();
    await saved(page, p => Boolean(p.nodes.find(n => n.id === created.id).metadata.content));
    assert.equal(requests.length, 1); assert.equal(requests[0].size, '1664x944'); assert.equal(requests[0].sub_model, 'gpt-image-2.5-flare');
    await page.reload(); const restored = await project(page); assert.equal(restored.nodes.find(n => n.id === 'unchanged-image').metadata.size, '1024x1024');
    const defaults = await page.evaluate(() => JSON.parse(localStorage.getItem('infinite-canvas:ai_config_store')).state.config); assert.equal(defaults.size, '1664x944');
    await page.goto(origin + '/'); await page.locator('#size optgroup[label="1K"] option').first().waitFor({ state: 'attached' });
    const legacy = await page.locator('#size optgroup[label="1K"] option').evaluateAll(options => options.map(o => o.value)); assert.equal(legacy.length, 7);
    for (const size of legacy) { const [w,h] = size.split('x').map(Number); assert.ok(w * h <= policy.one_k_max_pixels && w * h >= .99 * policy.one_k_max_pixels); }
    assert.deepEqual(errors, []); assert.deepEqual(otherPosts, []);
    const result = { routeUsesTotalPixels: true, oneKMaxPixels: policy.one_k_max_pixels, presets: expected, allPresetsOver99Percent: true, labelsStay1K: true, savedDefaultsPersist: true, newNodesInherit: true, independentNodeSizePreserved: true, submittedSize: requests[0].size, legacyPresetsAligned: legacy, mockedGenerations: requests.length, browserErrors: errors, otherPostRequests: otherPosts };
    fs.writeFileSync(output + '/pixel-budget-result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
