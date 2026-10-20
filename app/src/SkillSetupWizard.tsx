import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  BlogCredentials,
  BlogCredentialKey,
  SetupDiscovery,
  SetupPlan,
  SetupRequest,
  SetupResult,
  SetupSkill,
  SetupPath,
} from '../electron/skill-setup-model';
import { BLOG_CREDENTIAL_KEYS } from '../electron/skill-setup-model';
import { StoragePaths } from './StoragePaths';

export interface SetupActions {
  discover(skill: SetupSkill): Promise<SetupDiscovery | undefined>;
  preview(request: SetupRequest): Promise<SetupPlan | undefined>;
  execute(id: string, credentials?: BlogCredentials): Promise<SetupResult | undefined>;
  openArtifact(id: string, index: number): Promise<unknown>;
}

export function SkillSetupWizard({
  skill,
  busy,
  discover,
  preview,
  execute,
  openArtifact,
  readinessContent,
  onResultChange,
}: SetupActions & {
  skill: SetupSkill;
  busy: boolean;
  readinessContent?: ReactNode;
  onResultChange?(value: boolean): void;
}) {
  const [request, setRequest] = useState<SetupRequest>({
    skill,
    path: skill === 'blog-draft' ? '~/dev/mublog' : '~/dev/muring-kb',
  });
  const [credentials, setCredentials] = useState<BlogCredentials>({});
  const [repairKeys, setRepairKeys] = useState<BlogCredentialKey[]>([]);
  const [replaceApproved, setReplaceApproved] = useState(false);
  const [blogPage, setBlogPage] = useState<'repository' | 'credentials'>('repository');
  const [blogPathSelected, setBlogPathSelected] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [blogPage]);
  const [stage, setStage] = useState<'input' | 'review' | 'result'>('input');
  useEffect(() => {
    onResultChange?.(stage === 'result');
  }, [stage, onResultChange]);
  const inputRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (stage === 'input') {
      const target = repairKeys.length
        ? inputRef.current?.querySelector<HTMLElement>('[data-repair="true"] input')
        : inputRef.current;
      target?.focus({ preventScroll: true });
      if (repairKeys.length) target?.scrollIntoView({ block: 'nearest' });
      else bodyRef.current?.scrollTo({ top: 0 });
    }
  }, [stage, repairKeys]);
  useEffect(() => {
    if (blogPathSelected) {
      inputRef.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    }
  }, [blogPathSelected]);
  const [pathEdited, setPathEdited] = useState(false);
  const [found, setFound] = useState<SetupDiscovery>();
  const existingBlog = skill === 'blog-draft' && !!found?.blogs.includes(request.path || '');
  const publishingRelevant = !!(request.sync || request.schedule);
  const [plan, setPlan] = useState<SetupPlan>();
  const [approved, setApproved] = useState(false);
  const [result, setResult] = useState<SetupResult>();
  const [error, setError] = useState('');
  const resultTone =
    result?.status === 'failed' ||
    result?.steps.some(step => step.status === 'failed') ||
    result?.checks?.some(check => check.status === 'failed')
      ? 'failed'
      : result?.status === 'waiting' ||
          result?.steps.some(step => step.status === 'running') ||
          result?.checks?.some(check => check.status === 'missing')
        ? 'waiting'
        : 'completed';
  const [reportReady, setReportReady] = useState(false);
  const planRef = useRef<HTMLElement>(null);
  const resultRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (plan && stage === 'review') {
      planRef.current?.focus({ preventScroll: true });
      planRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [plan, stage]);
  useEffect(() => {
    if (result && stage === 'result') {
      resultRef.current?.focus({ preventScroll: true });
      resultRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [result, stage]);
  const shortHelp = {
    installDependencies: '블로그 실행에 필요한 패키지를 설치합니다. 인터넷 연결이 필요합니다.',
    initialize: '기록을 계속 보관할 설정을 만듭니다. 자동 기록은 별도로 켭니다.',
    sync: '집계 기록을 Git 원격 저장소에 올리고, 저장소의 기록을 가져옵니다.',
    schedule: '매일 오전 9시(한국 시간)에 사용량 수집과 Git 동기화를 함께 실행합니다.',
    allowPublish: '기존 연동으로 보고서 발행을 허용합니다. 실제 연결 상태는 별도 확인이 필요합니다.',
    approveTemplate: '결과의 HTML 보고서를 확인한 뒤 선택하세요.',
  };

  function invalidate() {
    setPlan(undefined);
    setApproved(false);
    setError('');
  }
  function change(values: Partial<SetupRequest>) {
    if (repairKeys.length) {
      setCredentials({});
      setRepairKeys([]);
      setReplaceApproved(false);
    }
    if (values.path !== undefined || values.repository !== undefined) {
      setCredentials({});
      setRepairKeys(previous => (previous.length ? [] : previous));
      setReplaceApproved(false);
    }
    if (values.path !== undefined) {
      setPathEdited(true);
      setBlogPathSelected(false);
    }
    if (values.approveTemplate === undefined) {
      setReportReady(false);
      setResult(undefined);
    }
    setRequest(previous => {
      const next = {
        ...previous,
        approveTemplate: false,
        ...(values.sync === true || values.schedule === true ? { initialize: true } : {}),
        ...(values.initialize === false ? { sync: false, schedule: false, allowPublish: false } : {}),
        ...(values.approveTemplate === undefined ? { fingerprint: undefined } : {}),
        ...values,
        ...(values.path !== undefined && found?.blogs.includes(values.path) ? { repository: undefined } : {}),
      };
      if (!next.sync && !next.schedule) next.allowPublish = false;
      return next;
    });
    invalidate();
  }
  async function find() {
    const value = await discover(skill);
    if (!value) return;
    setCredentials({});
    setRepairKeys([]);
    setReplaceApproved(false);
    setFound(value);
    setBlogPathSelected(false);
    setReportReady(false);
    setResult(undefined);
    setPathEdited(false);
    setRequest(previous => ({
      ...previous,
      path: value.path,
      ...(skill === 'blog-draft' && value.blogs.includes(value.path) ? { repository: undefined } : {}),
      ...(!value.publisherConfigured ? { allowPublish: false } : {}),
      approveTemplate: false,
      fingerprint: undefined,
    }));
    invalidate();
    return value;
  }
  function paths(value: string): SetupPath[] {
    return value
      .split('\n')
      .map(p => p.trim())
      .filter(Boolean)
      .map(path => ({
        platform: /^[A-Za-z]:\\/.test(path) ? 'windows' : 'linux',
        path,
        kind: 'directory',
      }));
  }
  async function review(activateSchedule = false) {
    setError('');
    setApproved(false);
    setPlan(undefined);
    if (repairKeys.length && (!replaceApproved || !Object.keys(credentials).length)) return;
    if (!activateSchedule && !repairKeys.length) {
      setReportReady(false);
      setResult(undefined);
    }
    const value = { ...request };
    if (skill === 'usage-report') {
      if (activateSchedule && (!reportReady || !request.approveTemplate)) return;
      value.schedule = activateSchedule;
      value.approveTemplate = activateSchedule && request.approveTemplate;
      if (activateSchedule) value.sync = false;
      if ((!value.sync && !value.schedule) || !found?.publisherConfigured) value.allowPublish = false;
    }
    if (skill === 'blog-draft') {
      if (repairKeys.length) value.installDependencies = false;
      value.credentialKeys = BLOG_CREDENTIAL_KEYS.filter(key => !!credentials[key]);
      value.replaceCredentialKeys = replaceApproved
        ? value.credentialKeys.filter(key => repairKeys.includes(key))
        : [];
    }
    if (skill === 'usage-report') {
      value.projects = {};
      const detected = found || (await discover(skill));
      if (!detected) return;
      setFound(detected);
      if (!pathEdited) {
        value.path = detected.path;
        setRequest(previous => ({ ...previous, path: detected.path }));
      }
    }
    if (skill === 'storage-maintenance') {
      const detected = found || (await find());
      if (!detected) return;
      value.targets = request.targets ?? detected.targets;
      value.preserve = [...paths(detected.preserve.join('\n')), ...(request.preserve ?? [])].filter(
        (entry, index, entries) =>
          entries.findIndex(other => other.platform === entry.platform && other.path === entry.path) ===
          index,
      );
    }
    const nextPlan = await preview(value);
    setPlan(nextPlan);
    if (nextPlan) setStage('review');
  }
  async function apply() {
    if (!plan || !approved || plan.blockers.length || busy) return;
    const supplied = credentials;
    setCredentials({});
    setRepairKeys([]);
    setReplaceApproved(false);
    const value = await execute(plan.id, supplied);
    if (!value) setStage('input');
    setPlan(undefined);
    setApproved(false);
    if (value) {
      setStage('result');
      setResult(value);
      setReportReady(
        !!value.fingerprint &&
          value.status === 'completed' &&
          !plan.request.schedule &&
          value.steps.every(step => step.status === 'completed') &&
          !value.checks?.some(check => ['failed', 'missing'].includes(check.status)),
      );
      if (value.fingerprint)
        setRequest(previous => ({ ...previous, fingerprint: value.fingerprint, approveTemplate: false }));
    }
  }
  const checkbox = (
    key: 'installDependencies' | 'initialize' | 'sync' | 'schedule' | 'allowPublish' | 'approveTemplate',
    label: string,
    description: string,
    disabled = false,
  ) => (
    <div className={`setup-choice setup-toggle ${disabled ? 'is-disabled' : ''}`}>
      <label className="setup-option">
        <input
          type="checkbox"
          aria-describedby={`setup-${skill}-${key}-help`}
          disabled={disabled}
          checked={request[key] || false}
          onChange={e => change({ [key]: e.target.checked })}
        />
        {label}
      </label>
      <p className="setup-choice-summary">{shortHelp[key]}</p>
      <details className="setup-help">
        <summary>자세한 설명</summary>
        <p id={`setup-${skill}-${key}-help`}>{description}</p>
      </details>
    </div>
  );
  const credentialFields = (selected: readonly BlogCredentialKey[]) =>
    (
      [
        {
          key: 'DATABASE_URL',
          title: 'DB 연결 주소',
          example: 'postgresql://postgres.PROJECT:비밀번호@HOST:6543/postgres?pgbouncer=true',
          help: '글을 저장할 데이터베이스 주소입니다. Supabase 프로젝트의 Connect → Transaction pooler에서 복사하고 [YOUR-PASSWORD]를 DB 비밀번호로 바꾸세요. mublog는 포트 6543과 pgbouncer=true 설정을 사용합니다. 비밀번호의 특수문자는 URL 인코딩해야 합니다.',
        },
        {
          key: 'NEXT_PUBLIC_SUPABASE_URL',
          title: 'Supabase 프로젝트 URL',
          example: 'https://프로젝트-ID.supabase.co',
          help: '이미지 저장소가 있는 프로젝트 주소입니다. Supabase 프로젝트의 Connect에서 Project URL을 복사하세요. DB 연결 주소와 같은 프로젝트를 사용하세요.',
        },
        {
          key: 'SUPABASE_SECRET_KEY',
          title: 'Supabase 서버용 secret 키',
          example: 'sb_secret_…',
          help: '이미지 저장소에 접근하는 서버용 키입니다. Supabase 프로젝트의 Settings → API Keys에서 Secret key를 복사하세요. publishable 키나 계정 로그인 비밀번호가 아닙니다. 프로젝트 관리 권한이 없다면 관리자에게 요청하세요.',
        },
      ] as const
    )
      .filter(field => selected.includes(field.key))
      .map(field => (
        <div className="setup-credential" key={field.key} data-repair={repairKeys.includes(field.key)}>
          {repairKeys.includes(field.key) && (
            <p className="setup-field-error">이 연결 항목을 확인하세요. 새 값을 입력한 항목만 교체합니다.</p>
          )}
          <label>
            {field.title} <code>({field.key})</code>
            <input
              type="password"
              disabled={!!repairKeys.length && !repairKeys.includes(field.key)}
              autoComplete="new-password"
              spellCheck={false}
              value={credentials[field.key] || ''}
              aria-describedby={`credential-${field.key}-help`}
              placeholder="새로 설정할 값 입력"
              onChange={e => {
                setCredentials(previous => {
                  const next = { ...previous };
                  if (e.target.value) next[field.key] = e.target.value;
                  else delete next[field.key];
                  return next;
                });
                setReplaceApproved(false);
                invalidate();
              }}
            />
          </label>
          <details className="setup-help">
            <summary>값을 찾는 방법과 예시</summary>
            <p id={`credential-${field.key}-help`}>{field.help}</p>
            <pre className="setup-path">{field.example}</pre>
          </details>
        </div>
      ));
  return (
    <div className="setup-wizard" data-skill={skill}>
      <ol className="setup-stages" aria-label="준비 진행 단계">
        {(skill === 'blog-draft'
          ? [
              ['repository', '저장소'],
              ['credentials', '인증'],
              ['review', '변경 확인'],
              ['result', '결과'],
            ]
          : [
              ['input', '입력'],
              ['review', '변경 확인'],
              ['result', '결과'],
            ]
        ).map(([item, label], index) => (
          <li
            key={item}
            aria-current={
              (skill === 'blog-draft' && stage === 'input' ? blogPage : stage) === item ? 'step' : undefined
            }>
            {index + 1}. {label}
          </li>
        ))}
      </ol>
      <div className="setup-wizard-body" ref={bodyRef}>
        {stage === 'input' && (skill !== 'blog-draft' || blogPage === 'repository') && readinessContent}
        <div className="setup-input" ref={inputRef} tabIndex={-1} hidden={stage !== 'input'}>
          <div className="setup-form-heading" hidden={skill === 'blog-draft' && blogPage === 'credentials'}>
            <div>
              <h3>
                {skill === 'blog-draft'
                  ? '블로그 연결'
                  : skill === 'usage-report'
                    ? '사용량 확인'
                    : '저장공간 확인'}
              </h3>
              <p>
                {skill === 'blog-draft'
                  ? '저장소와 인증값을 준비한 뒤 변경 내용을 확인하세요.'
                  : skill === 'usage-report'
                    ? '기본은 로컬에서 한 번 분석합니다. 외부 전송은 선택 사항입니다.'
                    : '자동 탐색 또는 직접 지정한 위치를 진단합니다. 파일은 삭제하지 않습니다.'}
              </p>
            </div>
            <button className="setup-secondary" disabled={busy} onClick={find}>
              내 환경에서 경로 찾기
            </button>
          </div>
          <fieldset disabled={busy}>
            <legend className="sr-only">{skill} 준비 옵션</legend>
            {skill === 'blog-draft' && blogPage === 'repository' && (
              <label className="setup-field">
                블로그 저장소 경로
                {blogPathSelected && (
                  <span className="setup-path-selected" role="status">
                    선택 완료
                  </span>
                )}
                <input
                  aria-label="블로그 저장소 경로"
                  value={request.path || ''}
                  onChange={e => change({ path: e.target.value })}
                  placeholder="~/dev/저장소"
                />
              </label>
            )}
            {skill === 'blog-draft' && (
              <>
                <div hidden={blogPage !== 'repository'}>
                  {!!found?.blogs.length && !blogPathSelected && (
                    <div className="setup-path">
                      <p>발견한 블로그 저장소</p>
                      {found.blogs.map(path => (
                        <button
                          key={path}
                          type="button"
                          onClick={() => {
                            change({ path });
                            setBlogPathSelected(true);
                          }}>
                          {path} 사용
                        </button>
                      ))}
                    </div>
                  )}
                  {found && !found.blogs.length && (
                    <p className="muted">
                      블로그 저장소를 찾지 못했습니다. 기존 경로를 직접 입력하거나 저장소를 내려받으세요.
                    </p>
                  )}
                  {existingBlog ? (
                    <p className="muted">기존 블로그 저장소를 확인했습니다. 새로 내려받을 필요가 없습니다.</p>
                  ) : (
                    <details className="setup-help setup-clone">
                      <summary>블로그 저장소를 아직 내려받지 않았다면</summary>
                      <label className="setup-field">
                        새로 받을 GitHub 저장소 주소 (기존 폴더가 없을 때)
                        <input
                          value={request.repository || ''}
                          onChange={e => change({ repository: e.target.value })}
                          placeholder="https://github.com/소유자/저장소.git"
                        />
                      </label>
                      <p className="muted">
                        글을 작성·등록할 기존 mublog 프로젝트를 연결합니다. 새 폴더에 내려받으려면 인터넷과
                        저장소 접근 권한이 필요합니다. 새 블로그를 생성하는 기능은 아닙니다.
                      </p>
                    </details>
                  )}
                  {checkbox(
                    'installDependencies',
                    '블로그 실행에 필요한 패키지 설치',
                    '선택한 프로젝트에서 yarn install을 실행합니다. 인터넷 연결이 필요하며 프로젝트의 설치 스크립트도 실행될 수 있습니다.',
                  )}
                </div>
                <div hidden={blogPage !== 'credentials'}>
                  <div className="setup-block-heading">
                    <h4>블로그 인증값 입력</h4>
                    <p>
                      {repairKeys.length
                        ? '강조된 항목의 새 값만 입력하세요. 빈 항목은 유지하며, 입력한 항목만 교체 동의 후 .env에 저장합니다.'
                        : '같은 Supabase 프로젝트의 값을 입력하세요. 실행 시 .env에 저장합니다. 기존 값은 유지하므로 이미 설정한 항목은 비워 두세요.'}
                    </p>
                  </div>
                  {credentialFields(BLOG_CREDENTIAL_KEYS)}
                  {!!repairKeys.length && (
                    <div className="setup-repair-consent">
                      <label className="setup-option">
                        <input
                          type="checkbox"
                          checked={replaceApproved}
                          disabled={busy || !Object.keys(credentials).length}
                          onChange={event => {
                            setReplaceApproved(event.target.checked);
                            invalidate();
                          }}
                        />
                        입력한 항목의 기존 인증값을 새 값으로 교체하는 데 동의합니다.
                      </label>
                    </div>
                  )}
                  <p className="setup-note">
                    경로를 바꾸거나 실행하면 입력값을 비웁니다. 저장 후 DB 연결과 이미지 버킷 접근을
                    검사합니다. 글 등록·이미지 업로드는 하지 않습니다.
                  </p>
                  <details className="setup-help">
                    <summary>직접 설정할 때 사용할 .env 예시</summary>
                    <pre className="setup-path">{`DATABASE_URL='postgresql://postgres.PROJECT:비밀번호@HOST:6543/postgres?pgbouncer=true'
NEXT_PUBLIC_SUPABASE_URL='https://프로젝트-ID.supabase.co'
SUPABASE_SECRET_KEY='sb_secret_실제키'`}</pre>
                    <p>
                      위 내용은 형식 예시입니다. .env는 계정 소유자만 읽고 쓰도록 저장하고 Git 제외 규칙을
                      추가합니다. 실제 값이 들어간 파일은 Git에 올리지 마세요.
                    </p>
                  </details>
                </div>
              </>
            )}
            {skill === 'usage-report' && (
              <>
                {found && (
                  <details className="setup-help">
                    <summary>사용량 로그 위치 확인</summary>
                    <ul className="setup-path">
                      {found.roots.map(root => (
                        <li key={root.path}>
                          {root.tool}: {root.path} · {root.exists ? '경로 있음' : '로그 없음'}
                        </li>
                      ))}
                    </ul>
                    {!found.roots.length && <p>발견한 사용량 로그 위치가 없습니다.</p>}
                  </details>
                )}
                {found?.trackingConfigured && (
                  <p className="muted">
                    기존 사용량 기록 설정을 확인했습니다. 실행 시 해당 설정을 재사용합니다.
                  </p>
                )}
                {checkbox(
                  'initialize',
                  '이 기기의 사용량 기록 설정 저장',
                  'Codex·Claude 로그 위치, 기기 식별값, 결과 저장 위치를 등록하고 기존 설정은 재사용합니다. 처음에는 사용량 템플릿이 있는 KB 저장소와 Git 접근 권한이 필요하며 원격 조회와 데이터 작업 폴더 생성이 포함됩니다. 이 선택만으로 자동 기록은 켜지지 않습니다. Git 동기화·예약을 선택하면 필요한 기록 설정도 함께 준비합니다.',
                )}
                {(request.initialize || request.sync || request.schedule) && (
                  <div className="setup-dependent">
                    <label className="setup-field">
                      KB 저장소 경로
                      <input
                        value={request.path || ''}
                        onChange={e => change({ path: e.target.value })}
                        placeholder="~/dev/muring-kb"
                      />
                    </label>
                    <p className="muted">
                      보고서 템플릿이 있는 개인 KB 폴더입니다. 기존 기록 설정이 있으면 재사용합니다.
                    </p>
                  </div>
                )}
                <details className="setup-optional">
                  <summary>
                    Git 동기화·자동 기록·블로그 발행 설정
                    {(request.sync || request.schedule || request.allowPublish) && (
                      <span className="setup-path-selected">
                        {[request.sync, request.schedule, request.allowPublish].filter(Boolean).length}개 선택
                      </span>
                    )}
                  </summary>
                  {checkbox(
                    'sync',
                    '사용량 기록을 Git 저장소에 지금 동기화',
                    '집계 기록을 추적 설정에 지정된 Git 원격 저장소에 올리고 저장소의 기록을 가져옵니다. 다른 기기에 직접 연결하지 않습니다. 기록 설정과 Git 접근 권한이 필요하며, 대화 원문 대신 수집기가 만든 사용량·작업 결과 데이터를 동기화합니다.',
                  )}
                  {checkbox(
                    'schedule',
                    '사용량 자동 기록과 Git 동기화 켜기',
                    '매일 한국 시간 오전 9시에 수집·Git 동기화를 실행하고 시작 시 누락된 실행을 보충합니다. 현재 예약은 로컬 기록과 Git 동기화를 함께 수행합니다. Ubuntu와 사용자 예약 서비스가 실행 가능한 환경, 기록 설정, Git 접근 권한이 필요합니다. 먼저 보고서를 생성하고 양식을 확인하세요.',
                  )}
                  {request.schedule && (
                    <p className="muted">
                      먼저 설정과 첫 보고서를 준비합니다. 결과 아래에서 보고서 양식을 확인한 뒤 자동 기록을
                      시작할 수 있습니다. 지금 선택하는 것만으로 예약이 켜지지는 않습니다.
                    </p>
                  )}
                  {publishingRelevant &&
                    (found?.publisherConfigured ? (
                      <>
                        {checkbox(
                          'allowPublish',
                          '동기화할 때 기존 블로그 발행 설정 사용 허용',
                          '기존 설정에 블로그 발행 연동이 있습니다. 동기화·예약 실행 시 보고서 발행도 허용하는 선택입니다. 이 화면에서 전송 대상·인증·워크플로의 실제 연결을 검증하지 않습니다. 블로그 초안 저장소 연결과도 별개입니다.',
                        )}
                        <p className="muted">
                          기존 발행 설정에서는 블로그 발행도 허용해야 동기화·예약을 실행할 수 있습니다. 실제
                          반영 완료는 실행 결과로 별도 확인합니다.
                        </p>
                      </>
                    ) : (
                      <p className="muted">
                        {found
                          ? '설정된 블로그 발행 연동이 없습니다. 필요할 때 전체 가이드에 따라 별도로 연결하세요.'
                          : '현재 설정을 확인하면 기존 블로그 발행 연동 여부를 표시합니다.'}
                      </p>
                    ))}
                </details>
              </>
            )}
            {skill === 'storage-maintenance' && (
              <>
                <p>
                  기본은 자동 탐색입니다. 필요하면 진단 위치를 추가·제외하고 보존할 위치를 더 지정할 수
                  있습니다.
                </p>
                <p>
                  개발 폴더와 Claude·Codex 설정을 보호하며 기존 보존 목록도 유지합니다. 파일 삭제 없이 첫 진단
                  보고서를 만듭니다.
                </p>
                {found ? (
                  <details className="setup-optional">
                    <summary>자동으로 찾은 진단 대상 확인 ({found.targets.length}개)</summary>
                    <ul className="setup-path">
                      {found.targets.map(target => (
                        <li key={target.platform + target.path}>
                          {target.platform === 'windows' ? 'Windows' : 'Ubuntu'} · {target.path}
                        </li>
                      ))}
                    </ul>
                    {!found.targets.length && (
                      <p>
                        자동으로 찾은 진단 대상이 없습니다. 전체 가이드에서 진단 도구와 설정을 확인하세요.
                      </p>
                    )}
                    <p>
                      Windows 대상 탐색:{' '}
                      {found.windowsDiscovery === 'complete'
                        ? '완료'
                        : '미확인 — Windows 자동 탐색 결과를 확인하지 못했습니다.'}
                    </p>
                    <p>정리에서 보호할 위치 (기존 보존 설정 포함)</p>
                    <p className="muted">
                      위의 진단 대상은 용량을 조사할 위치이고, 아래 목록은 향후 정리에서 보호할 위치입니다. 두
                      목록에 같은 경로가 있으면 용량은 조사하되 정리에서는 보호합니다. 이번 진단은 어느
                      경로에서도 파일을 삭제하지 않습니다.
                    </p>
                    <ul className="setup-path">
                      {found.preserve.map(path => (
                        <li key={path}>{path}</li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  <p className="muted">
                    ‘준비할 변경 내용 확인’을 누르면 대상을 자동으로 찾아 실행할 작업을 보여줍니다.
                  </p>
                )}
                <StoragePaths
                  disabled={busy}
                  found={found}
                  targets={request.targets}
                  preserve={request.preserve ?? []}
                  discover={async () => {
                    await find();
                  }}
                  onChange={change}
                />
              </>
            )}
          </fieldset>
          {error && <p role="alert">{error}</p>}
        </div>
        {stage === 'result' && result && (
          <section
            ref={resultRef}
            tabIndex={-1}
            className={`setup-result setup-result-${resultTone}`}
            aria-label="직전 실행환경 준비 결과">
            <h4>
              직전 실행 결과 ·{' '}
              {resultTone === 'completed' ? '완료' : resultTone === 'waiting' ? '추가 확인 필요' : '실패'}
            </h4>
            {result.message && <p>{result.message}</p>}
            {!!result.steps.length && (
              <ul className="setup-result-items">
                {result.steps.map((step, i) => (
                  <li key={i} data-status={step.status}>
                    {step.label} ·{' '}
                    {step.status === 'completed' ? '완료' : step.status === 'failed' ? '실패' : '진행 중'}
                  </li>
                ))}
              </ul>
            )}
            {!!result.checks?.length && (
              <ul className="setup-result-items">
                {result.checks.map(check => (
                  <li key={check.label} data-status={check.status}>
                    {check.label} ·{' '}
                    {check.status === 'configured'
                      ? '값 있음'
                      : check.status === 'connected'
                        ? '연결 확인됨'
                        : check.status === 'failed'
                          ? '연결 확인 실패'
                          : '준비 필요'}
                    {check.message && <p>{check.message}</p>}
                    {skill === 'blog-draft' &&
                      ['failed', 'missing'].includes(check.status) &&
                      ['DB 연결·읽기', '이미지 버킷 접근'].includes(check.label) && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            setCredentials({});
                            setReplaceApproved(false);
                            setRepairKeys(
                              check.label === 'DB 연결·읽기'
                                ? ['DATABASE_URL']
                                : ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY'],
                            );
                            invalidate();
                            setBlogPage('credentials');
                            setStage('input');
                          }}>
                          인증값 수정 · {check.label}
                        </button>
                      )}
                  </li>
                ))}
              </ul>
            )}
            {result.artifacts.map((artifact, index) => (
              <div key={index} className="setup-artifact">
                <button disabled={busy} onClick={() => openArtifact(result.id, index)}>
                  {artifact.label} 열기
                </button>
                <p className="setup-path">{artifact.path}</p>
              </div>
            ))}
          </section>
        )}
        {stage === 'result' && skill === 'usage-report' && request.schedule && reportReady && (
          <section className="setup-next-step" aria-label="보고서 확인 후 자동 기록 시작">
            <h4>다음 단계 · 보고서 확인 후 자동 기록 시작</h4>
            <p>
              위의 HTML 보고서를 열어 확인하세요. 매일 오전 9시(한국 시간)에 사용량 수집과 Git 동기화를
              실행하도록 예약합니다.
            </p>
            {checkbox(
              'approveTemplate',
              '생성된 HTML을 열어 확인했고 이 보고서 양식을 승인합니다.',
              '확인한 양식을 자동 기록에 사용합니다. 설정을 바꾸면 보고서를 다시 준비해야 합니다.',
            )}
          </section>
        )}
        {stage === 'review' && plan && (
          <section
            ref={planRef}
            tabIndex={-1}
            className={`setup-plan${plan.blockers.length ? ' setup-plan-blocked' : ''}`}
            aria-label="실행환경 변경 내용">
            <h4>실행할 작업</h4>
            {skill === 'storage-maintenance' && (
              <>
                <h5>진단할 위치</h5>
                <ul className="setup-path">
                  {plan.request.targets?.map(entry => (
                    <li key={entry.platform + entry.path}>
                      {entry.platform === 'windows' ? 'Windows' : 'Ubuntu'} · {entry.path}
                    </li>
                  ))}
                </ul>
                <h5>보존할 위치</h5>
                <ul className="setup-path">
                  {plan.request.preserve?.map(entry => (
                    <li key={entry.platform + entry.path}>
                      {entry.platform === 'windows' ? 'Windows' : 'Ubuntu'} · {entry.path}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <ol>
              {plan.actions.map((action, i) => (
                <li key={i}>{action}</li>
              ))}
            </ol>
            {!!plan.blockers.length && (
              <div role="alert">
                <strong>먼저 해결할 항목</strong>
                <ul>
                  {plan.blockers.map((message, i) => (
                    <li key={i}>{message}</li>
                  ))}
                </ul>
              </div>
            )}
            <label className="setup-option">
              <input
                type="checkbox"
                disabled={busy || !!plan.blockers.length}
                checked={approved}
                onChange={e => setApproved(e.target.checked)}
              />
              위 대상과 변경 내용을 확인했습니다.
            </label>
          </section>
        )}
      </div>
      <div className="setup-workspace-actions">
        {stage === 'input' && (
          <>
            {skill === 'blog-draft' && blogPage === 'credentials' && (
              <button disabled={busy} onClick={() => setBlogPage('repository')}>
                저장소로 이전
              </button>
            )}
            {!!repairKeys.length && (
              <button
                disabled={busy}
                onClick={() => {
                  setCredentials({});
                  setRepairKeys([]);
                  setReplaceApproved(false);
                  invalidate();
                  setStage('result');
                }}>
                수정 취소
              </button>
            )}
            {skill === 'blog-draft' && blogPage === 'repository' ? (
              <button className="setup-primary" disabled={busy} onClick={() => setBlogPage('credentials')}>
                인증 설정으로 다음
              </button>
            ) : (
              <button
                className="setup-primary"
                disabled={
                  busy || (!!repairKeys.length && (!replaceApproved || !Object.keys(credentials).length))
                }
                onClick={() => review()}>
                {repairKeys.length ? '인증값 교체 내용 확인' : '준비할 변경 내용 확인'}
              </button>
            )}
          </>
        )}
        {stage === 'review' && plan && (
          <>
            <button
              disabled={busy}
              onClick={() => {
                setStage(plan.request.schedule ? 'result' : 'input');
                invalidate();
              }}>
              {plan.request.schedule ? '보고서 확인으로 돌아가기' : '입력 수정'}
            </button>
            <button
              className="setup-primary"
              disabled={busy || !approved || !!plan.blockers.length}
              onClick={apply}>
              {plan.request.schedule ? '자동 기록 시작' : '확인한 환경 준비 실행'}
            </button>
          </>
        )}
        {stage === 'result' && (
          <>
            <button
              disabled={busy}
              onClick={() => {
                setStage('input');
                setCredentials({});
                setRepairKeys([]);
                setReplaceApproved(false);
                invalidate();
              }}>
              설정 수정
            </button>
            {skill === 'usage-report' && request.schedule && reportReady && (
              <button
                className="setup-primary"
                disabled={busy || !request.approveTemplate}
                onClick={() => review(true)}>
                자동 기록 시작할 변경 확인
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
