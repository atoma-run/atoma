#!/usr/bin/env python3
"""macOS OAuth header helper: one locked refresh owner, no server policy changes."""
import argparse
import base64
import contextlib
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ORIGIN = 'https://atoma.run'
RESOURCE = ORIGIN + '/mcp'
SERVICE = 'run.atoma.codex-oauth.v1'
ACCOUNT = 'atoma-codex'
STATE_DIR = Path.home() / '.atoma' / 'codex-auth'


class AuthError(Exception):
    pass


class TemporarilyUnavailable(AuthError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise AuthError('OAuth redirects are not allowed at credential endpoints')


def post(path, data, registration=False):
    body = json.dumps(data).encode() if registration else urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(ORIGIN + path, data=body, headers={
        'Content-Type': 'application/json' if registration else 'application/x-www-form-urlencoded',
        'User-Agent': 'atoma-codex-auth/1'})
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as response:
            raw = response.read(65537)
            if len(raw) > 65536:
                raise AuthError('OAuth response exceeds limit')
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        # The deployment gate rejects this request before the token handler runs.
        # Other HTTP failures may follow consumption and remain uncertain.
        if path == '/oauth/token' and error.code == 503:
            try:
                raw = error.read(65537)
                value = json.loads(raw) if len(raw) <= 65536 else None
            except Exception:
                value = None
            if isinstance(value, dict) and value.get('error') == 'temporarily_unavailable':
                raise TemporarilyUnavailable('Atoma is temporarily unavailable; retry shortly') from None
        raise AuthError('OAuth request failed; reconnect if renewal state is uncertain') from None
    except Exception:
        # Never echo a request, response, code, or token through diagnostics.
        raise AuthError('OAuth request failed; reconnect if renewal state is uncertain') from None


class Keychain:
    def load(self):
        result = subprocess.run(['/usr/bin/security', 'find-generic-password', '-s', SERVICE,
                                 '-a', ACCOUNT, '-w'], capture_output=True, timeout=5)
        if result.returncode:
            raise AuthError('OAuth credentials unavailable in macOS Keychain; run login')
        try:
            return json.loads(base64.b64decode(result.stdout.strip(), validate=True))
        except Exception:
            raise AuthError('Invalid Keychain state; run login') from None

    def save(self, value):
        encoded = base64.b64encode(json.dumps(value).encode()).decode()
        # Feed the password on stdin, never in process arguments or shell history.
        command = 'add-generic-password -U -s ' + SERVICE + ' -a ' + ACCOUNT + ' -w ' + encoded + '\n'
        result = subprocess.run(['/usr/bin/security', '-i'], input=command.encode(), capture_output=True, timeout=5)
        if result.returncode:
            raise AuthError('Unable to persist OAuth state in macOS Keychain')
        if self.load() != value:
            raise AuthError('Keychain write verification failed')


@contextlib.contextmanager
def locked(directory=STATE_DIR, timeout=25):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise AuthError('OAuth state directory must be private and owned by the current user')
    fd = os.open(directory / 'refresh.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
            raise AuthError('Unsafe OAuth lock file')
        until = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= until:
                    raise AuthError('OAuth renewal busy; no credential was reused')
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)  # kernel releases the lock on normal exit and process death


def token_state(client_id, tokens, now=None):
    if (tokens.get('token_type', '').lower() != 'bearer' or
            not isinstance(tokens.get('access_token'), str) or not tokens['access_token'] or
            not isinstance(tokens.get('refresh_token'), str) or not tokens['refresh_token'] or
            not isinstance(tokens.get('expires_in'), (int, float)) or tokens['expires_in'] <= 0):
        raise AuthError('Invalid OAuth token response; reconnect')
    if any(not value.isascii() or any(ord(c) < 33 or ord(c) > 126 for c in value)
           for value in (tokens['access_token'], tokens['refresh_token'])):
        raise AuthError('Invalid OAuth credential encoding')
    return {'client_id': client_id, 'resource': RESOURCE, 'phase': 'ready',
            'access_token': tokens['access_token'], 'refresh_token': tokens['refresh_token'],
            'expires_at': (time.time() if now is None else now) + tokens['expires_in']}


def headers(store, directory=STATE_DIR, exchange=post, now=time.time):
    with locked(directory):
        state = store.load()  # reread AFTER acquiring the cross-process lock
        if state.get('resource') != RESOURCE or state.get('phase') != 'ready':
            raise AuthError('OAuth renewal outcome uncertain; reconnect instead of replaying a credential')
        if state['expires_at'] <= now() + 30:
            # Crash/lost response cannot lead another process to replay the old refresh token.
            store.save({**state, 'phase': 'renewing'})
            try:
                tokens = exchange('/oauth/token', {'grant_type': 'refresh_token',
                    'client_id': state['client_id'], 'resource': RESOURCE,
                    'refresh_token': state['refresh_token']})
            except TemporarilyUnavailable:
                store.save(state)  # Explicit pre-consumption refusal; the refresh remains unused.
                raise
            state = token_state(state['client_id'], tokens, now())
            store.save(state)
        return {'Authorization': 'Bearer ' + state['access_token']}


def managed_headers(store, directory=STATE_DIR, exchange=post, deadline_seconds=75):
    """Keep the locked refresh owner alive beyond Codex's ten-second helper deadline."""
    read_fd, write_fd = os.pipe()
    try:
        pid = os.fork()
    except BaseException:
        os.close(read_fd)
        os.close(write_fd)
        raise
    if pid == 0:
        # Detach before locking or touching credentials. No inherited client pipe
        # remains open; a killed client cannot kill or wait on the renewal owner.
        try:
            os.close(read_fd)
            os.setsid()
            null = os.open(os.devnull, os.O_RDWR)
            for descriptor in (0, 1, 2):
                os.dup2(null, descriptor)
            if null > 2:
                os.close(null)
            def deadline(_signal, _frame):
                raise AuthError('OAuth renewal deadline exceeded')
            signal.signal(signal.SIGALRM, deadline)
            signal.alarm(deadline_seconds)  # Includes lock wait, network and bounded Keychain operations.
            result = headers(store, directory, exchange)
            payload = json.dumps(result).encode()
            if len(payload) > 4096:
                raise AuthError('OAuth helper response exceeds limit')
            try:
                os.write(write_fd, payload)
            except BrokenPipeError:
                pass  # Persistence succeeded; the client can read it on its next connection.
            code = 0
        except TemporarilyUnavailable:
            code = 75
        except BaseException:
            code = 1
        finally:
            os.close(write_fd)
        os._exit(code)
    os.close(write_fd)
    try:
        _pid, status = os.waitpid(pid, 0)
        if os.WIFEXITED(status) and os.WEXITSTATUS(status) == 75:
            raise TemporarilyUnavailable('Atoma is temporarily unavailable; OAuth credentials retained; retry shortly')
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0:
            raise AuthError('OAuth renewal failed; inspect helper status before reconnecting')
        result = json.loads(os.read(read_fd, 4097))
        if not isinstance(result, dict) or set(result) != {'Authorization'} or not isinstance(result['Authorization'], str):
            raise AuthError('Invalid OAuth helper response')
        return result
    finally:
        os.close(read_fd)


def login(store):
    # Separate grant: old native Codex clients cannot revoke this helper's credentials.
    verifier = secrets.token_urlsafe(48)
    state = secrets.token_urlsafe(32)
    received = {}

    class Callback(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def log_message(self, *_args):
            pass

        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(url.query)
            valid = (url.path == '/callback' and query.get('state') == [state] and
                     query.get('iss') == [ORIGIN] and len(query.get('code', [])) == 1)
            if valid:
                received['code'] = query['code'][0]
            self.send_response(200 if valid else 400)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers()
            self.wfile.write(b'Authorization received. You can close this tab.' if valid else b'Invalid callback.')

    with locked(timeout=2), http.server.HTTPServer(('127.0.0.1', 0), Callback) as server:
        server.timeout = 1
        callback = 'http://127.0.0.1:' + str(server.server_port) + '/callback'
        client = post('/oauth/register', {'client_name': 'Atoma Codex serialized OAuth helper',
            'redirect_uris': [callback], 'token_endpoint_auth_method': 'none'}, registration=True)
        client_id = client.get('client_id')
        if not isinstance(client_id, str) or not client_id:
            raise AuthError('OAuth registration failed')
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        url = ORIGIN + '/oauth/authorize?' + urllib.parse.urlencode({'client_id': client_id,
            'redirect_uri': callback, 'response_type': 'code', 'code_challenge': challenge,
            'code_challenge_method': 'S256', 'resource': RESOURCE, 'scope': 'mcp', 'state': state})
        subprocess.run(['/usr/bin/open', url], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print('Approve the dedicated Atoma connection in your browser.', flush=True)
        until = time.monotonic() + 300
        while not received and time.monotonic() < until:
            server.handle_request()
        if not received:
            raise AuthError('Authorization timed out; no code was exchanged')
        tokens = post('/oauth/token', {'grant_type': 'authorization_code', 'client_id': client_id,
            'code': received['code'], 'redirect_uri': callback, 'code_verifier': verifier, 'resource': RESOURCE})
        store.save(token_state(client_id, tokens))
        print('OAuth credentials saved in macOS Keychain. No credential written to configuration.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['headers', 'login', 'status'])
    args = parser.parse_args()
    store = Keychain()
    try:
        if args.action == 'headers':
            print(json.dumps(managed_headers(store)))
        elif args.action == 'login':
            login(store)
        else:
            with locked():
                value = store.load()
                print(json.dumps({'phase': value.get('phase'), 'resource': value.get('resource'),
                                  'expires_at': value.get('expires_at')}))
    except Exception as error:
        print(str(error) if isinstance(error, AuthError) else 'OAuth helper failed; no credentials emitted', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
