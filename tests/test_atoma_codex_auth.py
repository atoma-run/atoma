"""No real credentials or network: exercise the actual helper across processes."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

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
print(json.dumps(h.headers(Store(),p,exchange)))
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

    def test_redirect_at_token_endpoint_is_refused(self):
        with self.assertRaises(helper.AuthError):
            helper.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid')


if __name__ == '__main__':
    unittest.main()
