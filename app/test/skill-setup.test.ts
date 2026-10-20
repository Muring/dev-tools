import assert from 'node:assert/strict';
import test from 'node:test';
import { blogCredentials } from '../electron/skill-setup-model';

test('credential IPC accepts only bounded known fields and keeps error text value-free', () => {
  assert.deepEqual(blogCredentials({ SUPABASE_SECRET_KEY: 'sb_secret_synthetic' }), {
    SUPABASE_SECRET_KEY: 'sb_secret_synthetic',
  });
  for (const input of [
    { unknown: 'secret-marker' },
    { SUPABASE_SECRET_KEY: 'secret-marker\nNEXT=bad' },
    { DATABASE_URL: 'secret-marker'.repeat(1000) },
    [],
    null,
    { DATABASE_URL: { nested: 'secret-marker' } },
  ]) {
    assert.throws(
      () => blogCredentials(input),
      error => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('secret-marker'));
        return true;
      },
    );
  }
});
