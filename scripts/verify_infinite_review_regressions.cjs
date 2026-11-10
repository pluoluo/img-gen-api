// Regression coverage against real IndexedDB and service code. Provider calls are mocked.
const { chromium } = require('../canvas/node_modules/playwright');
const { assertOfflineValidation } = require('./infinite_test_environment.cjs');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('../infinite/web/node_modules/typescript');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8770';
const output = path.resolve('data/infinite-validation');

function videoDeleteCallback() {
  const text = fs.readFileSync('infinite/web/src/pages/video/index.tsx', 'utf8');
  const ast = ts.createSourceFile('video.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'deleteSelectedLogs') callback = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert(callback);
  return ts.transpileModule('return ' + ts.createPrinter().printNode(ts.EmitHint.Expression, callback, ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

(async () => {
  await assertOfflineValidation(origin);
  execFileSync('bun', ['build', './tests/fixtures/review-browser.ts', '--outdir', path.join(output, 'review-bundle'), '--target', 'browser', '--define', 'import.meta.env={}'], { cwd: path.resolve('infinite/web'), stdio: 'pipe' });
  const browser = await chromium.launch({ headless: true });
  const errors = [], summaries = [];
  async function harness() {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/health');
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('infinite-canvas', 1);
      request.onupgradeneeded = () => {
        for (const name of ['app_state', 'image_files', 'image_previews', 'media_files', 'image_generation_logs', 'video_generation_logs', 'image_api_workbench_jobs']) request.result.createObjectStore(name);
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    }));
    await page.addScriptTag({ path: path.join(output, 'review-bundle/review-browser.js') });
    await page.waitForFunction(() => window.infiniteReview?.useCanvasStore.getState().hydrated && window.infiniteReview?.useAssetStore.getState().hydrated);
    return { context, page };
  }
  try {
    {
      const { context, page } = await harness();
      const result = await page.evaluate(async callback => {
        const api = window.infiniteReview;
        const logs = api.localforage.createInstance({ name: 'infinite-canvas', storeName: 'video_generation_logs' });
        await api.setMediaBlob('video:history-only', new Blob(['history'], { type: 'video/mp4' }));
        await api.setMediaBlob('video:orphan', new Blob(['orphan']));
        await logs.setItem('history', { id: 'history', video: { storageKey: 'video:history-only' } });
        await api.cleanupUnusedMedia({ assets: [], projects: [] });
        const historyKept = Boolean(await api.getMediaBlob('video:history-only'));
        const orphanRemoved = !await api.getMediaBlob('video:orphan');
        api.useAssetStore.getState().addAsset({ kind: 'video', title: 'saved video', coverUrl: '', tags: [], data: { storageKey: 'video:history-only', url: '', width: 100, height: 100, bytes: 7, mimeType: 'video/mp4' } });
        const bindings = { selectedLogIds: ['history'], logStore: logs, useAssetStore: api.useAssetStore, refreshLogs: async () => {}, previewLog: null, setPreviewLog: () => {}, setResults: () => {}, setSelectedLogIds: () => {}, setDeleteConfirmOpen: () => {} };
        new Function(...Object.keys(bindings), callback)(...Object.values(bindings))();
        await logs.getItem('history');
        await api.cleanupUnusedMedia({ assets: api.useAssetStore.getState().assets, projects: [] });
        return { historyKept, orphanRemoved, historyDeleted: !await logs.getItem('history'), savedAssetKept: Boolean(await api.getMediaBlob('video:history-only')) };
      }, videoDeleteCallback());
      assert.deepEqual(result, { historyKept: true, orphanRemoved: true, historyDeleted: true, savedAssetKept: true });
      summaries.push({ scenario: 'media lifecycle', ...result });
      await context.close();
    }
    {
      const { context, page } = await harness();
      const png = fs.readFileSync(path.join(output, 'fixture.png'));
      const domainData = {
        canvas: { projects: [{ id: 'local', title: 'remote version', updatedAt: '2021-01-01', nodes: [{ metadata: { storageKey: 'image:sync-canvas' } }] }, { id: 'remote-project', title: 'remote', updatedAt: '2021-01-01' }, { id: 'untouched', title: 'remote updated untouched', updatedAt: '2021-01-01' }, { id: 'removed-project', title: 'deleted locally', updatedAt: '2021-01-01' }], deleted: [] },
        assets: { assets: [{ id: 'removed', kind: 'text', updatedAt: '2021-01-01', data: { content: 'removed locally' } }, { id: 'remote-asset', kind: 'image', coverUrl: '', updatedAt: '2021-01-01', data: { storageKey: 'image:sync-assets', dataUrl: '' } }] },
        'image-workbench': { logs: [{ id: 'job', createdAt: 1, status: 'pending' }, { id: 'removed', createdAt: 1 }, { id: 'remote-log', createdAt: 1, storageKey: 'image:sync-image-workbench' }] },
        'video-workbench': { logs: [{ id: 'job', createdAt: 1, status: 'pending' }, { id: 'removed', createdAt: 1 }, { id: 'remote-log', createdAt: 1, storageKey: 'image:sync-video-workbench' }] },
      };
      await page.evaluate(async () => {
        const api = window.infiniteReview;
        api.useCanvasStore.getState().replaceProjects([{ id: 'local', title: 'before', updatedAt: '2020-01-01', nodes: [] }, { id: 'untouched', title: 'old untouched', updatedAt: '2020-01-01', nodes: [] }, { id: 'removed-project', title: 'before deletion', updatedAt: '2020-01-01', nodes: [] }]);
        api.useAssetStore.getState().replaceAssets([{ id: 'removed', kind: 'text', updatedAt: '2020-01-01', data: { content: 'before' } }]);
        for (const storeName of ['image_generation_logs', 'video_generation_logs']) {
          const store = api.localforage.createInstance({ name: 'infinite-canvas', storeName });
          await store.setItem('job', { id: 'job', createdAt: 1, status: 'pending' });
          await store.setItem('removed', { id: 'removed', createdAt: 1 });
        }
      });
      let waiting = 0, ready, release;
      const downloadsStarted = new Promise(resolve => ready = resolve);
      const downloadGate = new Promise(resolve => release = resolve);
      const uploaded = {};
      await page.route('**/api/v1/infinite/storage/**', async route => {
        const request = route.request(); const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname.endsWith('/manifest.json')) {
          const domain = url.pathname.split('/').at(-2);
          return route.fulfill({ json: { app: 'infinite-canvas', version: 1, domain, data: domainData[domain], files: [{ storageKey: 'image:sync-' + domain, path: domain + '/files/reference.png', mimeType: 'image/png', bytes: png.length }] } });
        }
        if (request.method() === 'GET') {
          if (++waiting === 4) ready();
          await downloadGate;
          return route.fulfill({ body: png, contentType: 'image/png' });
        }
        if (request.method() === 'PUT' && url.pathname.endsWith('/manifest.json')) uploaded[url.pathname.split('/').at(-2)] = request.postDataJSON();
        return route.fulfill({ status: request.method() === 'MKCOL' ? 201 : 204 });
      });
      const syncing = page.evaluate(async origin => {
        const api = window.infiniteReview;
        return api.syncAppDataToWebdav({ url: origin + '/api/v1/infinite/storage', directory: 'review', username: '', password: '' });
      }, origin);
      await downloadsStarted;
      await page.evaluate(async () => {
        const api = window.infiniteReview;
        api.useCanvasStore.getState().deleteProjects(['removed-project']);
        api.useCanvasStore.getState().renameProject('local', 'edited during sync');
        api.useCanvasStore.getState().createProject('created during sync');
        api.useAssetStore.getState().replaceAssets([{ id: 'local-asset', kind: 'text', updatedAt: '2026-01-01', data: { content: 'created during sync' } }]);
        for (const storeName of ['image_generation_logs', 'video_generation_logs']) {
          const store = api.localforage.createInstance({ name: 'infinite-canvas', storeName });
          await store.setItem('job', { id: 'job', createdAt: 1, status: 'completed' });
          await store.setItem('local-log', { id: 'local-log', createdAt: 2 });
          await store.removeItem('removed');
        }
      });
      release(); await syncing;
      const result = await page.evaluate(async () => {
        const api = window.infiniteReview;
        const projects = api.useCanvasStore.getState().projects;
        const logs = {};
        for (const name of ['image_generation_logs', 'video_generation_logs']) {
          const store = api.localforage.createInstance({ name: 'infinite-canvas', storeName: name });
          logs[name] = { job: await store.getItem('job'), added: await store.getItem('local-log'), removed: await store.getItem('removed'), remote: await store.getItem('remote-log') };
        }
        return { title: projects.find(project => project.id === 'local').title, projectTitles: projects.map(project => project.title), assetIds: api.useAssetStore.getState().assets.map(asset => asset.id), logs };
      });
      assert.equal(result.title, 'edited during sync');
      assert(result.projectTitles.includes('created during sync')); assert(result.projectTitles.includes('remote'));
      assert(result.projectTitles.includes('remote updated untouched')); assert(!result.projectTitles.includes('deleted locally'));
      assert(result.assetIds.includes('local-asset')); assert(result.assetIds.includes('remote-asset')); assert(!result.assetIds.includes('removed'));
      for (const logs of Object.values(result.logs)) { assert.equal(logs.job.status, 'completed'); assert(logs.added); assert(logs.remote); assert.equal(logs.removed, null); }
      assert.equal(uploaded.canvas.data.projects.find(project => project.id === 'local').title, 'edited during sync');
      assert(!uploaded.assets.data.assets.some(asset => asset.id === 'removed'));
      assert.equal(uploaded['image-workbench'].data.logs.find(log => log.id === 'job').status, 'completed');
      summaries.push({ scenario: 'sync concurrent updates', projects: result.projectTitles.length, assets: result.assetIds, historyCompleted: true, concurrentDeletionsKept: true });
      await context.close();
    }
    {
      const { context, page } = await harness();
      let submitted;
      await page.route('https://review.invalid/v1/images/edits', async route => {
        const request = route.request();
        const form = await new Response(request.postDataBuffer(), { headers: { 'content-type': request.headers()['content-type'] } }).formData();
        submitted = Buffer.from(await form.get('image').arrayBuffer()).toString('base64');
        return route.fulfill({ json: { data: [{ b64_json: fs.readFileSync(path.join(output, 'fixture.png')).toString('base64') }] } });
      });
      const composite = await page.evaluate(async () => {
        const api = window.infiniteReview;
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'green'; ctx.fillRect(0, 0, 32, 32);
        const original = canvas.toDataURL('image/png');
        ctx.fillStyle = 'blue'; ctx.fillRect(8, 8, 16, 16);
        const composite = canvas.toDataURL('image/png');
        const config = { ...api.defaultConfig, model: 'external::gpt-image-test', imageModel: 'external::gpt-image-test', size: 'auto', count: '1', channels: [{ id: 'external', name: 'offline', baseUrl: 'https://review.invalid/v1', apiKey: 'fixture-only', apiFormat: 'openai', models: [{ name: 'gpt-image-test', capability: 'image' }] }] };
        await api.requestEdit(config, 'follow the annotation', [{ id: 'source', name: 'source.png', type: 'image/png', dataUrl: original }], { imageApiMarkup: { storageKey: 'unused-native-layer', source: { url: original }, overlay: { url: composite } } });
        return composite.split(',')[1];
      });
      assert.equal(submitted, composite);
      summaries.push({ scenario: 'external annotation fallback', annotatedPixelsSubmitted: true });
      await context.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'review-regressions-result.json'), JSON.stringify(summaries, null, 2));
    console.log(JSON.stringify(summaries));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
