import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import { defaults } from '../electron/model';
const catalog = JSON.parse(fs.readFileSync('../shared/catalog.json', 'utf8'));
const test = base.extend<{ startupFailure: string }>({
  startupFailure: ['', { option: true }],
});
test.beforeEach(async ({ page, startupFailure }) => {
  const config = defaults(catalog);
  await page.addInitScript(
    ({ catalog, config, startupFailure }) => {
      const state: any = {
        config,
        events: [],
        busy: false,
        phase: 'configure',
        logPath: 'test.log',
        inspection: {
          supported: true,
          wslReady: true,
          locationSupported: true,
          distros: [{ name: 'Ubuntu', location: 'D:\\WSL\\Ubuntu', version: 2 }],
          drives: [{ root: 'D:\\', freeGB: 415 }],
          orcaInstalled: false,
          patchSupported: false,
          patchApplied: false,
          linux: {
            osId: 'ubuntu',
            users: ['muring'],
            user: 'muring',
            zshrc: true,
            gitName: '',
            gitEmail: '',
            gitBranch: 'main',
            timezone: 'Asia/Seoul',
            auth: { gh: false, claude: false, codex: false },
            tools: { gh: true, claude: true, codex: true },
          },
        },
      };
      (window as any).testState = state;
      (window as any).bootstrap = {
        snapshot: async () => structuredClone(state),
        catalog: async () => catalog,
        save: async (c: any) => {
          state.config = c;
          return structuredClone(state);
        },
        inspect: async () => structuredClone(state),
        prepare: async () => ({ reboot: false }),
        installOrca: async () => {
          (window as any).orcaInstallerOpened = true;
          return structuredClone(state);
        },
        install: async () => ({ restartWsl: false }),
        previewContent: async () => {
          state.config.contentCommit = 'a'.repeat(40);
          state.contentPreview = {
            commit: state.config.contentCommit,
            message: '공용 명령 업데이트',
            commands: ['commit'],
            skills: ['commit'],
            changes: [{ path: 'skills/commit/SKILL.md', status: 'modified' }],
          };
          return structuredClone(state);
        },
        updateContent: async () => {
          (window as any).contentApplied = true;
          return structuredClone(state);
        },
        run: async (target?: string) => {
          (window as any).installerRan = true;
          (window as any).lastRunTarget = target;
          state.events = state.config.selected.map((step: string) => ({
            step,
            status: step === 'kb' && !target ? 'action-required' : 'completed',
            message: step === 'kb' && !target ? 'GitHub 로그인 필요' : '실제 상태 확인 완료',
            time: Date.now() / 1000,
            version: 1,
          }));
          state.events.push({
            step: '_run',
            status: 'incomplete',
            message: '연결 대기',
            version: 1,
            time: Date.now() / 1000,
          });
          return structuredClone(state);
        },
        stop: async () => {},
        login: async (t: string) => {
          state.inspection.linux.auth[t] = true;
          return structuredClone(state);
        },
        shutdown: async () => structuredClone(state),
        reboot: async () => {},
        logs: async () => {},
        discoverSetup: async (skill: string) => ({
          skill,
          path: '/home/muring/dev/mublog',
          blogs: skill === 'blog-draft' ? ['/home/muring/dev/mublog', '/home/muring/dev/other-blog'] : [],
          roots: [],
          projects:
            skill === 'usage-report'
              ? [
                  { path: '/home/muring/dev/new-project', alias: 'new-project' },
                  { path: '/home/muring/dev/mublog', alias: 'muring/mublog' },
                ]
              : [],
          targets: [{ platform: 'linux', path: '/tmp', kind: 'directory' }],
          preserve: [
            '/home/muring/dev',
            '/home/muring/.codex',
            '/home/muring/.claude',
            '/home/muring/.local/share',
          ],
          trackingConfigured: false,
          publisherConfigured: skill === 'usage-report',
          trackingConfig: '/home/muring/.config/ai-workflow/tracking.json',
        }),
        previewSetup: async (request: any) => {
          (window as any).setupRequest = request;
          return { id: 'preview-plan', request, actions: ['선택한 환경 준비'], blockers: [] };
        },
        executeSetup: async (id: string, credentials: any) => {
          (window as any).setupCredentialKeys = Object.keys(credentials || {});
          (window as any).setupExecuted = id;
          return {
            id,
            skill: (window as any).setupRequest.skill,
            status: (window as any).setupRequest.skill === 'blog-draft' ? 'waiting' : 'completed',
            ...((window as any).setupRequest.skill === 'usage-report' &&
            (window as any).setupRequest.initialize
              ? { fingerprint: 'a'.repeat(64) }
              : {}),
            message: '설정 저장 완료. 연결 검사에서 확인할 항목이 있습니다.',
            checks:
              (window as any).setupRequest.skill === 'blog-draft'
                ? [
                    { label: 'DB 연결·읽기', status: 'connected', message: 'SELECT 1 확인' },
                    { label: '이미지 버킷 접근', status: 'failed', message: '버킷과 인증값을 확인하세요.' },
                  ]
                : [],
            steps: [{ label: '블로그 경로 저장', status: 'completed' }],
            artifacts:
              (window as any).setupRequest.skill === 'storage-maintenance'
                ? [{ label: '진단 결과 (JSON)', path: '/tmp/snapshot.json' }]
                : [],
          };
        },
        openSetupArtifact: async (id: string, index: number) => {
          (window as any).openedArtifact = { id, index };
        },
        setupGuide: async (skill: string) => {
          (window as any).openedSetupGuide = skill;
        },
      };
      if (startupFailure) {
        const w = window as any;
        w.startupFail = true;
        w.startupCalls = { catalog: 0, snapshot: 0 };
        for (const method of ['catalog', 'snapshot']) {
          const original = w.bootstrap[method];
          w.bootstrap[method] = async () => {
            w.startupCalls[method]++;
            if (w.startupFail && method === startupFailure) throw Error('초기 조회 실패');
            if (method === 'snapshot' && w.holdStartup)
              await new Promise<void>(resolve => {
                w.releaseStartup = resolve;
              });
            return original();
          };
        }
      }
    },
    { catalog, config, startupFailure },
  );
  await page.goto('/');
});

for (const startupFailure of ['snapshot', 'catalog']) {
  test.describe(`initial ${startupFailure} failure`, () => {
    test.use({ startupFailure, viewport: { width: 900, height: 650 } });
    test('shows repeated errors and reloads both inputs before starting polling', async ({
      page,
    }, testInfo) => {
      await expect(page.getByRole('alert')).toHaveText('초기 조회 실패');
      const retry = page.getByRole('button', { name: '다시 시도', exact: true });
      await expect(retry).toBeEnabled();
      await expect(retry).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('startup-error.png') });
      await page.waitForTimeout(1200);
      expect(await page.evaluate(() => (window as any).startupCalls)).toEqual({ catalog: 1, snapshot: 1 });

      await retry.click();
      await expect
        .poll(() => page.evaluate(() => (window as any).startupCalls))
        .toEqual({ catalog: 2, snapshot: 2 });
      await expect(page.getByRole('alert')).toHaveText('초기 조회 실패');
      await page.evaluate(() => {
        (window as any).startupFail = false;
        (window as any).holdStartup = true;
      });
      await retry.click();
      await expect(page.getByRole('status')).toHaveText('설치 환경을 준비하고 있습니다…');
      await expect(retry).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await page.waitForTimeout(1200);
      expect(await page.evaluate(() => (window as any).startupCalls)).toEqual({ catalog: 3, snapshot: 3 });
      await page.evaluate(() => {
        (window as any).holdStartup = false;
        (window as any).releaseStartup();
      });
      await expect(page.getByRole('heading', { name: '환경 확인', exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as any).startupCalls.snapshot)).toBeGreaterThan(3);
      await page.getByRole('button', { name: '설치 구성 선택 →' }).click();
      await expect(page.getByRole('checkbox')).toHaveCount(24);
      expect(await page.evaluate(() => (window as any).installerRan)).toBeUndefined();
    });
  });
}
test('recommended choices preserve existing config and dependency deselection cascades', async ({ page }) => {
  await page.getByRole('button', { name: '설치 구성 선택 →' }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(24);
  const autoPatch = page.getByRole('checkbox', { name: 'Orca 자동 재패치', exact: false });
  await expect(autoPatch).not.toBeChecked();
  await autoPatch.check();
  await expect(autoPatch).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '.zshrc 전체 교체', exact: false })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Claude 권한 경고 생략', exact: false })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Orca 1.4.202/1.4.215', exact: false })).toBeDisabled();
  const monitor = page.getByRole('checkbox', { name: 'Orca 패치 누락 감시', exact: false });
  await expect(monitor).not.toBeChecked();
  await expect(monitor).toBeEnabled();
  await monitor.check();
  await expect(monitor).toBeChecked();
  await page.getByRole('checkbox', { name: 'Node · fnm', exact: false }).uncheck();
  await expect(page.getByRole('checkbox', { name: '개인 지식 저장소', exact: false })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Codex Recommended', exact: false })).not.toBeChecked();
  await page.getByRole('button', { name: '공통 개발환경', exact: false }).click();
  await expect(page.getByRole('checkbox', { name: 'Node · fnm', exact: false })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Orca 스킬 연결', exact: false })).not.toBeChecked();
});
test('review, progress, authentication, and incomplete summary are separate', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.getByRole('button', { name: '설치 구성 선택 →' }).click();
  await page.getByRole('checkbox', { name: 'Orca 패치 누락 감시', exact: false }).check();
  await page.getByRole('button', { name: '변경 내용 확인 →' }).click();
  await expect(page.getByText('.zshrc 기존 내용 보존, 관리 블록 연결')).toBeVisible();
  await page.getByRole('button', { name: '선택한 항목 설치 시작' }).click();
  await expect(page.getByText('GitHub 로그인 필요', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: '진행 상황 패널' }).getByText('설치 진행 기록'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '진행 기록 보기' })).toHaveCount(0);
  await page.getByRole('button', { name: '로그인 · 연동 →' }).click();
  await expect(page.getByRole('heading', { name: 'Orca 패치 누락 감시', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '감시 설치·상태 재확인' })).toBeEnabled();
  await page.getByRole('button', { name: '로그인', exact: true }).first().click();
  await expect(page.getByText('연결 확인됨', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '설치 완료 확인' })).toBeDisabled();
  for (const button of await page.getByRole('button', { name: '로그인', exact: true }).all())
    await button.click();
  await page.getByRole('button', { name: 'KB 연결 재시도' }).click();
  await page.getByRole('button', { name: '설치 완료 확인' }).click();
  await expect(page.getByRole('heading', { name: '선택한 도구를 준비했습니다' })).toBeVisible();
  const setup = page.getByRole('region', { name: '스킬 실행환경 준비' });
  await expect(setup.getByRole('heading', { name: '준비할 스킬 선택' })).toBeVisible();
  await expect(setup.locator('.setup-wizard')).toHaveCount(0);
  await page.setViewportSize({ width: 900, height: 650 });
  await setup.getByRole('button', { name: '블로그 초안 준비하기' }).click();
  await expect(setup.locator('.setup-input')).toBeFocused();
  await expect(setup.locator('.setup-input')).toHaveCSS('outline-style', 'none');
  const exitSetup = setup.getByRole('button', { name: /준비 취소 · 스킬 선택|스킬 선택으로 돌아가기/ });
  const footer = setup.locator('.setup-workspace-actions');
  let setupCapture = 0;
  async function assertFixedControls() {
    await expect(exitSetup).toBeInViewport();
    await expect(setup.locator('.setup-wizard-body')).toHaveCSS('padding-bottom', '2px');
    for (const panel of await setup.locator('.setup-plan, .setup-result').all()) {
      await expect(panel).toHaveCSS('margin-top', '0px');
      await expect(panel).toHaveCSS('outline-style', 'none');
    }
    await page.screenshot({ path: test.info().outputPath(`setup-stage-${++setupCapture}.png`) });
    await expect(footer).toBeInViewport();
    const before = await footer.boundingBox();
    await setup.locator('.setup-wizard-body').evaluate(element => {
      element.scrollTop = element.scrollHeight;
    });
    expect((await footer.boundingBox())!.y).toBe(before!.y);
    expect(await setup.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(exitSetup).toBeInViewport();
  }
  await assertFixedControls();
  await setup.locator('.setup-clone > summary').click();
  await setup
    .getByLabel('새로 받을 GitHub 저장소 주소 (기존 폴더가 없을 때)')
    .fill('https://github.com/example/blog.git');
  await setup.getByRole('button', { name: '내 환경에서 경로 찾기' }).click();
  await expect(setup.locator('.setup-clone')).toHaveCount(0);
  await expect(
    setup.getByText('기존 블로그 저장소를 확인했습니다. 새로 내려받을 필요가 없습니다.'),
  ).toBeVisible();
  const pathInput = setup.getByLabel('블로그 저장소 경로', { exact: true });
  await setup.getByRole('button', { name: '/home/muring/dev/other-blog 사용', exact: true }).click();
  await expect(pathInput).toHaveValue('/home/muring/dev/other-blog');
  await expect(setup.getByRole('status')).toHaveText('선택 완료');
  await expect(setup.getByText('발견한 블로그 저장소', { exact: true })).toHaveCount(0);
  await expect(pathInput).toBeFocused();
  await pathInput.pressSequentially('-edited');
  await expect(pathInput).toHaveValue('/home/muring/dev/other-blog-edited');
  await expect(pathInput).toBeFocused();
  await setup.locator('.setup-clone > summary').click();
  await expect(setup.getByLabel('새로 받을 GitHub 저장소 주소 (기존 폴더가 없을 때)')).toHaveValue('');
  await expect(setup.getByRole('status')).toHaveCount(0);
  await setup.getByRole('button', { name: '내 환경에서 경로 찾기' }).click();
  await expect(setup.getByText('발견한 블로그 저장소', { exact: true })).toBeVisible();
  await expect(setup.getByRole('status')).toHaveCount(0);
  await setup.getByRole('button', { name: '/home/muring/dev/mublog 사용', exact: true }).click();
  await page.setViewportSize({ width: 1100, height: 900 });
  expect(await setup.locator('.setup-wizard-body').evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(
    true,
  );
  await page.setViewportSize({ width: 900, height: 650 });
  await pathInput.focus();
  await expect(pathInput).toHaveCSS('outline-offset', '0px');
  await expect(pathInput).toHaveCSS('outline-width', '2px');
  await page.keyboard.press('Tab');
  await expect(pathInput).not.toBeFocused();
  await expect(setup.getByLabel('블로그 저장소 경로', { exact: true })).toHaveValue(
    '/home/muring/dev/mublog',
  );
  await setup.locator('.setup-readiness > summary').click();
  await setup.getByRole('button', { name: '블로그 초안 전체 가이드 열기' }).click();
  expect(await page.evaluate(() => (window as any).openedSetupGuide)).toBe('blog-draft');
  await setup.locator('.setup-readiness > summary').click();
  await setup.getByLabel('블로그 실행에 필요한 패키지 설치').check();
  await setup.getByRole('button', { name: '인증 설정으로 다음' }).click();
  await expect(setup.getByLabel('블로그 저장소 경로', { exact: true })).toHaveCount(0);
  const secret = setup.getByLabel('Supabase 서버용 secret 키 (SUPABASE_SECRET_KEY)');
  await expect(secret).toHaveAttribute('type', 'password');
  await expect(secret).toHaveAccessibleDescription(/Settings → API Keys/);
  await secret.fill('sb_secret_test_ui_only');
  await assertFixedControls();
  await page.screenshot({ path: test.info().outputPath('setup-credentials-900.png') });
  await setup.getByRole('button', { name: '준비할 변경 내용 확인' }).click();
  await expect(setup.getByRole('region', { name: '실행환경 변경 내용' })).toBeFocused();
  await assertFixedControls();
  await expect(setup.getByRole('button', { name: '확인한 환경 준비 실행' })).toBeDisabled();
  expect(await page.evaluate(() => JSON.stringify((window as any).setupRequest))).not.toContain(
    'sb_secret_test_ui_only',
  );
  await setup.getByRole('button', { name: '입력 수정', exact: true }).click();
  await setup.getByRole('button', { name: '저장소로 이전' }).click();
  await setup.getByLabel('블로그 저장소 경로', { exact: true }).fill('/home/muring/dev/other-blog');
  await setup.getByRole('button', { name: '인증 설정으로 다음' }).click();
  await expect(secret).toHaveValue('');
  await secret.fill('sb_secret_test_ui_only');
  await setup.getByRole('button', { name: '준비할 변경 내용 확인' }).click();
  await setup.getByLabel('위 대상과 변경 내용을 확인했습니다.').check();
  await setup.getByRole('button', { name: '확인한 환경 준비 실행' }).click();
  await expect(setup.locator('.setup-result')).toHaveClass(/setup-result-failed/);
  await expect(setup.getByText('DB 연결·읽기 · 연결 확인됨')).toBeVisible();
  await expect(setup.getByText('이미지 버킷 접근 · 연결 확인 실패')).toBeVisible();
  await assertFixedControls();
  await setup.getByRole('button', { name: '인증값 수정 · 이미지 버킷 접근' }).click();
  await expect(secret).toHaveValue('');
  await expect(setup.getByLabel('DB 연결 주소 (DATABASE_URL)')).toBeDisabled();
  await expect(setup.getByRole('button', { name: '인증값 교체 내용 확인' })).toBeDisabled();
  await secret.fill('sb_secret_replacement_test');
  const consent = setup.getByLabel('입력한 항목의 기존 인증값을 새 값으로 교체하는 데 동의합니다.');
  await consent.check();
  await secret.fill('sb_secret_replacement_changed');
  await expect(consent).not.toBeChecked();
  await consent.check();
  await setup.getByRole('button', { name: '인증값 교체 내용 확인' }).click();
  expect(await page.evaluate(() => (window as any).setupRequest.replaceCredentialKeys)).toEqual([
    'SUPABASE_SECRET_KEY',
  ]);
  await setup.getByLabel('위 대상과 변경 내용을 확인했습니다.').check();
  await setup.getByRole('button', { name: '확인한 환경 준비 실행' }).click();
  await exitSetup.click();
  await expect(setup.locator('.setup-wizard')).toHaveCount(0);
  // Cancellation during review must clear the draft and plan.
  await setup.getByRole('button', { name: '블로그 초안 준비하기' }).click();
  await setup.getByRole('button', { name: '인증 설정으로 다음' }).click();
  await expect(secret).toHaveValue('');
  await secret.fill('sb_secret_cancelled');
  await setup.getByRole('button', { name: '준비할 변경 내용 확인' }).click();
  await exitSetup.click();
  await setup.getByRole('button', { name: '블로그 초안 준비하기' }).click();
  await setup.getByRole('button', { name: '인증 설정으로 다음' }).click();
  await expect(secret).toHaveValue('');
  await expect(setup.locator('.setup-plan')).toHaveCount(0);
  await exitSetup.click();
  await setup.getByRole('button', { name: '사용량 분석 준비하기' }).click();
  await setup.getByRole('button', { name: '내 환경에서 경로 찾기' }).click();
  await setup.locator('.setup-optional > summary').click();
  const publish = setup.getByLabel('동기화할 때 기존 블로그 발행 설정 사용 허용');
  await expect(publish).toHaveCount(0);
  await setup.getByLabel('사용량 기록을 Git 저장소에 지금 동기화').check();
  await publish.check();
  await setup.getByLabel('사용량 기록을 Git 저장소에 지금 동기화').uncheck();
  await expect(publish).toHaveCount(0);
  await setup.getByRole('button', { name: '준비할 변경 내용 확인' }).click();
  expect(await page.evaluate(() => (window as any).setupRequest.allowPublish)).toBe(false);
  await setup.getByRole('button', { name: '입력 수정', exact: true }).click();
  await setup.getByLabel('사용량 자동 기록과 Git 동기화 켜기').check();
  await expect(publish).not.toBeChecked();
  await expect(setup.getByLabel('이 기기의 사용량 기록 설정 저장')).toBeChecked();
  await setup.getByLabel('동기화할 때 기존 블로그 발행 설정 사용 허용').check();
  await setup.locator('.setup-optional > summary').click();
  await expect(setup.locator('.setup-optional > summary')).toContainText('2개 선택');
  await assertFixedControls();
  await setup.getByRole('button', { name: '준비할 변경 내용 확인' }).click();
  expect(await page.evaluate(() => (window as any).setupRequest.schedule)).toBe(false);
  await setup.getByLabel('위 대상과 변경 내용을 확인했습니다.').check();
  await setup.getByRole('button', { name: '확인한 환경 준비 실행' }).click();
  await expect(setup.locator('.setup-result')).toHaveClass(/setup-result-completed/);
  await assertFixedControls();
  await expect(setup.getByRole('button', { name: '자동 기록 시작할 변경 확인' })).toBeDisabled();
  const template = setup.getByLabel('생성된 HTML을 열어 확인했고 이 보고서 양식을 승인합니다.');
  await template.check();
  await setup.getByRole('button', { name: '설정 수정', exact: true }).click();
  await setup.getByLabel('KB 저장소 경로', { exact: true }).fill('/home/muring/dev/other-kb');
  await expect(template).toHaveCount(0);
  await setup.getByRole('button', { name: '준비할 변경 내용 확인' }).click();
  await setup.getByLabel('위 대상과 변경 내용을 확인했습니다.').check();
  await setup.getByRole('button', { name: '확인한 환경 준비 실행' }).click();
  await template.check();
  await setup.getByRole('button', { name: '자동 기록 시작할 변경 확인' }).click();
  expect(await page.evaluate(() => (window as any).setupRequest.schedule)).toBe(true);
  expect(await page.evaluate(() => (window as any).setupRequest.sync)).toBe(false);
  await assertFixedControls();
  await setup.getByLabel('위 대상과 변경 내용을 확인했습니다.').check();
  await setup.getByRole('button', { name: '자동 기록 시작', exact: true }).click();
  await expect(template).toHaveCount(0);
  await exitSetup.click();
  await setup.getByRole('button', { name: '저장공간 진단 준비하기' }).click();
  await expect(setup.locator('textarea')).toHaveCount(0);
  await setup.getByRole('button', { name: '준비할 변경 내용 확인' }).click();
  expect(await page.evaluate(() => (window as any).setupRequest.targets)).toEqual([
    { platform: 'linux', path: '/tmp', kind: 'directory' },
  ]);
  expect(await page.evaluate(() => (window as any).setupRequest.preserve)).toHaveLength(4);
  await setup.getByRole('button', { name: '입력 수정', exact: true }).click();
  await setup.locator('summary').filter({ hasText: '자동으로 찾은 진단 대상 확인' }).click();
  await expect(setup.getByText('Ubuntu · /tmp', { exact: true })).toBeVisible();
  await setup.getByRole('button', { name: '진단·보존 위치 직접 지정', exact: true }).click();
  await setup.getByRole('button', { name: '/tmp 진단 제외', exact: true }).click();
  await expect(setup.getByText('진단할 위치를 하나 이상 추가하세요.')).toBeVisible();
  await setup.getByLabel('추가할 경로', { exact: true }).fill('relative/path');
  await setup.getByRole('button', { name: '목록에 추가', exact: true }).click();
  await expect(setup.getByText('Ubuntu 절대 경로를 입력하세요. 예: /home/me/data')).toBeVisible();
  await setup.getByLabel('추가할 경로', { exact: true }).fill('/home/muring/data');
  await setup.getByRole('button', { name: '목록에 추가', exact: true }).click();
  await setup.getByRole('combobox', { name: '경로 환경', exact: true }).click();
  await expect(setup.getByRole('combobox', { name: '경로 환경', exact: true })).toHaveCSS(
    'outline-offset',
    '-2px',
  );
  await expect(page.getByRole('listbox', { name: '경로 환경', exact: true })).toBeInViewport();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(setup.getByRole('combobox', { name: '경로 환경', exact: true })).toContainText('Windows');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await setup.getByLabel('추가할 경로', { exact: true }).fill('D:\\Cache');
  await setup.getByRole('button', { name: '목록에 추가', exact: true }).click();
  await setup.getByRole('combobox', { name: '추가할 목록', exact: true }).click();
  await page.getByRole('option', { name: '보존할 위치', exact: true }).click();
  await setup.getByLabel('추가할 경로', { exact: true }).fill('D:\\Important');
  await setup.getByRole('button', { name: '목록에 추가', exact: true }).click();
  await assertFixedControls();
  await page.evaluate(() => {
    const api = (window as any).bootstrap;
    const preview = api.previewSetup;
    (window as any).setupBlock = true;
    api.previewSetup = async (request: any) => ({
      ...(await preview(request)),
      blockers: (window as any).setupBlock ? ['진단 도구를 준비하세요.'] : [],
    });
  });
  await setup.getByRole('button', { name: '준비할 변경 내용 확인' }).click();
  await expect(setup.locator('.setup-plan')).toHaveClass(/setup-plan-blocked/);
  expect(await page.evaluate(() => (window as any).setupRequest.targets)).toEqual([
    { platform: 'linux', path: '/home/muring/data', kind: 'directory' },
    { platform: 'windows', path: 'D:\\Cache', kind: 'directory' },
  ]);
  expect(await page.evaluate(() => (window as any).setupRequest.preserve)).toHaveLength(5);
  await expect(
    setup.locator('.setup-plan').getByText('Windows · D:\\Important', { exact: true }),
  ).toBeVisible();
  await expect(setup.getByLabel('위 대상과 변경 내용을 확인했습니다.')).toBeDisabled();
  await expect(setup.getByRole('button', { name: '확인한 환경 준비 실행' })).toBeDisabled();
  await assertFixedControls();
  await setup.getByRole('button', { name: '입력 수정', exact: true }).click();
  await page.evaluate(() => {
    (window as any).setupBlock = false;
  });
  await setup.getByRole('button', { name: '준비할 변경 내용 확인' }).click();
  await expect(setup.locator('.setup-plan')).not.toHaveClass(/setup-plan-blocked/);
  await expect(setup.getByLabel('위 대상과 변경 내용을 확인했습니다.')).not.toBeChecked();
  await setup.getByLabel('위 대상과 변경 내용을 확인했습니다.').check();
  await setup.getByRole('button', { name: '확인한 환경 준비 실행' }).click();
  await assertFixedControls();
  await expect(setup.locator('.setup-result')).toHaveClass(/setup-result-completed/);
  await expect(setup.getByRole('button', { name: '스킬 선택으로 돌아가기', exact: true })).toBeVisible();
  await setup.getByRole('button', { name: '진단 결과 (JSON) 열기', exact: true }).click();
  expect(await page.evaluate(() => (window as any).openedArtifact)).toEqual({ id: 'preview-plan', index: 0 });
  await expect(setup.locator('.setup-result')).toBeVisible();
  await setup.getByRole('button', { name: '설정 수정', exact: true }).click();
  await expect(setup.getByRole('button', { name: 'D:\\Cache 진단 제외', exact: true })).toBeVisible();
  await expect(
    setup.getByRole('button', { name: 'D:\\Important 추가 보존 취소', exact: true }),
  ).toBeVisible();
  await exitSetup.click();
  await setup.getByRole('button', { name: '사용량 분석 준비하기' }).click();
  await expect(setup.getByLabel('이 기기의 사용량 기록 설정 저장')).not.toBeChecked();
  await expect(setup.locator('.setup-result, .setup-plan')).toHaveCount(0);
  await setup.locator('.setup-optional > summary').click();
  await setup.getByLabel('사용량 자동 기록과 Git 동기화 켜기').check();
  for (const status of ['failed', 'missing']) {
    await page.evaluate(status => {
      (window as any).bootstrap.executeSetup = async () => ({
        id: 'partial-result',
        skill: 'usage-report',
        status: 'completed',
        fingerprint: 'b'.repeat(64),
        steps: [],
        artifacts: [],
        checks: [{ label: '보고서 생성', status }],
      });
    }, status);
    await setup.getByRole('button', { name: '준비할 변경 내용 확인' }).click();
    await setup.getByLabel('위 대상과 변경 내용을 확인했습니다.').check();
    await setup.getByRole('button', { name: '확인한 환경 준비 실행' }).click();
    await expect(setup.locator('.setup-result')).toHaveClass(
      new RegExp(`setup-result-${status === 'failed' ? 'failed' : 'waiting'}`),
    );
    await expect(setup.locator('.setup-result h4')).toContainText(
      status === 'failed' ? '실패' : '추가 확인 필요',
    );
    await expect(setup.getByRole('button', { name: '자동 기록 시작할 변경 확인' })).toHaveCount(0);
    await assertFixedControls();
    await setup.getByRole('button', { name: '설정 수정', exact: true }).click();
  }
  expect(errors).toEqual([]);
});

test('content update requires preview and does not run installer', async ({ page }) => {
  await page.getByRole('button', { name: '커맨드 · 스킬 업데이트', exact: false }).click();
  await expect(page.getByRole('button', { name: '확인한 버전 적용' })).toBeDisabled();
  await page.getByRole('button', { name: '업데이트 확인', exact: true }).click();
  await expect(page.getByText('a'.repeat(40), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '확인한 버전 적용' }).click();
  expect(await page.evaluate(() => (window as any).contentApplied)).toBe(true);
  expect(await page.evaluate(() => (window as any).installerRan)).toBeUndefined();
});
test('changing content targets requires another preview', async ({ page }) => {
  await page.getByRole('button', { name: '커맨드 · 스킬 업데이트', exact: false }).click();
  await page.getByRole('button', { name: '업데이트 확인', exact: true }).click();
  await expect(page.getByRole('button', { name: '확인한 버전 적용' })).toBeEnabled();
  await page.getByRole('button', { name: '대상 선택 변경' }).click();
  await page.getByRole('checkbox', { name: 'Codex 공용 스킬', exact: false }).uncheck();
  await page.getByRole('button', { name: '커맨드 · 스킬 업데이트', exact: false }).click();
  await expect(page.getByRole('button', { name: '확인한 버전 적용' })).toBeDisabled();
});

test('future stages stay locked and installer is launched only on request', async ({ page }) => {
  for (const name of ['변경 내용 확인', '설치 진행', '로그인 · 연동', '완료'])
    await expect(page.locator('nav').getByRole('button', { name, exact: false })).toBeDisabled();
  const wsl = page.getByRole('button', { name: 'WSL 준비됨' });
  const orca = page.getByRole('button', { name: 'Orca 다운로드 · 설치' });
  await expect(wsl).toBeDisabled();
  const a = await wsl.boundingBox();
  const b = await orca.boundingBox();
  expect(b!.x).toBeGreaterThan(a!.x + a!.width + 15);
  expect(b!.y).toBe(a!.y);
  await page.screenshot({ path: 'test-results/pc-state.png' });
  await orca.click();
  expect(await page.evaluate(() => (window as any).orcaInstallerOpened)).toBe(true);
  await page.evaluate(() => {
    (window as any).testState.inspection.orcaInstalled = true;
  });
  await expect(page.getByRole('button', { name: 'Orca 설치됨' })).toBeDisabled();
  await page.evaluate(() => {
    (window as any).testState.inspection.wslReady = false;
  });
  await expect(page.getByRole('button', { name: 'WSL 준비', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).installerRan)).toBeUndefined();
});
test('only body scrolls at the minimum window size', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 650 });
  await page.getByRole('button', { name: '설치 구성 선택 →' }).click();
  const heading = page.getByRole('heading', { name: '설치 구성', exact: true });
  const next = page.getByRole('button', { name: '변경 내용 확인 →' });
  const before = await heading.boundingBox();
  const buttonBefore = await next.boundingBox();
  await page.locator('.page-content').evaluate(el => (el.scrollTop = el.scrollHeight));
  expect(await heading.boundingBox()).toEqual(before);
  expect(await next.boundingBox()).toEqual(buttonBefore);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.locator('.page-content').evaluate(el => el.scrollTop)).toBeGreaterThan(500);
  expect(buttonBefore!.y + buttonBefore!.height).toBeLessThan(650);
  await page.screenshot({ path: 'test-results/fixed-layout.png' });
});
test('editing the inspected account locks configuration and updates', async ({ page }) => {
  await page.getByLabel('Ubuntu 사용자명', { exact: true }).fill('another');
  await expect(page.getByRole('button', { name: '설치 구성 선택 →' })).toBeDisabled();
  await expect(
    page.locator('nav').getByRole('button', { name: '커맨드 · 스킬 업데이트', exact: false }),
  ).toBeDisabled();
});

test('long tasks show live stages, real counts, elapsed time and failure history', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    w.bootstrap.inspect = () =>
      new Promise((resolve, reject) => {
        const state = w.testState;
        state.busy = true;
        state.operation = {
          title: '환경 확인',
          status: 'running',
          startedAt: Date.now() - 3000,
          current: { label: 'Codex 로그인 상태 확인', completed: 2, total: 13, unit: 'items' },
          steps: [
            { label: 'Windows 검사', time: Date.now(), status: 'completed' },
            { label: 'Codex 로그인 상태 확인', time: Date.now(), status: 'running' },
          ],
        };
        w.failInspection = () => {
          state.busy = false;
          state.operation.status = 'failed';
          state.operation.endedAt = Date.now();
          state.operation.steps[1].status = 'failed';
          reject(Error('검사 연결 실패'));
        };
      });
  });
  await page.getByRole('button', { name: '환경 확인 / 새로고침' }).click();
  const panel = page.getByRole('region', { name: '작업 진행 상황' });
  await expect(panel.getByText('Codex 로그인 상태 확인', { exact: true })).toBeVisible();
  await expect(panel.getByText('2 / 13 항목 처리', { exact: false })).toBeVisible();
  await expect(panel.getByText('진행 과정 2개')).toBeVisible();
  await expect(panel.getByRole('listitem').filter({ hasText: 'Windows 검사' })).toBeVisible();
  await page.screenshot({ path: 'test-results/progress.png' });
  await page.evaluate(() => (window as any).failInspection());
  await expect(page.getByRole('alert')).toContainText('검사 연결 실패');
  await expect(panel).toHaveClass(/failed/);
});
test('dropdown lists are styled, keyboard accessible and close on Escape/outside', async ({ page }) => {
  await page.evaluate(() => {
    (window as any).testState.inspection.distros.push({
      name: 'Ubuntu-Test',
      version: 2,
      location: 'D:\\Test',
    });
  });
  await page.waitForTimeout(1100);
  const distro = page.getByRole('combobox', { name: '배포판' });
  await distro.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(page.getByRole('option', { name: 'Ubuntu', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.screenshot({ path: 'test-results/dropdown.png' });
  await distro.press('ArrowDown');
  await distro.press('Enter');
  await expect(distro).toContainText('Ubuntu-Test');
  await distro.click();
  await distro.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await distro.click();
  await page.getByRole('heading', { name: '환경 확인', exact: true }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.locator('select')).toHaveCount(0);
  // A scroll event that does not move the trigger (queued by scroll-into-view before opening) must not close the menu; a real scroll must.
  await distro.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.locator('.page-content').dispatchEvent('scroll');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.locator('.page-content').evaluate(el => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).testState.inspection.distros = [];
  });
  const location = page.getByRole('combobox', { name: '저장 위치 선택' });
  await expect(location).toBeVisible();
  await location.click();
  await location.press('End');
  await location.press('Enter');
  await expect(page.getByLabel('Ubuntu 가상 디스크 위치', { exact: true })).toHaveValue('C:\\WSL\\Ubuntu');
});
test('operation state stays with its stage and comes back on return', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    w.bootstrap.inspect = async () => {
      const state = w.testState;
      state.operation = {
        title: '환경 확인',
        status: 'completed',
        startedAt: Date.now() - 2000,
        endedAt: Date.now(),
        current: { label: 'Ubuntu 검사 완료' },
        steps: [
          { label: 'Windows 검사', time: Date.now(), status: 'completed' },
          { label: 'Ubuntu 검사 완료', time: Date.now(), status: 'completed' },
        ],
      };
      return structuredClone(state);
    };
  });
  const rail = page.getByRole('complementary', { name: '진행 상황 패널' });
  await expect(rail.getByText('이 단계에서 실행한 작업이 없습니다.')).toBeVisible();
  await page.getByRole('button', { name: '환경 확인 / 새로고침' }).click();
  await expect(rail.getByText('Ubuntu 검사 완료', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '설치 구성 선택 →' }).click();
  await page.waitForTimeout(1100);
  await expect(rail.getByText('이 단계에서 실행한 작업이 없습니다.')).toBeVisible();
  await expect(rail.getByText('Ubuntu 검사 완료', { exact: true })).toHaveCount(0);
  await page.locator('nav').getByRole('button', { name: '환경 확인' }).click();
  await expect(rail.getByText('Ubuntu 검사 완료', { exact: true })).toBeVisible();
  await expect(rail.getByText('작업 종료', { exact: false })).toBeVisible();
});
test('rail collapses to a strip and reopens when a new task starts', async ({ page }) => {
  const rail = page.getByRole('complementary', { name: '진행 상황 패널' });
  const body = page.locator('.page-content');
  const openWidth = (await rail.boundingBox())!.width;
  const bodyWidth = (await body.boundingBox())!.width;
  expect(openWidth).toBeGreaterThanOrEqual(280);
  await page.getByRole('button', { name: '진행 상황 패널 접기' }).click();
  await expect(rail).toHaveClass(/closed/);
  await expect.poll(async () => (await rail.boundingBox())!.width).toBeLessThanOrEqual(44);
  await expect.poll(async () => (await body.boundingBox())!.width).toBeGreaterThan(bodyWidth + 200);
  await page.getByRole('button', { name: '진행 상황 패널 펼치기' }).click();
  await expect(rail).toHaveClass(/open/);
  await page.getByRole('button', { name: '진행 상황 패널 접기' }).click();
  await page.getByRole('button', { name: '환경 확인 / 새로고침' }).click();
  await expect(rail).toHaveClass(/open/);
  await page.screenshot({ path: 'test-results/rail.png' });
});

test('Orca Codex shutdown guidance and independent retry', async ({ page }) => {
  await page.getByRole('button', { name: '설치 구성 선택 →' }).click();
  await page.getByRole('button', { name: '변경 내용 확인 →' }).click();
  await page.getByRole('button', { name: '선택한 항목 설치 시작' }).click();
  await page.evaluate(() => {
    const state = (window as any).testState;
    state.events.find((e: any) => e.step === 'orca-codex').status = 'action-required';
  });
  await page.getByRole('button', { name: '로그인 · 연동 →' }).click();
  const card = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Orca Codex 실행 설정', exact: true }) });
  await expect(card.getByText(/Orca를 완전히 종료한 뒤 적용하세요/)).toBeVisible();
  await card.getByRole('button', { name: 'Codex 실행 설정 적용·확인' }).click();
  expect(await page.evaluate(() => (window as any).lastRunTarget)).toBe('orca-codex');
});

test('dev-tools brand stays on one line at the minimum window size', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 650 });
  await expect(page).toHaveTitle('dev-tools');
  const brand = page.locator('.brand');
  await expect(brand).toHaveText('↗ dev-tools');
  const size = await brand.evaluate(element => {
    return {
      whiteSpace: getComputedStyle(element).whiteSpace,
      fits: element.scrollWidth <= element.clientWidth,
      height: element.getBoundingClientRect().height,
    };
  });
  expect(size.whiteSpace).toBe('nowrap');
  expect(size.fits).toBe(true);
  expect(size.height).toBeLessThan(45);
  await page.screenshot({ path: testInfo.outputPath('dev-tools-preview.png'), fullPage: true });
});
