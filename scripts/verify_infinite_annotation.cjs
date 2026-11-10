// Fullscreen annotation acceptance with isolated browser storage and offline provider guard.
const { chromium } = require('../canvas/node_modules/playwright');
const { assertOfflineValidation } = require('./infinite_test_environment.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8770';
const output = 'data/infinite-validation';
async function project(page) {
  return page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('infinite-canvas');
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('app_state');
      const result = tx.objectStore('app_state').get('infinite-canvas:canvas_store');
      result.onsuccess = () => resolve(JSON.parse(result.result || '{}').state?.projects[0]);
      tx.oncomplete = () => db.close();
    };
  }));
}
async function pixels(page, key) {
  return page.evaluate(key => new Promise(resolve => {
    const request = indexedDB.open('infinite-canvas');
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('image_files');
      const result = tx.objectStore('image_files').get(key);
      result.onsuccess = async () => {
        const image = await createImageBitmap(result.result);
        const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        const sample = (x, y) => Array.from(ctx.getImageData(Math.round(x * canvas.width), Math.round(y * canvas.height), 1, 1).data);
        let textPixels = 0;
        for (let y = Math.round(canvas.height * .6); y < canvas.height * .8; y++) for (let x = Math.round(canvas.width * .15); x < canvas.width * .7; x++) {
          const i = (y * canvas.width + x) * 4;
          if (bytes[i] > 180 && bytes[i + 1] < 120 && bytes[i + 2] < 120) textPixels++;
        }
        resolve({ textPixels, rectangle: sample(.45, .4), width: canvas.width, height: canvas.height, hash: Array.from(new Uint8Array(digest)).join(','), clean: sample(.8, .8), pen: sample(.2, .2), erased: sample(.25, .2) });
      };
      tx.oncomplete = () => db.close();
    };
  }), key);
}
(async () => {
  await assertOfflineValidation(origin);
  execFileSync('venv/bin/python', ['scripts/create_infinite_archive_fixture.py']);
  execFileSync('venv/bin/python', ['-c', `import io,json,zipfile
from PIL import Image,ImageDraw
with zipfile.ZipFile('data/infinite-validation/archive-complete.zip') as source, zipfile.ZipFile('data/infinite-validation/annotation.zip','w') as target:
 for name in source.namelist():
  raw=source.read(name)
  if name=='files/image-primary':
   image=Image.new('RGBA',(1024,768),'green');ImageDraw.Draw(image).rectangle((768,576,1023,767),fill=(0,0,0,0));buf=io.BytesIO();image.save(buf,format='PNG');raw=buf.getvalue()
  if name=='projects.json':
   manifest=json.loads(raw);manifest['projects'][0]['project']['nodes'][1]['metadata'].update(naturalWidth=1024,naturalHeight=768);raw=json.dumps(manifest).encode()
  target.writestr(name,raw)`]);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [], posts = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
    await page.goto(origin + '/infinite/canvas');
    // Exercise migration from a customized toolbar made before annotation existed.
    await page.evaluate(() => localStorage.setItem('canvas-image-quick-tools-v7', JSON.stringify({ ids: ['view', 'crop'], showLabels: false })));
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '导入画布', exact: true }).click();
    await (await chooser).setFiles(output + '/annotation.zip');
    await page.getByRole('heading', { name: '迁移验收画布', exact: true }).click();
    const image = page.locator('[data-node-id="fixture-image"]');
    await image.locator('img').first().evaluate(img => img.decode());
    let before;
    for (let i = 0; i < 80; i++) { before = await project(page); if (before?.nodes?.length === 4) break; await page.waitForTimeout(100); }
    assert.ok(before);
    const originalKey = before.nodes.find(n => n.id === 'fixture-image').metadata.storageKey;
    assert.ok(originalKey);
    const original = await pixels(page, originalKey);
    const open = async () => { await image.click(); await page.getByRole('button', { name: '图片标注', exact: true }).click(); await page.getByRole('dialog', { name: '图片标注' }).waitFor(); await page.getByRole('button', { name: '保存', exact: true }).waitFor({ state: 'visible' }); await page.waitForFunction(() => document.querySelector('canvas[aria-label="标注画布"]')?.width > 1); };
    const draw = async (x1, y1, x2, y2) => {
      const box = await page.getByLabel('标注画布', { exact: true }).boundingBox();
      await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 12 });
      await page.mouse.up();
    };
    await open(); await draw(.15, .2, .35, .2);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '图片标注' }).waitFor({ state: 'detached' });
    const cancelled = await project(page);
    assert.deepEqual(cancelled.nodes, before.nodes);
    assert.deepEqual(cancelled.connections, before.connections);
    await open();
    await draw(.15, .2, .35, .2);
    await page.getByRole('button', { name: '撤销标注', exact: true }).click();
    assert.equal(await page.getByLabel('标注画布', { exact: true }).evaluate(c => c.getContext('2d').getImageData(Math.round(c.width * .2), Math.round(c.height * .2), 1, 1).data[3]), 0);
    await page.getByRole('button', { name: '重做标注', exact: true }).click();
    assert.equal(await page.getByLabel('标注画布', { exact: true }).evaluate(c => c.getContext('2d').getImageData(Math.round(c.width * .2), Math.round(c.height * .2), 1, 1).data[3]), 255);
    await page.getByRole('button', { name: '矩形', exact: true }).click(); await draw(.45, .3, .7, .5);
    await page.getByRole('button', { name: '橡皮', exact: true }).click(); await draw(.25, .15, .25, .25);
    await page.getByRole('button', { name: '文字', exact: true }).click();
    const box = await page.getByLabel('标注画布', { exact: true }).boundingBox();
    await page.mouse.click(box.x + .15 * box.width, box.y + .6 * box.height);
    await page.getByRole('textbox', { name: '标注文字' }).fill('修改吊顶颜色\n确认展示区域');
    await page.screenshot({ path: output + '/annotation-desktop.png', animations: 'disabled' });
    // Save must include text still being edited, without an extra confirmation click.
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('dialog', { name: '图片标注' }).waitFor({ state: 'detached' });
    let after;
    for (let i = 0; i < 80; i++) { after = await project(page); if (after.nodes.length === before.nodes.length + 1) break; await page.waitForTimeout(100); }
    assert.equal(after.nodes.length, before.nodes.length + 1);
    const annotated = after.nodes.find(n => !before.nodes.some(old => old.id === n.id));
    const resultPixels = await pixels(page, annotated.metadata.storageKey);
    assert.equal(resultPixels.width, original.width); assert.equal(resultPixels.height, original.height);
    assert.notEqual(resultPixels.hash, original.hash);
    assert.deepEqual(resultPixels.clean, original.clean);
    assert.deepEqual(resultPixels.erased, original.erased);
    assert.deepEqual(resultPixels.pen, [239, 68, 68, 255]);
    assert.deepEqual(resultPixels.rectangle, [239, 68, 68, 255]);
    assert.ok(resultPixels.textPixels > original.textPixels);
    assert.deepEqual(await pixels(page, originalKey), original);
    assert.ok(after.connections.some(c => c.fromNodeId === 'fixture-image' && c.toNodeId === annotated.id));
    await page.locator(`[data-node-id="${annotated.id}"]`).click();
    const references = page.locator(`[data-node-panel="${annotated.id}"] [data-reference-node-id]`);
    await references.first().waitFor();
    assert.equal(await references.count(), 1, 'marked image bundles its original in the quick generator');
    assert.equal(await references.first().getAttribute('data-reference-node-id'), annotated.id);
    await page.reload();
    assert.equal((await project(page)).nodes.length, after.nodes.length);
    assert.deepEqual(await pixels(page, annotated.metadata.storageKey), resultPixels);
    // The canvas deletion shortcut must not delete a node behind the editor.
    await open(); await page.keyboard.press('Delete');
    assert.equal((await project(page)).nodes.length, after.nodes.length);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: output + '/annotation-mobile.png', animations: 'disabled' });
    const dialog = page.getByRole('dialog', { name: '图片标注' });
    assert.ok(await dialog.getByRole('button', { name: '保存', exact: true }).isVisible());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: '取消标注', exact: true }).click();
    assert.equal((await project(page)).nodes.length, after.nodes.length);
    await page.setViewportSize({ width: 1600, height: 1000 });
    const projectUrl = page.url();
    await page.goto(origin + '/legacy');
    await page.getByRole('tab', { name: '画布工作区', exact: true }).click();
    const embedded = page.frameLocator('iframe[title="画布工作区"]');
    await embedded.getByRole('heading', { name: '迁移验收画布', exact: true }).click();
    await embedded.locator('[data-node-id="fixture-image"]').click();
    await embedded.getByRole('button', { name: '图片标注', exact: true }).click();
    await embedded.getByRole('dialog', { name: '图片标注' }).waitFor();
    await page.waitForFunction(() => document.querySelector('iframe[title="画布工作区"]').style.position === 'fixed');
    const fullscreenBox = await page.locator('iframe[title="画布工作区"]').boundingBox();
    assert.equal(fullscreenBox.x, 0); assert.equal(fullscreenBox.y, 0);
    assert.equal(fullscreenBox.width, 1600); assert.equal(fullscreenBox.height, 1000);
    await page.screenshot({ path: output + '/annotation-embedded.png', animations: 'disabled' });
    await page.keyboard.press('Escape');
    await embedded.getByRole('dialog', { name: '图片标注' }).waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('iframe[title="画布工作区"]').style.position !== 'fixed');
    assert.equal((await project(page)).nodes.length, after.nodes.length);
    assert.deepEqual(errors, []); assert.deepEqual(posts, []);
    await page.goto(projectUrl);
    const annotationPanel = () => page.locator(`[data-node-panel="${annotated.id}"]`);
    const selectAnnotated = async () => { await page.locator(`[data-node-id="${annotated.id}"]`).click(); await annotationPanel().getByLabel('当前图片', { exact: true }).waitFor(); };
    await selectAnnotated();
    const shownRefs = await annotationPanel().locator('[data-reference-node-id]').evaluateAll(items => items.map(item => item.dataset.referenceNodeId));
    assert.deepEqual(shownRefs, [annotated.id]);
    assert.equal(await annotationPanel().getByLabel('当前图片', { exact: true }).getByRole('button').count(), 0);
    await page.screenshot({ path: output + '/annotation-reference.png', animations: 'disabled' });
    const encoded = await page.evaluate(key => new Promise(resolve => {
      const r = indexedDB.open('infinite-canvas');
      r.onsuccess = () => {
        const db = r.result; const tx = db.transaction('image_files'); const q = tx.objectStore('image_files').get(key);
        q.onsuccess = () => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(q.result); };
        tx.oncomplete = () => db.close();
      };
    }), annotated.metadata.storageKey);
    const submissions = [];
    const returnedImage = fs.readFileSync(output + '/fixture.png').toString('base64');
    await page.route('**/api/v1/infinite/generate', async route => {
      submissions.push(route.request().postDataJSON());
      await route.fulfill({ json: { task_id: 'annotation-reference-' + submissions.length } });
    });
    await page.route('**/api/v1/tasks/annotation-reference-*', route => route.fulfill({ json: { status: 'completed', images: [{ base64: returnedImage }] } }));
    for (const behavior of ['new-node', 'overwrite']) {
      await page.evaluate(behavior => {
        const key = 'infinite-canvas:ai_config_store'; const value = JSON.parse(localStorage.getItem(key));
        value.state.config.nodeRegenerateBehavior = behavior; value.state.config.canvasImageCount = '1'; value.state.config.count = '1'; localStorage.setItem(key, JSON.stringify(value));
      }, behavior);
      await page.reload(); await selectAnnotated();
      await annotationPanel().getByRole('textbox').fill('按照标注修改，保留其余结构');
      const completed = page.waitForResponse(response => response.url().includes('/api/v1/tasks/annotation-reference-'));
      await annotationPanel().getByRole('button', { name: '生成', exact: true }).click();
      await completed;
      const sent = submissions[submissions.length - 1];
      assert.equal(sent.image_base64s.length, 1);
      assert.ok(sent.markup_base64);
      assert.notEqual(sent.image_base64s[0], encoded, behavior + ' must submit the original, not the flattened annotation');
      assert.notEqual(sent.markup_base64, encoded);
      for (let i = 0; i < 80; i++) {
        const saved = await project(page);
        if (behavior === 'new-node' ? saved.nodes.length === after.nodes.length + 1 && saved.nodes.every(n => n.metadata?.status !== 'loading') : saved.nodes.find(n => n.id === annotated.id)?.metadata.storageKey !== annotated.metadata.storageKey) break;
        await page.waitForTimeout(100);
      }
    }
    const generated = (await project(page)).nodes.find(node => node.id === annotated.id);
    assert.ok(generated.metadata.generationMarkup, 'historical markup remains available for retry');
    assert.equal(generated.metadata.imageApiMarkup, undefined, 'result is not an active annotation layer');
    await page.reload(); await selectAnnotated();
    await annotationPanel().getByRole('textbox').fill('继续修改刚生成的图片');
    const continued = page.waitForResponse(response => response.url().includes('/api/v1/tasks/annotation-reference-'));
    await annotationPanel().getByRole('button', { name: '生成', exact: true }).click();
    await continued;
    const latestRequest = submissions[submissions.length - 1];
    assert.equal(latestRequest.image_base64s[0], returnedImage, 'continued editing must start from the generated result');
    assert.equal(latestRequest.markup_base64, undefined, 'continued editing must not reapply old markup');
    assert.equal(submissions.length, 3);
    assert.equal(posts.length, 3);
    assert.ok(posts.every(url => url.endsWith('/api/v1/infinite/generate')));
    assert.deepEqual(errors, []);
    const result = { toolbarMigration: true, fullscreen: true, penRectangleEraserText: true, undoRedo: true, saveIncludesActiveText: true, originalPreserved: true, originalResolution: true, erasePreservesSource: true, cancelHasNoChanges: true, refreshPersists: true, backgroundShortcutsBlocked: true, mobileFits: true, embeddedFullscreenRestores: true, currentImageShownFirst: true, annotatedPngSubmittedInNewAndOverwriteModes: true, continuousEditUsesLatestResult: true, mockedGenerations: 3, postRequests: posts, browserErrors: errors };
    fs.writeFileSync(output + '/annotation-result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
