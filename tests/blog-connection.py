#!/usr/bin/env python3
"""Exercise the real probe with fake drivers; no external network or credentials."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'linux/blog_connection.mjs'


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {k: v for k, v in os.environ.items() if k not in
                    ('DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'NODE_OPTIONS')}
        (self.root / '.env').write_text('DATABASE_URL="postgres://user:private-secret@db.example/db"\n'
                                      'NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co\n'
                                      'SUPABASE_SECRET_KEY=sb_secret_private-secret\n')

    def module(self, name, text):
        path = self.root / 'node_modules' / name
        path.mkdir(parents=True)
        (path / 'index.js').write_text(text)

    def run_probe(self):
        result = subprocess.run(['node', str(SCRIPT)], cwd=self.root, env=self.env,
                                text=True, capture_output=True, timeout=10, check=True)
        self.assertNotIn('private-secret', result.stdout + result.stderr)
        return json.loads(result.stdout)['checks']

    def test_readonly_success(self):
        self.module('pg', '''exports.Client = class {
          constructor(c) { if (!c.connectionString.includes('private-secret') || !c.query_timeout) throw Error(); }
          on() {} async connect() {} async end() {}
          async query(sql) { if (sql !== 'SELECT 1') throw Error('unexpected write'); }
        };''')
        self.module('@supabase/supabase-js', '''exports.createClient = (url, key, options) => {
          if (url !== 'https://example.supabase.co' || key !== 'sb_secret_private-secret' || options.auth.persistSession) throw Error();
          return {storage: {getBucket: async name => ({data: {id:name}})}};
        };''')
        checks = self.run_probe()
        self.assertEqual([c['status'] for c in checks].count('connected'), 2)

    def test_auth_and_bucket_errors_do_not_leak(self):
        self.module('pg', '''exports.Client = class {
          on() {} async connect() { throw Object.assign(Error('private-secret'), {code:'28P01'}); }
          async end() {}
        };''')
        self.module('@supabase/supabase-js', '''exports.createClient = () => ({storage: {
          getBucket: async () => ({error: {status:404, message:'private-secret'}})
        }});''')
        checks = self.run_probe()
        self.assertEqual([c['status'] for c in checks].count('failed'), 2)
        self.assertTrue(any('인증' in c['message'] for c in checks))
        self.assertTrue(any('버킷이 없습니다' in c['message'] for c in checks))

    def test_missing_packages_and_values(self):
        checks = self.run_probe()
        self.assertEqual(sum('패키지' in c['message'] for c in checks), 2)
        (self.root / '.env').unlink()
        self.assertTrue(all(c['status'] == 'missing' for c in self.run_probe()))

    def test_environment_precedence(self):
        self.env['DATABASE_URL'] = 'postgres://override:private-secret@db.example/db'
        self.module('pg', '''exports.Client = class {
          constructor(c) { if (!c.connectionString.includes('override:')) throw Error(); }
          on() {} async connect() {} async end() {} async query() {}
        };''')
        self.assertTrue(any(c['label'] == 'DB 연결·읽기' and c['status'] == 'connected' for c in self.run_probe()))


if __name__ == '__main__':
    unittest.main()
