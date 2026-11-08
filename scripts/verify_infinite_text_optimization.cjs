// The optimizer edits only the active text variant and never calls an image model.
const { chromium } = require('../canvas/node_modules/playwright');
const { assertOfflineValidation } = require('./infinite_test_environment.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8772';
const output = 'data/infinite-validation';
const source = '只调整参考图2的展台吊顶为暖黄色，保留布局与品牌“天味食品”。\n\n画面标题必须是"Tianwei 2026"，比例3:2。';
const optimized = '修改内容：\n仅将参考图2的展台吊顶调整为暖黄色。\n\n保留内容：\n保留布局与品牌“天味食品”。画面标题必须是"Tianwei 2026"，比例3:2。';
async function project(page) {
    return page.evaluate(() => new Promise(resolve => { const r = indexedDB.open('infinite-canvas'); r.onsuccess = () => { const db = r.result, tx = db.transaction('app_state'), q = tx.objectStore('app_state').get('infinite-canvas:canvas_store'); q.onsuccess = () => resolve(JSON.parse(q.result || '{}').state?.projects[0]); tx.oncomplete = () => db.close(); }; }));
}
async function saved(page, predicate) {
    for (let i = 0; i < 80; i++) { const value = await project(page); if (value && predicate(value)) return value; await page.waitForTimeout(100); }
    throw Error('Expected canvas state was not saved');
}
(async () => {
    await assertOfflineValidation(origin);
    fs.mkdirSync(output, { recursive: true });
    execFileSync('venv/bin/python', ['-c', `import json,zipfile
source=${JSON.stringify(source)}
def node(id,x,content):return dict(id=id,type='text',title=id,position=dict(x=x,y=0),width=360,height=230,metadata=dict(content=content,status='success',fontSize=16,model='optimization-fixture::saved-text'))
n=node('optimize-me',0,source);n['metadata'].update(texts=[dict(id='alternative',content='备选版本保持不变',status='success'),dict(id='active',content=source,status='success')],primaryTextId='active',composerContent='保留我原来的编辑指令')
p=dict(id='text-optimization-fixture',title='提示词优化验收',nodes=[n,node('empty',520,''),node('context',-480,'无关上游内容，不应加入优化请求')],connections=[dict(id='reference',fromNodeId='context',toNodeId='optimize-me')],chatSessions=[],activeChatId=None,backgroundMode='dots',showImageInfo=False,viewport=dict(x=600,y=300,k=.8))
with zipfile.ZipFile('data/infinite-validation/text-optimization.zip','w') as z:z.writestr('projects.json',json.dumps(dict(app='infinite-canvas',version=3,projects=[dict(project=p,files=[])])))`]);
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
        await context.addInitScript(() => {
            localStorage.setItem('infinite-canvas:prompt_source_store_v2', JSON.stringify({ state: { schedule: { intervalMinutes: 0 } }, version: 0 }));
            localStorage.setItem('infinite-canvas:ai_config_store', JSON.stringify({ state: { config: { textModel: 'optimization-fixture::global-text', systemPrompt: '用户原有偏好：保持文案准确。', channels: [{ id: 'optimization-fixture', name: '优化验收', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', apiKey: 'offline-fixture', apiFormat: 'openai', textApiFormat: 'chat-completions', models: [{ name: 'saved-text', capability: 'text' }, { name: 'global-text', capability: 'text' }] }] } }, version: 0 }));
        });
        const page = await context.newPage();
        const errors = [], posts = [], requests = [];
        let mode = 'success', release;
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error' && /Maximum update depth|Minified React error/.test(message.text())) errors.push(message.text()); });
        page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
        await page.route('**/api/v1/infinite/mimo/**', async route => {
            const request = route.request().postDataJSON();
            requests.push(request);
            assert.equal(request.model, 'saved-text');
            assert(request.messages[0].content.includes('最小幅度'));
            assert(request.messages[0].content.includes('逐字保留'));
            assert.equal(request.messages.at(-1).content, source);
            if (mode === 'pending') await new Promise(resolve => { release = resolve; });
            if (mode === 'error') return route.fulfill({ status: 403, json: { error: { message: 'fixture-text-permission-error' } } });
            const content = mode === 'invalid' ? optimized.replace('天味食品', '新品牌') : optimized;
            await route.fulfill({ json: { choices: [{ message: { content }, finish_reason: 'stop' }] } }).catch(() => {});
        });
        await page.goto(origin + '/infinite/canvas');
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: '导入画布', exact: true }).click();
        await (await chooser).setFiles(output + '/text-optimization.zip');
        await page.getByRole('heading', { name: '提示词优化验收', exact: true }).click();
        const node = page.locator('[data-node-id="optimize-me"]');
        const selectNode = () => node.click({ position: { x: 45, y: 55 } });
        const toolbar = () => page.locator('[data-node-toolbar="optimize-me"]');
        const optimize = () => toolbar().getByRole('button', { name: '优化提示词', exact: true });
        const primaryText = p => p.nodes.find(n => n.id === 'optimize-me').metadata.texts.find(t => t.id === 'active').content;
        await selectNode();
        await page.screenshot({ path: output + '/text-optimization-toolbar.png', animations: 'disabled' });
        await toolbar().getByRole('button', { name: 'AI 文本生成', exact: true }).click();
        await page.locator('[data-node-panel="optimize-me"]').waitFor();
        assert.equal(requests.length, 0);
        await toolbar().getByRole('button', { name: 'AI 文本生成', exact: true }).click();
        const before = await project(page);
        assert.equal(await toolbar().evaluate(element => getComputedStyle(element).fontSize), '14px');
        assert.equal(Math.round((await toolbar().boundingBox()).height), 40);
        await optimize().click();
        let state = await saved(page, p => primaryText(p) === optimized);
        assert.equal(state.nodes.length, before.nodes.length);
        assert.deepEqual(state.connections, before.connections);
        const changed = state.nodes.find(n => n.id === 'optimize-me');
        assert.equal(changed.metadata.texts[0].content, '备选版本保持不变');
        assert.equal(changed.metadata.composerContent, '保留我原来的编辑指令');
        assert.deepEqual(changed.position, before.nodes.find(n => n.id === 'optimize-me').position);
        await page.waitForTimeout(350); // Existing history commits after 180 ms.
        await page.keyboard.press('Control+z');
        await saved(page, p => primaryText(p) === source);
        await page.keyboard.press('Control+Shift+z');
        await saved(page, p => primaryText(p) === optimized);
        await page.reload();
        await node.getByText(optimized, { exact: true }).waitFor();
        // Restore the fixture through editing the active text variant, then test each failure path.
        const restore = async () => {
            await node.dblclick({ position: { x: 60, y: 60 } });
            await node.locator('textarea').fill(source);
            await page.keyboard.press('Escape');
            await saved(page, p => primaryText(p) === source);
            await selectNode();
        };
        await restore();
        mode = 'error';
        await optimize().click();
        await page.getByText(/fixture-text-permission-error/).waitFor();
        assert.equal(primaryText(await project(page)), source);
        mode = 'invalid';
        await optimize().click();
        await page.getByText('优化结果改动了引号内的原文，本次未应用，请重试', { exact: true }).waitFor();
        assert.equal(primaryText(await project(page)), source);
        mode = 'pending'; release = undefined;
        await optimize().click();
        await toolbar().getByRole('button', { name: '停止优化提示词', exact: true }).waitFor();
        while (!release) await page.waitForTimeout(20);
        assert.equal(primaryText(await project(page)), source);
        await toolbar().getByRole('button', { name: '停止优化提示词', exact: true }).click();
        release();
        await optimize().waitFor();
        assert.equal(primaryText(await project(page)), source);
        mode = 'pending'; release = undefined;
        await optimize().click();
        while (!release) await page.waitForTimeout(20);
        await node.dblclick({ position: { x: 60, y: 60 } });
        await node.locator('textarea').fill('用户在等待时输入的最新内容');
        await page.keyboard.press('Escape');
        release();
        await page.getByText('提示词已在优化期间修改，已保留你的最新内容，请重新优化', { exact: true }).waitFor();
        await saved(page, p => primaryText(p) === '用户在等待时输入的最新内容');
        await page.locator('[data-node-id="empty"]').click({ position: { x: 45, y: 55 } });
        assert(await page.locator('[data-node-toolbar="empty"]').getByRole('button', { name: '优化提示词', exact: true }).isDisabled());
        assert.equal(requests.length, 5);
        assert(posts.every(url => url.includes('/api/v1/infinite/mimo/')));
        assert.deepEqual(errors, []);
        const result = { shortcutAndExistingAiText: true, savedModelUsed: true, noUpstreamContentInjected: true, compactToolbar: true, currentBatchOnly: true, nodeAndConnectionsPreserved: true, undoRedo: true, reloadPersists: true, failureKeepsOriginal: true, exactTextGuard: true, cancellationKeepsOriginal: true, concurrentEditPreserved: true, emptyDisabled: true, textRequests: requests.length, imageRequests: 0, browserErrors: errors };
        fs.writeFileSync(output + '/text-optimization-result.json', JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
