"""Fixed PTY bridge. Runs only inside the preview isolate, never on the host."""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios

pid, master = pty.fork()
if pid == 0:
    os.execve('/bin/bash', ['bash', '--noprofile', '--norc', '-i'], {
        'PATH': '/usr/local/bin:/usr/bin:/bin',
        'HOME': os.getcwd(),
        'TERM': 'xterm-256color',
        'LANG': 'C.UTF-8',
        'PS1': r'\w [exit:$?] \$ ',
    })
os.set_blocking(master, False)
print(json.dumps({'ready': True}), flush=True)
incoming = b''
pending = b''
try:
    while True:
        readable, writable, _ = select.select([master, 0], [master] if pending else [], [])
        if master in writable:
            try:
                count = os.write(master, pending)
                pending = pending[count:]
                print(json.dumps({'drained': count}), flush=True)
            except BlockingIOError:
                pass
        if master in readable:
            try:
                data = os.read(master, 16384)
            except OSError:
                break
            if not data:
                break
            print(json.dumps({'data': base64.b64encode(data).decode('ascii')}), flush=True)
        if 0 in readable:
            data = os.read(0, 65536)
            if not data:
                break
            incoming += data
            if len(incoming) > 262144:
                break
            while b'\n' in incoming:
                line, incoming = incoming.split(b'\n', 1)
                message = json.loads(line)
                if message['type'] == 'input':
                    pending += base64.b64decode(message['data'], validate=True)
                    if len(pending) > 65536:
                        raise ValueError('input capacity exceeded')
                elif message['type'] == 'resize':
                    fcntl.ioctl(master, termios.TIOCSWINSZ,
                                struct.pack('HHHH', message['rows'], message['cols'], 0, 0))
finally:
    # Close the controlling terminal and kill its shell/foreground job. The
    # container lifecycle removes every remaining process on reset/expiry.
    try:
        foreground = os.tcgetpgrp(master)
        if foreground > 1:
            os.killpg(foreground, signal.SIGKILL)
    except OSError:
        pass
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        pass
    os.close(master)
    _, status = os.waitpid(pid, 0)
    print(json.dumps({'exitCode': os.waitstatus_to_exitcode(status)}), flush=True)
