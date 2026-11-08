"""Read-only bridge for Prompt Portal and cached public prompt collections."""
import asyncio
import hashlib
from functools import lru_cache
import io
import json
import os
import re
import tempfile
import unicodedata
from pathlib import Path
from urllib.parse import urlparse, urljoin

import httpx
from PIL import Image

from image_api.config import settings

SOURCE_IDS = (
    'banana-prompt-quicker', 'davidwu-gpt-image2-prompts', 'freestylefly-gpt-image-2',
    'awesome-gpt-image', 'awesome-gpt4o-image-prompts', 'youmind-gpt-image-2', 'youmind-nano-banana-pro',
)
REGISTRY = 'https://raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources'
IMAGE_HOSTS = frozenset((
    'raw.githubusercontent.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
    'github-production-user-asset-6210df.s3.amazonaws.com',
    'private-user-images.githubusercontent.com', 'user-images.githubusercontent.com', 'pbs.twimg.com',
    'camo.githubusercontent.com', 'cdn.jsdelivr.net', 'cdn.imgedify.com', 'cms-assets.youmind.com',
    'linux.do', 'i.mji.rip', 'storage.googleapis.com',
))


def data_dir():
    return Path(os.environ.get('PROMPT_LIBRARY_DATA_DIR', Path(__file__).resolve().parents[2] / 'data/prompt-library'))


def portal_dir():
    return Path(os.environ.get('PROMPT_PORTAL_DATA_DIR', Path(__file__).resolve().parents[3] / 'prompt/backend'))


def read_json(path, default):
    return json.loads(path.read_text(encoding='utf-8')) if path.is_file() else default


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as f:
        json.dump(value, f, ensure_ascii=False)
        temp = Path(f.name)
    os.replace(temp, path)


def client():
    return httpx.AsyncClient(trust_env=False, proxy=os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy') or settings.packy_proxy, timeout=60)


_source_locks = {}


async def source_records(source_id, refresh=False):
    if source_id not in SOURCE_IDS:
        raise KeyError(source_id)
    path = data_dir() / 'sources' / f'{source_id}.json'
    if path.is_file() and not refresh:
        return read_json(path, [])
    lock = _source_locks.setdefault(source_id, asyncio.Lock())
    async with lock:
        if path.is_file() and not refresh:
            return read_json(path, [])
        async with client() as http:
            response = await http.get(f'{REGISTRY}/{source_id}.json')
            response.raise_for_status()
            records = response.json()
            if not isinstance(records, list) or not records or not all(isinstance(x, dict) and x.get('title') and x.get('prompt') for x in records):
                raise ValueError('来源数据为空或格式错误，保留上次内容')
            atomic_json(path, records)
            return records


def normalized_text(text):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', text).replace('\\n', '\n')).strip().casefold()


def content_key(text):
    return hashlib.sha256(normalized_text(text).encode()).hexdigest()


def chinese_body(text):
    han = len(re.findall(r'[\u4e00-\u9fff]', text))
    return han > len(re.findall(r'[a-zA-Z]', text)) / 4


def portal_records():
    root = portal_dir()
    templates = read_json(root / 'prompts_data.json', [])
    cases = read_json(root / 'data/gallery_data.json', {}).get('cases', [])
    translations = read_json(root / 'data/gallery_translations.json', {})
    # Original snapshots retain template IDs across translation. Match their exact
    # body to a case, then attach the current Chinese version with the same ID.
    originals = read_json(root / 'prompts_data.json.pre_merge.bak', [])
    originals += read_json(root / 'prompts_data.json.bak', [])
    templates_by_id = {x['id']: x for x in templates}
    translated_by_original = {content_key(x.get('prompt', '')): templates_by_id[x['id']] for x in originals if x.get('id') in templates_by_id and chinese_body(templates_by_id[x['id']].get('prompt', ''))}
    translated_by_title = {x.get('title'): x for x in templates if chinese_body(x.get('prompt', ''))}
    items = []
    matched = set()
    for case in cases:
        item = dict(case)
        title = str(item.get('title', ''))
        original = str(item.get('prompt', ''))
        zh = translations.get(str(item['id']), {}).get('prompt_cn', '')
        template = translated_by_original.get(content_key(original))
        if not template and sum(x.get('title') == title for x in cases) == 1 and sum(x.get('title') == title for x in templates) == 1:
            template = translated_by_title.get(title)
        if template:
            zh = template['prompt']
            matched.add(template['id'])
        image = item.get('imageUrl') or item.get('image', '')
        local = root / 'data/gallery_images' / image.removeprefix('/images/').removeprefix('/api/gallery/images/')
        base = (root / 'data/gallery_images').resolve()
        local = local.resolve()
        if not local.is_relative_to(base) or not local.is_file():
            local = None
        items.append({
            'id': f'portal:case:{item["id"]}', 'title': title, 'prompt': original,
            'promptZh': zh.replace('\\n', '\n'), 'translationLabel': '本机中文版本' if template else '已有中文译文', 'description': '', 'tags': [item.get('category', ''), *item.get('styles', []), *item.get('scenes', [])],
            'coverUrl': f'https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data/images/case{item["id"]}.jpg',
            'sourceUrl': item.get('sourceUrl', ''), 'author': item.get('sourceLabel', ''),
            '_localImage': str(local) if local else '',
        })
    for item in templates:
        if item['id'] in matched:
            continue
        items.append({**item, 'id': f'portal:template:{item["id"]}', 'tags': [item.get('category', ''), *item.get('styles', []), *item.get('scenes', [])], 'prompt': item['prompt'], 'coverUrl': item.get('imageUrl', ''), 'description': item.get('description', '')})
    return items


def enrichment():
    records = portal_records()
    by_body = {}
    by_image = {}
    for item in records:
        by_body[content_key(item['prompt'])] = item
        if item.get('coverUrl'):
            by_image[item['coverUrl']] = item
    return records, by_body, by_image


def image_id(url):
    return hashlib.sha256(url.encode()).hexdigest()


def safe_image_url(url):
    parsed = urlparse(url)
    return parsed.scheme == 'https' and parsed.hostname in IMAGE_HOSTS and not parsed.username and not parsed.password and parsed.port in (None, 443)


def image_url(url):
    return f'/api/v1/infinite/prompt-library/images/{image_id(url)}' if url and safe_image_url(url) else ''


def prepare_records(records):
    _, by_body, by_image = enrichment()
    result = []
    for raw in records:
        item = {k: v for k, v in raw.items() if not k.startswith('_')}
        body = str(item.get('prompt', ''))
        known = by_body.get(content_key(body))
        # An exact image reference gives a stable case identity across these mirrors;
        # translations attach only to an exact original body match.
        image_case = by_image.get(item.get('coverUrl', ''))
        if known and known.get('promptZh'):
            item['promptZh'] = known['promptZh']
            item['translationLabel'] = known.get('translationLabel', '')
        elif image_case and content_key(image_case['prompt']) == content_key(body):
            item['promptZh'] = image_case.get('promptZh', '')
        cached_translation = read_json(data_dir() / 'translations' / f'{content_key(body)}.json', {})
        if cached_translation.get('promptZh'):
            item.update(cached_translation)
        item['prompt'] = body
        item['originalPrompt'] = body
        item['canonicalKey'] = content_key(body)
        item['coverUrl'] = image_url(item.get('coverUrl', ''))
        item['referenceImageUrls'] = list(dict.fromkeys(filter(None, [item['coverUrl'], *(image_url(x) for x in raw.get('referenceImageUrls', []))])))
        result.append(item)
    return result


def catalog_signature():
    paths = [portal_dir() / 'prompts_data.json', portal_dir() / 'data/gallery_data.json', portal_dir() / 'data/gallery_translations.json',
             *(data_dir() / 'sources' / f'{source_id}.json' for source_id in SOURCE_IDS)]
    return tuple((str(path), path.stat().st_mtime_ns if path.is_file() else 0) for path in paths)


def image_registry():
    return _image_registry(catalog_signature())


@lru_cache(maxsize=1)
def _image_registry(signature):
    records, _, _ = enrichment()
    for source_id in SOURCE_IDS:
        records.extend(read_json(data_dir() / 'sources' / f'{source_id}.json', []))
    images = {}
    for item in records:
        for url in [item.get('coverUrl', ''), *item.get('referenceImageUrls', [])]:
            if url and safe_image_url(url):
                key = image_id(url)
                previous = images.get(key)
                if not previous or item.get('_localImage'):
                    images[key] = (url, item.get('_localImage', ''))
    return images


async def cached_image(key):
    # The caller supplies a catalog image ID, never a URL or a file path.
    entry = image_registry().get(key)
    if not entry:
        raise KeyError(key)
    url, local = entry
    if local and Path(local).is_file():
        return Path(local)
    path = data_dir() / 'images' / key
    if path.is_file():
        return path
    async with client() as http:
        for _ in range(http.max_redirects + 1):
            if not safe_image_url(url):
                raise ValueError('图片重定向地址不受支持')
            response = await http.get(url)
            if response.is_redirect:
                url = urljoin(url, response.headers["location"])
                continue
            response.raise_for_status()
            payload = response.content
            break
        else:
            raise ValueError('图片重定向过多')
    with Image.open(io.BytesIO(payload)) as image:
        image.verify()
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temp:
        temp.write(payload)
        temp_path = Path(temp.name)
    os.replace(temp_path, path)
    return path
