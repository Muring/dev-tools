export type Profile = 'muring' | 'common';
export interface Item {
  id: string;
  title: string;
  description: string;
  depends: string[];
  defaults: Record<Profile, boolean>;
  recommend: string;
  required: boolean;
}
export interface Config {
  version: 1;
  profile: Profile;
  selected: string[];
  distro: string;
  user: string;
  installLocation: string;
  gitName: string;
  gitEmail: string;
  timezone: string;
  kbRepo: string;
  kbDir: string;
  contentCommit: string;
}
export const CONTENT_GROUPS = ['claude-skill', 'claude-commands', 'codex-skills'];
export interface ContentPreview {
  commit: string;
  installedCommit: string;
  message: string;
  date: string;
  commands: string[];
  skills: string[];
  changes: { path: string; status: string }[];
}
export interface InstallEvent {
  version: number;
  step: string;
  status: string;
  message: string;
  time: number;
}
export interface SkillReadiness {
  checkedAt: string;
  checks: Record<string, boolean | null>;
}
export interface LinuxInfo {
  skillReadiness?: SkillReadiness;
  osId: string;
  contentCommit?: string;
  users: string[];
  user: string;
  zshrc: boolean;
  gitName: string;
  gitEmail: string;
  gitBranch: string;
  timezone: string;
  auth: Record<string, boolean>;
  tools: Record<string, boolean>;
}
export interface Inspection {
  supported: boolean;
  windowsBuild?: number;
  wslReady: boolean;
  wslVersion?: string;
  locationSupported: boolean;
  distros: { name: string; location: string; version: number }[];
  drives: { root: string; freeGB: number }[];
  orcaInstalled: boolean;
  patchSupported: boolean;
  patchApplied: boolean;
  linux?: LinuxInfo;
  error?: string;
}
export interface Snapshot {
  operation?: import('./progress').Operation;
  config: Config;
  inspection?: Inspection;
  contentPreview?: ContentPreview;
  events: InstallEvent[];
  busy: boolean;
  phase: string;
  logPath: string;
}

export function defaults(catalog: Item[], profile: Profile = 'muring'): Config {
  return {
    version: 1,
    profile,
    selected: catalog.filter(i => i.defaults[profile]).map(i => i.id),
    distro: 'Ubuntu',
    user: 'muring',
    installLocation: '',
    gitName: '',
    gitEmail: '',
    timezone: 'Asia/Seoul',
    kbRepo: 'https://github.com/Muring/muring-kb.git',
    kbDir: '~/dev/muring-kb',
    contentCommit: '',
  };
}
export function toggle(catalog: Item[], selected: string[], id: string, on: boolean): string[] {
  const next = new Set(selected);
  function add(key: string) {
    const item = catalog.find(i => i.id === key);
    if (!item) throw Error('Unknown item');
    next.add(key);
    item.depends.forEach(add);
  }
  function remove(key: string) {
    if (catalog.find(i => i.id === key)?.required) return;
    next.delete(key);
    catalog.filter(i => i.depends.includes(key)).forEach(i => remove(i.id));
  }
  if (on) add(id);
  else remove(id);
  return catalog.filter(i => next.has(i.id)).map(i => i.id);
}
export function recommended(item: Item, config: Config): boolean {
  return (
    item.recommend === 'all' ||
    item.recommend === config.profile ||
    (item.recommend === 'zsh' && config.selected.includes('zsh'))
  );
}
export function validate(raw: unknown, catalog: Item[]): Config {
  if (!raw || typeof raw !== 'object') throw Error('Invalid configuration');
  const value = { contentCommit: '', ...raw } as Config;
  if (value.version !== 1 || !['muring', 'common'].includes(value.profile))
    throw Error('Invalid configuration version/profile');
  const allowed = Object.keys(defaults(catalog));
  if (Object.keys(value).some(k => !allowed.includes(k))) throw Error('Unknown configuration field');
  for (const key of allowed.filter(k => !['version', 'selected'].includes(k))) {
    const field = (value as unknown as Record<string, unknown>)[key];
    if (typeof field !== 'string' || /[\r\n\0]/.test(field)) throw Error(`Invalid ${key}`);
  }
  if (
    !Array.isArray(value.selected) ||
    !value.selected.includes('base') ||
    value.selected.some(id => !catalog.some(i => i.id === id))
  )
    throw Error('Invalid selection');
  if (value.contentCommit && !/^[0-9a-f]{40}$/.test(value.contentCommit))
    throw Error('커맨드·스킬 커밋을 다시 확인하세요.');
  for (const item of catalog.filter(i => value.selected.includes(i.id)))
    if (item.depends.some(dep => !value.selected.includes(dep)))
      throw Error(`${item.title}: 필요한 도구도 선택하세요.`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.distro)) throw Error('Ubuntu 배포판 이름을 확인하세요.');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value.user) || value.user === 'root')
    throw Error('개발용 Linux 사용자명은 영문 소문자로 입력하세요.');
  if (
    value.installLocation &&
    (!/^[A-Za-z]:\\.+/.test(value.installLocation) ||
      /[<>"|?*]/.test(value.installLocation) ||
      value.installLocation.slice(2).includes(':'))
  )
    throw Error('Ubuntu 저장 위치는 D:\\WSL\\Ubuntu 같은 전용 폴더여야 합니다.');
  if (!/^[A-Za-z0-9_+./-]+$/.test(value.timezone) || value.timezone.includes('..'))
    throw Error('시간대를 확인하세요.');
  if (value.selected.includes('git-name') && !value.gitName.trim())
    throw Error('Git 작성자 이름을 입력하세요.');
  if (value.selected.includes('git-email') && !value.gitEmail.trim()) throw Error('Git 이메일을 입력하세요.');
  if (
    value.selected.includes('kb') &&
    (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.kbRepo) ||
      !/^(~\/|\/)/.test(value.kbDir))
  )
    throw Error('KB는 인증 정보 없는 GitHub HTTPS URL과 Ubuntu 경로를 입력하세요.');
  return structuredClone(value);
}
