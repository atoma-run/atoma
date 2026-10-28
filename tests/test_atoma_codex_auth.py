"""No real credentials or network: exercise the actual helper across processes."""
import importlib.util
import io
import json
import urllib.parse
import os
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/atoma-codex-auth.py'
spec = importlib.util.spec_from_file_location('helper', SCRIPT)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class Store:
    def __init__(self, path):
        self.path = path

    def load(self):
        return json.loads(self.path.read_text())

    def save(self, value):
        self.path.write_text(json.dumps(value))


class OAuthHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = Store(self.root / 'fake-test-credentials.json')
        self.store.save(helper.token_state('test-client', {'token_type': 'Bearer',
            'access_token': 'expired-test-access', 'refresh_token': 'test-refresh', 'expires_in': 1}, 0))

    def tearDown(self):
        self.temp.cleanup()

    def test_parallel_processes_refresh_once_and_all_read_the_winner(self):
        code = '''
import importlib.util,json,pathlib,sys,time
spec=importlib.util.spec_from_file_location('helper',sys.argv[1]); h=importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
p=pathlib.Path(sys.argv[2])
class Store:
 def load(self):return json.loads((p/'fake-test-credentials.json').read_text())
 def save(self,v):(p/'fake-test-credentials.json').write_text(json.dumps(v))
def exchange(path,data):
 with (p/'exchanges').open('a') as f:f.write('one\\n')
 time.sleep(.1)
 return dict(token_type='Bearer',access_token='new-test-access',refresh_token='new-test-refresh',expires_in=3600)
print(json.dumps(h.managed_headers(Store(),p,exchange)))
'''
        processes = [subprocess.Popen([sys.executable, '-c', code, str(SCRIPT), str(self.root)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(12)]
        outputs = [p.communicate(timeout=10) for p in processes]
        self.assertTrue(all(p.returncode == 0 for p in processes), outputs)
        self.assertEqual((self.root / 'exchanges').read_text(), 'one\n')
        self.assertEqual([json.loads(out) for out, _err in outputs], [{'Authorization': 'Bearer new-test-access'}] * 12)

    def test_lost_response_never_replays_refresh(self):
        calls = []
        def uncertain(_path, _data):
            calls.append(1)
            raise helper.AuthError('lost response')
        with self.assertRaises(helper.AuthError):
            helper.headers(self.store, self.root, uncertain)
        self.assertEqual(self.store.load()['phase'], 'renewing')
        with self.assertRaisesRegex(helper.AuthError, 'uncertain'):
            helper.headers(self.store, self.root, uncertain)
        self.assertEqual(len(calls), 1)

    def test_process_death_releases_lock_but_does_not_replay_credential(self):
        code = '''
import importlib.util,json,pathlib,sys,os
spec=importlib.util.spec_from_file_location('helper',sys.argv[1]);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h);p=pathlib.Path(sys.argv[2])
class Store:
 def load(self):return json.loads((p/'fake-test-credentials.json').read_text())
 def save(self,v):(p/'fake-test-credentials.json').write_text(json.dumps(v))
def exchange(*args):os._exit(17)
h.headers(Store(),p,exchange)
'''
        outcome = subprocess.run([sys.executable, '-c', code, str(SCRIPT), str(self.root)])
        self.assertEqual(outcome.returncode, 17)
        with self.assertRaisesRegex(helper.AuthError, 'uncertain'):
            helper.headers(self.store, self.root, lambda *_: self.fail('must not replay'))

    def test_revocation_is_not_hidden_by_a_cached_access_token(self):
        def revoked(*_args):
            raise helper.AuthError('invalid grant')
        with self.assertRaises(helper.AuthError):
            helper.headers(self.store, self.root, revoked)
        self.assertEqual(self.store.load()['phase'], 'renewing')

    def test_unexpired_token_does_not_refresh(self):
        self.store.save(helper.token_state('test-client', {'token_type': 'Bearer',
            'access_token': 'fresh', 'refresh_token': 'test-refresh', 'expires_in': 3600}))
        self.assertEqual(helper.headers(self.store, self.root, lambda *_: self.fail('must not refresh')),
                         {'Authorization': 'Bearer fresh'})

    def test_foreign_resource_is_refused(self):
        state = self.store.load(); state['resource'] = 'https://other.invalid/mcp'; self.store.save(state)
        with self.assertRaises(helper.AuthError):
            helper.headers(self.store, self.root, lambda *_: self.fail('must not send credentials'))

    def test_symlink_lock_and_public_directory_are_refused(self):
        (self.root / 'refresh.lock').symlink_to(self.root / 'fake-test-credentials.json')
        with self.assertRaises(OSError):
            helper.headers(self.store, self.root)
        (self.root / 'refresh.lock').unlink()
        os.chmod(self.root, 0o755)
        with self.assertRaisesRegex(helper.AuthError, 'private'):
            helper.headers(self.store, self.root)

    def test_malformed_rotation_does_not_replay(self):
        with self.assertRaises(helper.AuthError):
            helper.headers(self.store, self.root, lambda *_: {'access_token': 'incomplete'})
        self.assertEqual(self.store.load()['phase'], 'renewing')

    def test_managed_headers_returns_only_persisted_credentials(self):
        result = helper.managed_headers(self.store, self.root, lambda *_: {
            'token_type': 'Bearer', 'access_token': 'new-test-access',
            'refresh_token': 'new-test-refresh', 'expires_in': 3600})
        self.assertEqual(result, {'Authorization': 'Bearer new-test-access'})
        self.assertEqual(self.store.load()['phase'], 'ready')
        self.assertEqual(self.store.load()['access_token'], 'new-test-access')

    def test_managed_worker_death_does_not_replay_refresh(self):
        def die(*_args):
            (self.root / 'attempted').write_text('once')
            os._exit(17)
        with self.assertRaises(helper.AuthError):
            helper.managed_headers(self.store, self.root, die)
        self.assertEqual(self.store.load()['phase'], 'renewing')
        with self.assertRaises(helper.AuthError):
            helper.managed_headers(self.store, self.root, lambda *_: (self.root / 'replayed').touch())
        self.assertFalse((self.root / 'replayed').exists())

    def test_only_the_explicit_pre_consumption_http_error_is_retryable(self):
        for status, body, retryable in [
            (503, b'{"error":"temporarily_unavailable"}', True),
            (500, b'{"error":"temporarily_unavailable"}', False),
            (503, b'{"error":"server_error"}', False),
            (503, b'not json', False), (503, b'[]', False),
            (503, b'x' * 65537, False),
        ]:
            with self.subTest(status=status, body=body[:40]):
                error = helper.urllib.error.HTTPError(helper.ORIGIN + '/oauth/token', status,
                    'fixture', {}, io.BytesIO(body))
                with patch.object(helper.urllib.request, 'build_opener') as factory:
                    factory.return_value.open.side_effect = error
                    expected = helper.TemporarilyUnavailable if retryable else helper.AuthError
                    with self.assertRaises(expected) as raised:
                        helper.post('/oauth/token', {'refresh_token': 'test-only'})
                    if not retryable:
                        self.assertNotIsInstance(raised.exception, helper.TemporarilyUnavailable)
        error = helper.urllib.error.HTTPError(helper.ORIGIN + '/oauth/register', 503,
            'fixture', {}, io.BytesIO(b'{"error":"temporarily_unavailable"}'))
        with patch.object(helper.urllib.request, 'build_opener') as factory:
            factory.return_value.open.side_effect = error
            with self.assertRaises(helper.AuthError) as raised:
                helper.post('/oauth/register', {}, registration=True)
            self.assertNotIsInstance(raised.exception, helper.TemporarilyUnavailable)

    def test_worker_deadline_reaps_a_delayed_keychain_write_before_unlocking(self):
        root = self.root
        class DelayedStore(Store):
            def save(self, value):
                if value.get('phase') == 'ready':
                    (root / 'save-started').touch()
                    code = "import pathlib,sys,time;time.sleep(2);pathlib.Path(sys.argv[1]).write_text(sys.argv[2])"
                    subprocess.run([sys.executable, '-c', code, str(self.path), json.dumps(value)],
                                   check=True, timeout=5, capture_output=True)
                else:
                    super().save(value)
        with self.assertRaises(helper.AuthError):
            helper.managed_headers(DelayedStore(self.store.path), root, lambda *_: {
                'token_type': 'Bearer', 'access_token': 'late-test-access',
                'refresh_token': 'late-test-refresh', 'expires_in': 3600}, deadline_seconds=1)
        self.assertTrue((root / 'save-started').exists())
        self.assertEqual(self.store.load()['phase'], 'renewing')
        replacement = {**self.store.load(), 'phase': 'ready', 'access_token': 'replacement-test-access'}
        with helper.locked(root, timeout=1):
            self.store.save(replacement)
            time.sleep(1.5)
            self.assertEqual(self.store.load(), replacement, 'an orphaned Keychain writer raced the new login')

    def test_explicit_unavailable_response_retains_unused_refresh(self):
        before = self.store.load()
        def unavailable(*_args):
            raise helper.TemporarilyUnavailable('deployment in progress')
        with self.assertRaises(helper.TemporarilyUnavailable):
            helper.managed_headers(self.store, self.root, unavailable)
        self.assertEqual(self.store.load(), before)
        self.assertEqual(helper.managed_headers(self.store, self.root, lambda *_: {
            'token_type': 'Bearer', 'access_token': 'retry-test-access',
            'refresh_token': 'retry-test-refresh', 'expires_in': 3600}),
            {'Authorization': 'Bearer retry-test-access'})

    def test_killed_client_group_does_not_interrupt_rotation_or_hold_client_pipes(self):
        received, respond = threading.Event(), threading.Event()
        requests = []
        class Endpoint(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass
            def do_POST(self):
                requests.append(urllib.parse.parse_qs(
                    self.rfile.read(int(self.headers['Content-Length'])).decode()))
                received.set()
                respond.wait(8)
                body = json.dumps({'token_type': 'Bearer', 'access_token': 'surviving-test-access',
                    'refresh_token': 'surviving-test-refresh', 'expires_in': 3600}).encode()
                self.send_response(200); self.send_header('Content-Length', str(len(body)))
                self.end_headers(); self.wfile.write(body)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Endpoint)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        code = """
import functools,importlib.util,json,pathlib,sys
spec=importlib.util.spec_from_file_location('helper',sys.argv[1]);h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
p=pathlib.Path(sys.argv[2])
class Store:
 def load(self):return json.loads((p/'fake-test-credentials.json').read_text())
 def save(self,v):(p/'fake-test-credentials.json').write_text(json.dumps(v))
h.Keychain=Store;h.ORIGIN=sys.argv[3]
h.managed_headers=functools.partial(h.managed_headers,directory=p)
sys.argv=['auth.py','headers'];sys.exit(h.main())
"""
        args = [sys.executable, '-c', code, str(SCRIPT), str(self.root),
                'http://127.0.0.1:' + str(server.server_port)]
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            self.assertTrue(received.wait(5), 'the real token request did not arrive')
            self.assertEqual(self.store.load()['phase'], 'renewing')
            os.killpg(process.pid, signal.SIGKILL)
            self.assertEqual(process.communicate(timeout=2), (b'', b''))
            respond.set()
            until = time.monotonic() + 5
            while time.monotonic() < until:
                try:
                    if self.store.load().get('phase') == 'ready':
                        break
                except json.JSONDecodeError:
                    pass
                time.sleep(.02)
            self.assertEqual(self.store.load()['phase'], 'ready')
            result = subprocess.run(args, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {'Authorization': 'Bearer surviving-test-access'})
            self.assertEqual(len(requests), 1, 'the successor must read the saved winner, never replay refresh')
        finally:
            respond.set()
            if process.poll() is None:
                process.kill(); process.communicate(timeout=2)
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_redirect_at_token_endpoint_is_refused(self):
        with self.assertRaises(helper.AuthError):
            helper.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid')


if __name__ == '__main__':
    unittest.main()
