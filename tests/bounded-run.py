#!/usr/bin/env python3
"""Synthetic checks only; commands do not touch real projects or services."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'skills/usage-report/scripts/bounded_run.py'


class BoundedRun(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def invoke(self, command, *options):
        result = subprocess.run([sys.executable, str(SCRIPT), '--log-root', self.tmp.name,
                                 *options, '--', *command], capture_output=True, text=True)
        return result, json.loads(result.stdout)

    def test_success_large_output_private_and_once(self):
        marker = Path(self.tmp.name) / 'count'
        command = [sys.executable, '-c',
                   'import pathlib,sys; p=pathlib.Path(sys.argv[1]); '
                   'p.write_text(p.read_text()+"x" if p.exists() else "x"); '
                   'sys.stdout.write("SECRET_fixture"*100000); sys.stderr.write("stderr_end")', str(marker)]
        result, report = self.invoke(command)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(report['exit_code'], 0)
        self.assertEqual(marker.read_text(), 'x')
        self.assertGreater(report['log_bytes'], 1000000)
        self.assertLess(len(result.stdout), 1000)
        self.assertNotIn('SECRET_fixture', result.stdout)
        log = Path(report['log'])
        self.assertIn(b'stderr_end', log.read_bytes())
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertEqual(log.parent.stat().st_mode & 0o777, 0o700)

    def test_failure_excerpt_and_exit(self):
        result, report = self.invoke([sys.executable, '-c',
                                     'print("z"*100000); print("failure_end"); raise SystemExit(23)'],
                                    '--tail-lines', '2', '--tail-bytes', '128')
        self.assertEqual(result.returncode, 23)
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['exit_code'], 23)
        self.assertLessEqual(len(report['excerpt'].encode()), 128)
        self.assertTrue(report['excerpt'].endswith('failure_end'))

    def test_argv_and_cwd(self):
        literal = 'space $HOME `echo bad` "quote" 한글'
        result, report = self.invoke([sys.executable, '-c',
                                     'import os,sys,json; print(json.dumps([os.getcwd(),sys.argv[1]]))', literal],
                                    '--cwd', self.tmp.name)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(Path(report['log']).read_text()), [self.tmp.name, literal])

    def test_explicit_shell_pipeline_semantics(self):
        for flags, expected in [([], 0), (['-o', 'pipefail'], 1)]:
            result, report = self.invoke(['bash', *flags, '-c', 'false | true'])
            self.assertEqual(result.returncode, expected)
            self.assertEqual(report['exit_code'], expected)

    @unittest.skipUnless(os.name == 'posix', 'POSIX signal contract')
    def test_signal_exit(self):
        for sig in (signal.SIGTERM, signal.SIGKILL):
            result, report = self.invoke([sys.executable, '-c', f'import os; os.kill(os.getpid(), {int(sig)})'])
            self.assertEqual(result.returncode, -sig)
            self.assertEqual(report['exit_code'], -sig)

    def test_launch_failure_does_not_echo_arguments(self):
        result, report = self.invoke(['/nonexistent-efficiency-fixture', 'SECRET_argument'])
        self.assertEqual(result.returncode, 127)
        self.assertEqual(report['status'], 'launch_error')
        self.assertNotIn('SECRET_argument', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
