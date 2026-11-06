"""Explicitly invoked real probe: one short text request and one low-quality image."""
import asyncio
import base64
import json
from pathlib import Path

import httpx


async def main():
    root = Path('data/infinite-validation')
    root.mkdir(exist_ok=True, parents=True)
    async with httpx.AsyncClient(base_url='http://127.0.0.1:8770', timeout=None, trust_env=False) as client:
        response = await client.post('/api/v1/infinite/openai/v1/chat/completions', json={
            'model': 'gpt-4.1-mini', 'messages': [{'role': 'user', 'content': 'Reply exactly OK'}], 'max_tokens': 4,
        })
        summary = {'text_status': response.status_code}
        if response.status_code == 200:
            summary['text'] = response.json().get('choices', [{}])[0].get('message', {}).get('content')
        print('text_status', response.status_code, flush=True)
        submission = await client.post('/api/v1/infinite/generate', json={
            'sub_model': 'gpt-image-2.5-flare', 'prompt': 'A single green circle centered on a plain white background. Minimal flat graphic. No text.',
            'size': '1024x1024', 'quality': 'low', 'n': 1, 'client_request_id': 'infinite-integration-real-probe-1',
        })
        submission.raise_for_status()
        task_id = submission.json()['task_id']
        summary['task_id'] = task_id
        print('task_id', task_id, flush=True)
        while True:
            response = await client.get('/api/v1/tasks/' + task_id)
            response.raise_for_status()
            task = response.json()
            if task['status'] in ('completed', 'failed'):
                summary.update(image_status=task['status'], image_count=len(task.get('images', [])), error=task.get('error'))
                if task.get('images') and task['images'][0].get('base64'):
                    (root / 'real-generated.png').write_bytes(base64.b64decode(task['images'][0]['base64']))
                (root / 'real-probe.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
                print(json.dumps(summary, ensure_ascii=False), flush=True)
                break
            await asyncio.sleep(3)


if __name__ == '__main__':
    asyncio.run(main())
