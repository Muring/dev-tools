// Read-only checks using the selected blog's installed dependencies.
// Never print credentials, remote responses or raw exception messages.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const require = createRequire(resolve(process.cwd(), 'package.json'));
const keys = ['DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY'];
const checks = [];
const add = (label, status, message) => checks.push({ label, status, message });
let values = {};
try {
  if (existsSync('.env')) values = parseEnv(readFileSync('.env', 'utf8'));
  for (const key of keys) if (process.env[key]) values[key] = process.env[key];
} catch {
  add('환경 파일 읽기', 'failed', '.env 파일 형식과 읽기 권한을 확인하세요.');
}
for (const key of keys) add(key + ' 값 설정', values[key] ? 'configured' : 'missing', '');

function reason(error, storage = false) {
  const code = String(error?.code || error?.cause?.code || '');
  const status = String(error?.status || error?.statusCode || '');
  if (code === 'MODULE_NOT_FOUND') return '블로그 패키지를 먼저 설치한 뒤 다시 검사하세요.';
  if (code === '28P01' || code === '28000' || ['401', '403'].includes(status))
    return '인증 또는 접근 권한이 거부됐습니다. 연결 주소와 인증값을 확인하세요.';
  if (code === '3D000') return 'DB 이름을 확인하세요.';
  if (status === '404') return 'post-images 버킷이 없습니다. Supabase Storage 설정을 확인하세요.';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT'].includes(code))
    return '서버 주소·네트워크·방화벽 상태를 확인하세요.';
  return storage
    ? '버킷 접근에 실패했습니다. URL·서버용 키·버킷과 네트워크 상태를 확인하세요. 시간 초과일 수도 있습니다.'
    : 'DB 연결 또는 읽기 검사에 실패했습니다. 주소·인증·TLS·네트워크 상태를 확인하세요. 시간 초과일 수도 있습니다.';
}

async function database() {
  if (!values.DATABASE_URL) return add('DB 연결·읽기', 'missing', 'DATABASE_URL을 설정하세요.');
  let client;
  try {
    const { Client } = require('pg');
    client = new Client({ connectionString: values.DATABASE_URL, connectionTimeoutMillis: 8000,
      query_timeout: 8000, statement_timeout: 8000 });
    client.on('error', () => {});
    await client.connect();
    await client.query('SELECT 1');
    add('DB 연결·읽기', 'connected', '접속·인증과 SELECT 1 실행을 확인했습니다. 글 등록 권한은 검사하지 않았습니다.');
  } catch (error) {
    add('DB 연결·읽기', 'failed', reason(error));
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

async function storage() {
  if (!values.NEXT_PUBLIC_SUPABASE_URL || !values.SUPABASE_SECRET_KEY)
    return add('이미지 버킷 접근', 'missing', 'Supabase URL과 서버용 키를 설정하세요.');
  try {
    const url = new URL(values.NEXT_PUBLIC_SUPABASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error('invalid URL');
    const { createClient } = require('@supabase/supabase-js');
    const client = createClient(url.origin, values.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, options) => fetch(input, { ...options, redirect: 'error', signal: AbortSignal.timeout(8000) }) },
    });
    const { data, error } = await client.storage.getBucket('post-images');
    if (error) throw error;
    if (data?.id !== 'post-images') throw new Error('invalid bucket response');
    add('이미지 버킷 접근', 'connected', 'post-images 버킷 정보 조회를 확인했습니다. 이미지 업로드·삭제 권한은 검사하지 않았습니다.');
  } catch (error) {
    add('이미지 버킷 접근', 'failed', reason(error, true));
  }
}
await Promise.all([database(), storage()]);
process.stdout.write(JSON.stringify({ checks }));
