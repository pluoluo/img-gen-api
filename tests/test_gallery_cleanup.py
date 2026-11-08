import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from image_api.main import app
from image_api.services import gallery


class GalleryCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'thumbs').mkdir()
        self.patches = [patch.object(gallery, '_conn', None), patch.object(gallery, 'GALLERY_DIR', self.root), patch.object(gallery, 'GALLERY_DB', self.root / 'test.db'), patch.object(gallery, 'THUMB_DIR', self.root / 'thumbs')]
        for item in self.patches:
            item.start()
        self.conn = gallery._get_conn()
        self.client = TestClient(app)

    def tearDown(self):
        self.conn.close()
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def add(self, key, created='2020-01-01T12:00:00', filename=None):
        filename = filename or key + '.png'
        self.conn.execute('INSERT INTO images VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', (key, created, 'test', 'test', key, '', '', 1, None, filename))
        self.conn.execute('INSERT INTO image_tasks VALUES (?, ?)', (key, 'task'))
        self.conn.commit()
        if '/' not in filename:
            (self.root / filename).write_bytes(b'image')
            (self.root / 'thumbs' / ('thumb_' + filename)).write_bytes(b'thumbnail')

    def preview(self):
        return self.client.post('/api/v1/gallery/cleanup/preview', json={'before': '2024-01-01'}).json()

    def delete(self, snapshot):
        return self.client.post('/api/v1/gallery/cleanup', json={k: snapshot[k] for k in ('before', 'fingerprint')})

    def test_calendar_presets_and_validation(self):
        self.assertEqual(gallery.cleanup_before_date(months=1, today=date(2024, 3, 31)), date(2024, 2, 29))
        self.assertEqual(gallery.cleanup_before_date(months=3, today=date(2024, 3, 31)), date(2023, 12, 31))
        self.assertEqual(gallery.cleanup_before_date(months=6, today=date(2024, 3, 31)), date(2023, 9, 30))
        for body in ({}, {'months': 2}, {'months': 1, 'before': '2024-01-01'}, {'before': '9999-01-01'}, {'before': 'bad'}):
            self.assertEqual(self.client.post('/api/v1/gallery/cleanup/preview', json=body).status_code, 422)
        self.assertEqual(self.client.post('/api/v1/gallery/cleanup', json={'before': '2024-01-01', 'fingerprint': 'bad'}).status_code, 422)

    def test_preview_all_pages_then_delete_preserves_boundary_references_and_shared_files(self):
        for i in range(30):
            self.add(str(i))
        self.add('boundary', '2024-01-01T00:00:00')
        self.add('unknown', 'bad-date')
        self.add('recent', '2024-02-01T00:00:00', '0.png')
        self.conn.execute('INSERT INTO generation_inputs VALUES (?, ?)', ('task', '{}'))
        self.conn.commit()
        refs = self.root / 'references'
        refs.mkdir()
        (refs / 'original.png').write_bytes(b'reference')
        snapshot = self.preview()
        self.assertEqual(snapshot['count'], 30)
        self.assertTrue((self.root / '1.png').exists())
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM images').fetchone()[0], 33)
        result = self.delete(snapshot)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['deleted'], 30)
        self.assertFalse((self.root / '1.png').exists())
        self.assertFalse((self.root / 'thumbs/thumb_1.png').exists())
        self.assertTrue((self.root / '0.png').exists())
        self.assertTrue((refs / 'original.png').exists())
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM images').fetchone()[0], 3)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM image_tasks').fetchone()[0], 3)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM generation_inputs').fetchone()[0], 1)

    def test_same_count_changed_set_rejected_without_deletion(self):
        self.add('old')
        snapshot = self.preview()
        self.conn.execute("UPDATE images SET id='replacement' WHERE id='old'")
        self.conn.commit()
        self.assertEqual(self.delete(snapshot).status_code, 409)
        self.assertTrue((self.root / 'old.png').exists())
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM images').fetchone()[0], 1)

    def test_missing_files_and_repeat_confirmation(self):
        self.add('missing')
        (self.root / 'missing.png').unlink()
        snapshot = self.preview()
        self.assertEqual(self.delete(snapshot).json()['failed_files'], [])
        self.assertEqual(self.delete(snapshot).status_code, 409)
        self.assertEqual(self.preview()['count'], 0)

    def test_unsafe_paths_and_failed_unlinks_are_reported(self):
        self.add('unsafe', filename='../outside.png')
        self.add('locked')
        original_unlink = Path.unlink
        def unlink(path, *args, **kwargs):
            if path == self.root / 'locked.png':
                raise PermissionError('test')
            return original_unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', unlink):
            result = self.delete(self.preview()).json()
        self.assertEqual(result['deleted'], 2)
        self.assertIn('../outside.png', result['failed_files'])
        self.assertIn('locked.png', result['failed_files'])
        self.assertTrue((self.root / 'locked.png').exists())

    def test_aware_dates_use_server_local_day(self):
        self.add('aware', '2023-12-30T12:00:00+00:00')
        self.assertEqual(self.preview()['count'], 1)

    def test_date_filter_boundaries_total_pagination_and_keyword(self):
        for index in range(30):
            self.add(f'old-{index}', '2023-12-31T23:59:59')
        self.add('start', '2024-01-01T00:00:00')
        self.add('end', '2024-01-31T23:59:59.999999')
        self.add('next', '2024-02-01T00:00:00')
        self.add('unknown', 'invalid')
        def listing(**params):
            return self.client.get('/api/v1/gallery', params=params).json()
        result = listing(start_date='2024-01-01', end_date='2024-01-31', limit=1)
        self.assertEqual(result['total'], 2)
        self.assertEqual(result['items'][0]['id'], 'end')
        self.assertEqual(listing(start_date='2024-01-01', end_date='2024-01-31', offset=1)['items'][0]['id'], 'start')
        self.assertEqual(listing(end_date='2023-12-31', limit=2, offset=24)['total'], 30)
        self.assertEqual(listing(start_date='2024-01-31', keyword='next')['total'], 1)
        self.assertEqual(listing(start_date='2024-01-31', keyword='old')['total'], 0)
        self.assertEqual(listing(end_date='2019-01-01'), {'items': [], 'total': 0})
        self.assertEqual(listing()['total'], 34)
        self.assertEqual(self.client.get('/api/v1/gallery?start_date=2024-02-01&end_date=2024-01-01').status_code, 422)
        self.assertEqual(self.client.get('/api/v1/gallery?end_date=not-a-date').status_code, 422)

    def test_cleanup_preview_matches_date_filter_in_server_timezone(self):
        self.add('aware', '2023-12-31T23:30:00-05:00')
        self.add('old')
        self.add('invalid', 'invalid')
        expected = self.preview()['count']
        result = self.client.get('/api/v1/gallery?end_date=2023-12-31').json()
        self.assertEqual(result['total'], expected)
