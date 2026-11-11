// Isolated browser + real task journal/acknowledgement; never contacts a provider.
const { chromium } = require('../canvas/node_modules/playwright');
const { assertOfflineValidation } = require('./infinite_test_environment.cjs');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-client-delivery-'));
const environment = { ...process.env, INFINITE_OFFLINE_VALIDATION: '1', TASK_DATA_DIR: path.join(root, 'tasks'), GALLERY_DATA_DIR: path.join(root, 'gallery'), CANVAS_DATA_DIR: path.join(root, 'canvas'), INFINITE_DATA_DIR: path.join(root, 'infinite'), PROMPT_LIBRARY_DATA_DIR: path.join(root, 'prompts') };
const output = path.resolve('data/infinite-validation');
const python = path.resolve('venv/bin/python');
let server, browser;
const summaries = [];

function seed(body, png) {
    const script = `
import json,sys,hashlib
from datetime import datetime
from image_api.services.tasks import reserve_task,update_task,TaskStatus
value=json.load(sys.stdin)
body=value['body']
task_id,_=reserve_task(model='openai',sub_model=body['sub_model'],prompt=body['prompt'],size=body.get('size','auto'),quality=body.get('quality'),n=body['n'],save_to_gallery=False,client_request_id=body['client_request_id'],fingerprint=hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest())
update_task(task_id,status=TaskStatus.COMPLETED,progress=100,images=[{'base64':value['png']}],completed_at=datetime.now().isoformat())
print(task_id)
`;
    const result = spawnSync(python, ['-c', script], { env: environment, input: JSON.stringify({ body, png }), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

async function records(page, name) {
    return page.evaluate(name => new Promise((resolve, reject) => {
        const open = indexedDB.open('infinite-canvas');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains(name)) { db.close(); resolve([]); return; }
            const request = db.transaction(name).objectStore(name).getAll();
            request.onsuccess = () => { db.close(); resolve(request.result); };
            request.onerror = () => reject(request.error);
        };
    }), name);
}

async function until(page, read) {
    for (let i = 0; i < 80; i++) {
        const value = await read();
        if (value) return value;
        await page.waitForTimeout(100);
    }
    throw new Error('Delivery persistence condition timed out');
}

async function assertLocalOwner(page, workbench) {
    let keys;
    if (workbench) {
        const jobs = await records(page, 'image_api_workbench_jobs');
        const logs = await records(page, 'image_generation_logs');
        keys = [...jobs.flatMap(job => job.image?.storageKey ? [job.image.storageKey] : []), ...logs.flatMap(log => log.images.map(image => image.storageKey))];
    } else {
        const states = await records(page, 'app_state');
        const canvas = states.map(value => typeof value === 'string' ? JSON.parse(value) : value).find(value => value.state?.projects);
        keys = canvas?.state.projects.flatMap(project => project.nodes.flatMap(node => [node.metadata?.storageKey, ...(node.metadata?.images || []).filter(image => image.status === 'success').map(image => image.storageKey)]).filter(Boolean)) || [];
    }
    assert(keys.length, 'owner record must be durable before acknowledgement');
    const sizes = await page.evaluate(keys => new Promise((resolve, reject) => {
        const open = indexedDB.open('infinite-canvas');
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('image_files');
            const sizes = [];
            for (const key of keys) {
                const request = tx.objectStore('image_files').get(key);
                request.onsuccess = () => sizes.push(request.result?.size || 0);
            }
            tx.oncomplete = () => { db.close(); resolve(sizes); };
            tx.onerror = () => reject(tx.error);
        };
    }), keys);
    assert(sizes.every(size => size > 0), 'all referenced local image Blobs must exist before acknowledgement');
}

(async () => {
    const port = await new Promise(resolve => {
        const socket = net.createServer();
        socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
    });
    const origin = `http://127.0.0.1:${port}`;
    server = spawn(python, ['-m', 'uvicorn', 'image_api.main:app', '--host', '127.0.0.1', '--port', String(port)], { env: environment, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
        try { if ((await fetch(origin + '/health')).ok) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    await assertOfflineValidation(origin);
    const png = fs.readFileSync(path.join(output, 'fixture.png')).toString('base64');
    browser = await chromium.launch({ headless: true });
    for (const scenario of ['canvas', 'mask', 'workbench-batch', 'lost-response', 'local-write-failed', 'acknowledgement-offline']) {
        const workbench = scenario === 'workbench-batch';
        const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
        await context.addInitScript(() => localStorage.setItem('infinite-canvas:ai_config_store', JSON.stringify({ state: { config: { canvasImageCount: '1' } } })));
        const page = await context.newPage();
        const errors = [], taskIds = [];
        let posts = 0, acknowledgements = 0, blockAcknowledgement = scenario === 'acknowledgement-offline';
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/api/v1/infinite/generate', async route => {
            posts++;
            const taskId = seed(route.request().postDataJSON(), png);
            taskIds.push(taskId);
            if (scenario === 'lost-response') await route.abort('failed');
            else await route.fulfill({ json: { task_id: taskId } });
        });
        await page.route('**/api/v1/tasks/*/acknowledge', async route => {
            await assertLocalOwner(page, workbench);
            acknowledgements++;
            if (blockAcknowledgement) await route.abort('failed');
            else await route.continue();
        });
        await page.goto(origin + (workbench ? '/infinite/image' : '/infinite/canvas'));
        if (workbench) {
            await page.getByPlaceholder('描述画面主体、风格、构图、光线和用途').fill('Client delivery batch');
            await page.getByRole('button', { name: '2 张', exact: true }).click();
            await page.getByRole('button', { name: '开始生成', exact: true }).click();
        } else {
            await page.getByRole('button', { name: '新建画布', exact: true }).first().click();
            await page.waitForURL('**/infinite/canvas/*');
            if (scenario === 'mask') {
                const chooser = page.waitForEvent('filechooser');
                await page.getByRole('button', { name: '上传资产', exact: true }).click();
                await (await chooser).setFiles(path.join(output, 'fixture.png'));
                await page.locator('[data-node-id]').first().hover();
                await page.getByRole('button', { name: '添加蒙版遮罩后局部修改', exact: true }).click();
                const dialog = page.getByRole('dialog');
                const canvas = dialog.locator('canvas:visible');
                await canvas.waitFor();
                const box = await canvas.boundingBox();
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                await dialog.getByPlaceholder('例如：把选中区域改成金属材质，保持原图光影').fill('Client delivery mask');
                await dialog.getByRole('button', { name: '立刻生成', exact: true }).click();
            } else {
                await page.getByRole('button', { name: '图片', exact: true }).click();
                await page.locator('[contenteditable=true]').fill('Client delivery ' + scenario);
                if (scenario === 'local-write-failed') await page.evaluate(() => {
                    const put = IDBObjectStore.prototype.put;
                    IDBObjectStore.prototype.put = function (...args) {
                        if (this.name === 'image_files') throw new DOMException('Fixture quota exceeded', 'QuotaExceededError');
                        return put.apply(this, args);
                    };
                });
                await page.getByRole('button', { name: '生成', exact: true }).click();
            }
        }
        await until(page, async () => posts === (workbench ? 2 : 1));
        if (scenario === 'lost-response' || scenario === 'local-write-failed') {
            await until(page, async () => {
                const states = await records(page, 'app_state');
                return states.some(value => String(value).includes('"status":"error"'));
            });
            assert.equal(acknowledgements, 0);
            const retained = await (await fetch(origin + '/api/v1/tasks/' + taskIds[0])).json();
            assert.equal(retained.images[0].base64, png, 'local save failure must keep the original server result');
            await page.reload();
        }
        await until(page, async () => acknowledgements >= (workbench ? 2 : 1));
        if (blockAcknowledgement) {
            const retained = await (await fetch(origin + '/api/v1/tasks/' + taskIds[0])).json();
            assert.equal(retained.images[0].base64, png);
            assert((await records(page, 'image_api_acknowledgements')).length > 0);
            blockAcknowledgement = false;
            await page.reload();
        }
        await until(page, async () => {
            const states = await Promise.all(taskIds.map(async id => (await fetch(origin + '/api/v1/tasks/' + id)).json()));
            return states.every(task => task.result_released_at && task.images.length === 0);
        });
        await until(page, async () => (await records(page, 'image_api_acknowledgements')).length === 0);
        await page.reload();
        await assertLocalOwner(page, workbench);
        assert.equal(posts, workbench ? 2 : 1, 'recovery must never create a second paid task');
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(output, `client-delivery-${scenario}.png`) });
        summaries.push({ scenario, submissions: posts, acknowledgements, serverResultReleased: true, localOwnerAndPixelsPersisted: true });
        await context.close();
    }
    assert.equal(fs.readdirSync(path.join(root, 'tasks/results')).length, 0);
    assert(!fs.existsSync(path.join(root, 'gallery/.gallery.db')), 'Infinite must not create gallery history');
    assert(!fs.existsSync(path.join(root, 'gallery/references')), 'Infinite must not archive editing inputs');
    const inspected = spawnSync(python, ['-c', "from image_api.services.tasks import database; import json;\nwith database() as db:\n rows=db.execute('SELECT snapshot FROM tasks').fetchall(); assert all(not json.loads(row[0])['images'] for row in rows); print(len(rows))"], { env: environment, encoding: 'utf8' });
    assert.equal(inspected.status, 0, inspected.stderr);
    fs.writeFileSync(path.join(output, 'client-delivery-result.json'), JSON.stringify({ cases: summaries, temporaryRoot: root, taskSnapshotsWithoutImages: Number(inspected.stdout) }, null, 2));
    console.log(JSON.stringify(summaries));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (browser) await browser.close();
    if (server) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
});
