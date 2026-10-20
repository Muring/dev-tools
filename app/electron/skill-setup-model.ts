export const BLOG_CREDENTIAL_KEYS = [
  'DATABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
] as const;
export type BlogCredentialKey = (typeof BLOG_CREDENTIAL_KEYS)[number];
export type BlogCredentials = Partial<Record<BlogCredentialKey, string>>;
export function blogCredentials(value: unknown): BlogCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 32768)
    throw Error('블로그 인증 입력을 확인하세요.');
  for (const [key, entry] of Object.entries(value)) {
    if (
      !(BLOG_CREDENTIAL_KEYS as readonly string[]).includes(key) ||
      typeof entry !== 'string' ||
      !entry ||
      entry.length > 8192 ||
      /[\x00-\x1f]/.test(entry)
    )
      throw Error('블로그 인증 항목과 한 줄 입력값을 확인하세요.');
  }
  return value as BlogCredentials;
}
export type SetupSkill = 'blog-draft' | 'usage-report' | 'storage-maintenance';
export interface SetupPath {
  platform: 'linux' | 'windows';
  path: string;
  kind?: string;
}
export interface SetupRequest {
  skill: SetupSkill;
  path?: string;
  repository?: string;
  installDependencies?: boolean;
  draft?: string;
  credentialKeys?: BlogCredentialKey[];
  replaceCredentialKeys?: BlogCredentialKey[];
  initialize?: boolean;
  projects?: Record<string, string>;
  sync?: boolean;
  schedule?: boolean;
  allowPublish?: boolean;
  fingerprint?: string;
  approveTemplate?: boolean;
  targets?: SetupPath[];
  preserve?: SetupPath[];
  schedulePlan?: boolean;
}
export interface SetupDiscovery {
  skill: SetupSkill;
  path: string;
  blogs: string[];
  roots: { tool: string; path: string; exists: boolean }[];
  projects: { path: string; alias: string }[];
  targets: SetupPath[];
  preserve: string[];
  trackingConfig: string;
  trackingConfigured?: boolean;
  publisherConfigured?: boolean;
  windowsDiscovery?: string;
}
export interface SetupPlan {
  id: string;
  request: SetupRequest;
  actions: string[];
  blockers: string[];
}
export interface SetupResult {
  id: string;
  skill: SetupSkill;
  status: 'completed' | 'waiting' | 'failed';
  message?: string;
  steps: { label: string; status: 'completed' | 'failed' | 'running' }[];
  artifacts: { label: string; path: string }[];
  checks?: { label: string; status: string; message?: string }[];
  fingerprint?: string;
}
export function setupSkill(value: unknown): SetupSkill {
  if (typeof value !== 'string' || !['blog-draft', 'usage-report', 'storage-maintenance'].includes(value))
    throw Error('지원하지 않는 스킬입니다.');
  return value as SetupSkill;
}
