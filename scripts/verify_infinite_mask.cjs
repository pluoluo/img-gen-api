// Real mask editor + deferred config generation. Isolated service; no paid calls.
const { chromium } = require('../canvas/node_modules/playwright');
const { assertOfflineValidation } = require('./infinite_test_environment.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8770';
async function stored(page, update = false) {
  return page.evaluate(update => new Promise(resolve => {
    const request = indexedDB.open('infinite-canvas');
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(update ? ['app_state', 'image_files'] : ['app_state'], update ? 'readwrite' : 'readonly');
      const store = tx.objectStore('app_state');
      const read = store.get('infinite-canvas:canvas_store');
      let project;
      read.onsuccess = () => {
        const data = JSON.parse(read.result);
        project = data.state.projects[0];
        if (update) {
          const source = project.nodes.find(node => !node.metadata.maskLayer);
          const mask = project.nodes.find(node => node.metadata.maskLayer);
          source.position = { x: 0, y: 0 };
          mask.position = { x: 0, y: 400 };
          const extra = { ...source, id: 'extra', title: '额外参考图', position: { x: 0, y: 800 }, metadata: { ...source.metadata, storageKey: 'image:extra-fixture' } };
          const blob = tx.objectStore('image_files').get(source.metadata.storageKey);
          blob.onsuccess = () => tx.objectStore('image_files').put(blob.result, 'image:extra-fixture');
          const text = { ...source, id: 'instructions', type: 'text', title: '修改要求', position: { x: 500, y: 600 }, metadata: { content: 'Turn only the painted area red' } };
          const config = { ...source, id: 'mask-config', type: 'config', title: '蒙版生成配置', position: { x: 500, y: 0 }, metadata: { model: 'image-api::gpt-image-2.5-flare', size: '3840x2160', count: 1, generationMode: 'image' } };
          project.nodes.push(extra, text, config);
          project.connections = [extra, mask, text].map(node => ({ id: node.id + '-config', fromNodeId: node.id, toNodeId: config.id }));
          project.connections.push({ id: 'original-mask-lineage', fromNodeId: source.id, toNodeId: mask.id });
          project.viewport = { x: 400, y: 100, k: .6 };
          store.put(JSON.stringify(data), 'infinite-canvas:canvas_store');
        }
      };
      tx.oncomplete = () => { db.close(); resolve(project); };
    };
  }), update);
}
(async () => {
  await assertOfflineValidation(origin);
  const source = fs.readFileSync('data/infinite-validation/fixture.png').toString('base64');
  const browser = await chromium.launch({ headless: true });
  const summaries = [];
  try {
    for (const scenario of ["immediate", "deferred", "external"]) {
      const deferred = scenario === "deferred", external = scenario === "external";
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      await context.addInitScript(external => {
        const config = { size: '3840x2160' };
        if (external) Object.assign(config, { model: 'fixture::edit-model', imageModel: 'fixture::edit-model', channels: [{ id: 'fixture', name: '离线验收', baseUrl: 'https://mask.test/v1', apiKey: 'fixture-only', apiFormat: 'openai', models: [{ name: 'edit-model', capability: 'image' }] }] });
        localStorage.setItem('infinite-canvas:ai_config_store', JSON.stringify({ state: { config } }));
      }, external);
      const page = await context.newPage();
      const errors = [], submissions = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/v1/infinite/generate', async route => {
        submissions.push(route.request().postDataJSON());
        await route.fulfill({ json: { task_id: 'mask-fixture' } });
      });
      await page.route('**/api/v1/tasks/mask-fixture', route => route.fulfill({ json: { status: 'completed', images: [{ base64: source }] } }));
      await page.route('https://mask.test/v1/images/edits', async route => {
        const request = route.request();
        const form = await new Response(request.postDataBuffer(), { headers: { 'content-type': request.headers()['content-type'] } }).formData();
        const files = [...form.getAll('image[]'), ...form.getAll('image')];
        submissions.push({ size: form.get('size'), images: await Promise.all(files.map(async file => Buffer.from(await file.arrayBuffer()).toString('base64'))) });
        await route.fulfill({ json: { data: [{ b64_json: source }] } });
      });
      await page.goto(`${origin}/infinite/canvas`);
      await page.getByRole('button', { name: '新建画布', exact: true }).first().click();
      await page.waitForURL('**/infinite/canvas/*');
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '上传资产', exact: true }).click();
      await (await chooser).setFiles('data/infinite-validation/fixture.png');
      await page.locator('[data-node-id]').first().hover();
      await page.getByRole('button', { name: '添加蒙版遮罩后局部修改', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const canvas = dialog.locator('canvas:visible');
      await canvas.waitFor();
      const box = await canvas.boundingBox();
      assert(box);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      if (!deferred) await dialog.getByPlaceholder('例如：把选中区域改成金属材质，保持原图光影').fill('Turn only the painted area red');
      await page.screenshot({ path: `data/infinite-validation/mask-${scenario}-editor.png` });
      const completed = page.waitForResponse(external ? 'https://mask.test/v1/images/edits' : '**/api/v1/tasks/mask-fixture');
      await dialog.getByRole('button', { name: deferred ? '导出到画布' : '立刻生成', exact: true }).click();
      if (deferred) {
        await dialog.waitFor({ state: 'detached' });
        let saved;
        for (let i = 0; i < 60; i++) { saved = await stored(page); if (saved.nodes.length === 2) break; await page.waitForTimeout(100); }
        assert.equal(saved.nodes.length, 2, 'export adds only the mask, no empty output');
        assert.equal(saved.connections.length, 0);
        assert(saved.nodes.find(node => node.metadata.maskLayer)?.metadata.imageApiMask);
        assert.equal(submissions.length, 0);
        await stored(page, true);
        await page.reload();
        const maskId = saved.nodes.find(node => node.metadata.maskLayer).id;
        await page.locator(`[data-node-id="${maskId}"]`).click();
        const references = page.locator(`[data-node-panel="${maskId}"] [data-reference-node-id]`);
        await references.first().waitFor();
        assert.equal(await references.count(), 1, 'mask source lineage must not duplicate its bundled original');
        assert.equal(await references.first().getAttribute('data-reference-node-id'), maskId);
        await page.locator('[data-node-id="mask-config"]').click();
        await page.getByRole('button', { name: '开始生成', exact: true }).click();
      }
      await completed;
      if (external) {
        const sizes = await page.evaluate(async images => Promise.all(images.map(async data => {
          const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
          return [bitmap.width, bitmap.height];
        })), submissions[0].images);
        assert.deepEqual(sizes, [[3840, 2160], [3840, 2160]]);
        assert.equal(submissions[0].size, '3840x2160');
        assert.deepEqual(errors, []);
        summaries.push({ external: true, size: submissions[0].size, primaryAndOverlaySizes: sizes });
        await context.close();
        continue;
      }
      const body = submissions[0];
      assert.equal(body.size, '3840x2160');
      assert.equal(body.preserve_outside_mask, true);
      assert.equal(body.image_base64s.length, deferred ? 2 : 1);
      assert.equal(body.image_base64s[0], source);
      assert(body.prompt.includes('Turn only the painted area red'));
      const pixels = await page.evaluate(async mask => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${mask}`)).blob());
        const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
        const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
        return { width: c.width, height: c.height, center: Array.from(ctx.getImageData(c.width / 2, c.height / 2, 1, 1).data), outside: Array.from(ctx.getImageData(0, 0, 1, 1).data) };
      }, body.mask_base64);
      assert.equal(pixels.center[3], 0);
      assert.deepEqual(pixels.outside, [255, 255, 255, 255]);
      assert.equal(pixels.width, 1024); assert.equal(pixels.height, 1024);
      assert.deepEqual(errors, []);
      summaries.push({ deferred, size: body.size, submissions: submissions.length, referenceCount: body.image_base64s.length, mask: pixels });
      await context.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync('data/infinite-validation/mask-result.json', JSON.stringify(summaries, null, 2));
  console.log(JSON.stringify(summaries));
})().catch(error => { console.error(error); process.exit(1); });
