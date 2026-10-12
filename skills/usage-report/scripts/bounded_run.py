#!/usr/bin/env python3
"""Run one noninteractive argv once; keep full output in a private local log."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


def tail(path, lines, byte_limit):
    with path.open('rb') as stream:
        stream.seek(max(0, path.stat().st_size - byte_limit))
        data = stream.read(byte_limit)
    return b'\n'.join(data.splitlines()[-lines:]).decode('utf-8', errors='replace')


def run(command, cwd=None, log_root=None, tail_lines=0, tail_bytes=2048):
    directory = Path(tempfile.mkdtemp(prefix='bounded-run-', dir=log_root))
    directory.chmod(0o700)
    log = directory / 'output.log'
    started = time.monotonic()
    launch_error = None
    with log.open('xb') as output:
        log.chmod(0o600)
        try:
            # No shell wrapping, retries, timeout, caching, or command echo.
            proc = subprocess.Popen(command, cwd=cwd, stdout=output,
                                    stderr=subprocess.STDOUT, start_new_session=(os.name == 'posix'))
        except OSError as exc:
            code = 127 if isinstance(exc, FileNotFoundError) else 126
            launch_error = type(exc).__name__
        else:
            previous = {}
            def forward(signum, _frame):
                try:
                    if os.name == 'posix':
                        os.killpg(proc.pid, signum)
                    else:
                        proc.send_signal(signum)
                except ProcessLookupError:
                    pass
            try:
                for signum in (signal.SIGINT, signal.SIGTERM):
                    previous[signum] = signal.signal(signum, forward)
                code = proc.wait()
            finally:
                for signum, handler in previous.items():
                    signal.signal(signum, handler)
    result = dict(status='launch_error' if launch_error else ('passed' if code == 0 else 'failed'),
                  exit_code=code, seconds=round(time.monotonic() - started, 3),
                  log=str(log.resolve()), log_bytes=log.stat().st_size,
                  excerpt='omitted', tail_lines=tail_lines, tail_bytes=tail_bytes)
    if launch_error:
        result['error_type'] = launch_error
    if tail_lines:
        result['excerpt'] = tail(log, tail_lines, tail_bytes)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cwd')
    parser.add_argument('--log-root', help='existing private local directory; default system temp')
    parser.add_argument('--tail-lines', type=int, default=0, help='opt-in output excerpt, 0..40 lines (default none)')
    parser.add_argument('--tail-bytes', type=int, default=2048, help='excerpt byte window, 1..4096')
    parser.add_argument('command', nargs=argparse.REMAINDER, help='-- executable arg ...; shell syntax requires explicit shell -c')
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or not 0 <= args.tail_lines <= 40 or not 1 <= args.tail_bytes <= 4096:
        parser.error('provide a command and bounded excerpt limits')
    try:
        result = run(command, args.cwd, args.log_root, args.tail_lines, args.tail_bytes)
    except OSError as exc:
        print(json.dumps(dict(status='helper_error', error_type=type(exc).__name__)))
        return 125
    print(json.dumps(result, ensure_ascii=True), flush=True)
    code = result['exit_code']
    if code < 0 and os.name == 'posix':
        if -code not in (signal.SIGKILL, signal.SIGSTOP):
            signal.signal(-code, signal.SIG_DFL)
        os.kill(os.getpid(), -code)
    return code if code >= 0 else 128 - code


if __name__ == '__main__':
    sys.exit(main())
