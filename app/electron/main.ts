import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { OperationTracker, ProgressUpdate } from './progress';
import { downloadOrca } from './orca';
import { decodeNativeOutput } from './encoding';
import { setupSkill, SetupResult, blogCredentials } from './skill-setup-model';
import {
  Config,
  ContentPreview,
  CONTENT_GROUPS,
  defaults,
  Inspection,
  InstallEvent,
  Item,
  Snapshot,
  validate,
} from './model';

let window: BrowserWindow;
let catalog: Item[];
let config: Config;
let inspection: Inspection | undefined;
let busy = false;
let phase = 'inspect';
let currentEvents = '';
let stateDir: string;
let assets: string;
let contentPreview: ContentPreview | undefined;
let contentTarget = '';
const operation = new OperationTracker();
const report = (update: ProgressUpdate) => operation.report(update);
let trackingRun = false;

function contentKey(value: Config) {
  return JSON.stringify([
    value.distro,
    value.user,
    value.selected.filter(id => CONTENT_GROUPS.includes(id)).sort(),
  ]);
}

async function atomic(file: string, value: unknown) {
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temp, file);
}
async function persist() {
  await atomic(path.join(stateDir, 'state.json'), { config, phase, currentEvents });
}
async function capture(
  executable: string,
  args: string[],
  timeout = 30000,
  acceptedCodes = [0],
  input?: string,
): Promise<string> {
  const expectedOperation = operation.value;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false });
    if (input !== undefined) {
      child.stdin.on('error', () => {
        clearTimeout(timer);
        reject(Error('준비 입력을 전달하지 못했습니다. 다시 시도하세요.'));
      });
      child.stdin.end(input);
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(Error('명령 실행 시간이 초과되었습니다.'));
    }, timeout);
    child.stdout.on('data', chunk => stdout.push(chunk));
    const decoder = new StringDecoder('utf8');
    let pending = '';
    child.stderr.on('data', chunk => {
      stderr.push(chunk);
      pending += decoder.write(chunk);
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines)
        if (line.startsWith('BOOTSTRAP_PROGRESS ') && operation.value === expectedOperation) {
          try {
            report(JSON.parse(line.slice(19)));
          } catch {}
        }
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      code !== null && acceptedCodes.includes(code)
        ? resolve(decodeNativeOutput(Buffer.concat(stdout)))
        : reject(
            Error(
              input !== undefined
                ? '실행환경 준비 입력 처리에 실패했습니다.'
                : decodeNativeOutput(Buffer.concat(stderr))
                    .split('\n')
                    .filter(line => !line.startsWith('BOOTSTRAP_PROGRESS '))
                    .join('\n') || `명령 실패 (${code})`,
            ),
          );
    });
  });
}
async function helper(action: string, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  if (process.platform !== 'win32') throw Error('실제 설치는 Windows에서 실행하세요.');
  const id = crypto.randomUUID();
  const requestFile = path.join(stateDir, `${id}.request.json`);
  const resultFile = path.join(stateDir, `${id}.result.json`);
  await atomic(requestFile, { action, ...extra });
  const helperLabels: Record<string, string> = {
    inspect: 'Windows 검사 시작',
    prepare: 'Windows 관리자 권한 승인 대기',
    install: 'Ubuntu 준비',
    launch: '실행 터미널 작업 · 입력 요청이 있으면 해당 창에서 진행하세요.',
    shutdown: 'WSL 종료 및 재시작',
    reboot: 'Windows 재부팅 예약',
  };
  report({ label: helperLabels[action] || action });
  // No execution deadline for visible login/install terminals. User can finish them.
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(assets, 'windows/app-host.ps1'),
        '-RequestFile',
        requestFile,
        '-ResultFile',
        resultFile,
      ],
      { windowsHide: true, stdio: 'ignore', shell: false },
    );
    let closed = false,
      seen = 0;
    let polling: Promise<void> | undefined;
    const poll = (): Promise<void> => {
      if (closed) return Promise.resolve();
      if (polling) return polling;
      polling = (async () => {
        try {
          const lines = (await fs.readFile(resultFile + '.progress.jsonl', 'utf8')).split('\n').slice(0, -1);
          if (!closed) {
            for (const line of lines.slice(seen)) {
              try {
                report(JSON.parse(line));
              } catch {}
            }
            seen = lines.length;
          }
        } catch {}
      })().finally(() => {
        polling = undefined;
      });
      return polling;
    };
    const progressTimer = setInterval(() => void poll(), 250);
    child.on('error', error => {
      closed = true;
      clearInterval(progressTimer);
      reject(error);
    });
    child.on('close', async () => {
      clearInterval(progressTimer);
      await polling;
      await poll();
      closed = true;
      try {
        const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
        if (result.error) reject(Error(result.error));
        else resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        await Promise.all(
          [requestFile, resultFile, requestFile + '.system.json', resultFile + '.progress.jsonl'].map(file =>
            fs.rm(file, { force: true }).catch(() => {}),
          ),
        );
      }
    });
  });
}
async function linuxPath(windowsPath: string) {
  return (
    await capture('wsl.exe', ['-d', config.distro, '-u', config.user, '--exec', 'wslpath', '-a', windowsPath])
  ).trim();
}
async function events(): Promise<InstallEvent[]> {
  if (!currentEvents) return [];
  try {
    return (await fs.readFile(currentEvents, 'utf8')).split('\n').flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
async function appendEvent(step: string, status: string, message: string) {
  if (!currentEvents) currentEvents = path.join(stateDir, `run-${Date.now()}.jsonl`);
  await fs.appendFile(
    currentEvents,
    JSON.stringify({ version: 1, step, status, message, time: Date.now() / 1000 }) + '\n',
  );
}
async function snapshot(): Promise<Snapshot> {
  const history = await events();
  if (trackingRun) {
    const latest = Object.fromEntries(history.filter(e => e.step !== '_run').map(e => [e.step, e]));
    const active = history.filter(e => e.step !== '_run').at(-1);
    if (active)
      report({
        label: `${catalog.find(i => i.id === active.step)?.title || active.step} · ${active.message}`,
        completed: config.selected.filter(id =>
          ['completed', 'failed', 'action-required', 'reboot-required'].includes(latest[id]?.status),
        ).length,
        total: config.selected.length,
        unit: 'items',
      });
  }
  return {
    config,
    inspection,
    contentPreview,
    operation: operation.value,
    events: history,
    busy,
    phase,
    logPath: currentEvents.replace(/\.jsonl$/, '.log'),
  };
}
async function inspect() {
  if (process.platform !== 'win32') {
    inspection = {
      supported: false,
      wslReady: false,
      locationSupported: false,
      distros: [],
      drives: [],
      orcaInstalled: false,
      patchSupported: false,
      patchApplied: false,
      error: 'Windows 11 x64에서 실행하세요. 이 화면은 개발용 미리보기입니다.',
    };
    return snapshot();
  }
  inspection = (await helper('inspect')) as Inspection;
  const distro = inspection.distros.find(i => i.name === config.distro);
  if (distro) {
    report({ label: 'Ubuntu 검사 시작 · WSL 응답 대기' });
    try {
      const script = await linuxPath(path.join(assets, 'linux/inspect.sh'));
      inspection.linux = JSON.parse(
        await capture('wsl.exe', ['-d', config.distro, '-u', config.user, '--exec', 'bash', script], 120000),
      );
    } catch (error) {
      report({ label: '기존 Ubuntu 기본 계정 확인 · WSL 응답 대기' });
      // Discover the existing default user rather than assume the Windows account name.
      try {
        const user = (await capture('wsl.exe', ['-d', config.distro, '--exec', 'id', '-un'])).trim();
        if (user !== 'root' && /^[a-z_][a-z0-9_-]{0,31}$/.test(user)) {
          config.user = user;
          const script = await linuxPath(path.join(assets, 'linux/inspect.sh'));
          inspection.linux = JSON.parse(
            await capture('wsl.exe', ['-d', config.distro, '-u', user, '--exec', 'bash', script], 120000),
          );
        } else
          inspection.error = '기존 Ubuntu의 개발 계정을 선택하세요. root는 설치 계정으로 사용할 수 없습니다.';
      } catch {
        inspection.error = `Ubuntu 확인 실패: ${String(error)}`;
      }
    }
    config.installLocation = distro.location;
    if (inspection.linux) {
      if (!config.gitName) config.gitName = inspection.linux.gitName;
      if (!config.gitEmail) config.gitEmail = inspection.linux.gitEmail;
    }
  }
  await persist();
  return snapshot();
}
async function guarded(title: string, action: () => Promise<unknown>) {
  if (busy) throw Error('진행 중인 작업이 끝난 후 다시 시도하세요.');
  busy = true;
  operation.start(title);
  try {
    const result = await action();
    operation.finish('completed');
    return result;
  } catch (error) {
    operation.finish('failed');
    if (operation.value) operation.value.current = { label: String(error).slice(0, 240) };
    throw error;
  } finally {
    trackingRun = false;
    busy = false;
    await fs
      .writeFile(path.join(stateDir, 'last-operation.json'), JSON.stringify(operation.value, null, 2))
      .catch(() => {});
    await persist();
  }
}
async function confirm(message: string, detail: string) {
  report({ label: message + ' · 사용자 확인 대기' });
  const approved =
    (
      await dialog.showMessageBox(window, {
        type: 'question',
        buttons: ['취소', '진행'],
        defaultId: 0,
        cancelId: 0,
        message,
        detail,
      })
    ).response === 1;
  if (!approved) operation.finish('cancelled');
  return approved;
}
async function previewContent() {
  await inspect();
  if (inspection?.linux?.osId !== 'ubuntu') throw Error('Ubuntu 환경 확인을 먼저 완료하세요.');
  const script = await linuxPath(path.join(assets, 'linux/content.py'));
  const result = JSON.parse(
    await capture(
      'wsl.exe',
      ['-d', config.distro, '-u', config.user, '--exec', 'python3', script, 'preview'],
      120000,
    ),
  ) as ContentPreview;
  if (!/^[0-9a-f]{40}$/.test(result.commit)) throw Error('GitHub 커밋 확인에 실패했습니다.');
  contentPreview = result;
  contentTarget = contentKey(config);
  config.contentCommit = result.commit;
  await persist();
  return snapshot();
}
async function updateContent() {
  const groups = config.selected.filter(id => CONTENT_GROUPS.includes(id));
  if (!groups.length) throw Error('설치 구성에서 커맨드·스킬 대상을 선택하세요.');
  if (
    !contentPreview ||
    contentTarget !== contentKey(config) ||
    config.contentCommit !== contentPreview.commit
  )
    throw Error('적용할 버전과 변경 내용을 먼저 확인하세요.');
  const script = await linuxPath(path.join(assets, 'linux/content.py'));
  const directory = path.join(stateDir, `content-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  // Keep installation results in their existing log; this update has its own audit log.
  const log = path.join(directory, 'result.json');
  try {
    const result = JSON.parse(
      await capture(
        'wsl.exe',
        [
          '-d',
          config.distro,
          '-u',
          config.user,
          '--exec',
          'python3',
          script,
          'apply',
          '--commit',
          contentPreview.commit,
          ...groups.flatMap(group => ['--group', group]),
        ],
        300000,
      ),
    );
    await atomic(log, { status: 'completed', ...result });
    for (const group of groups)
      await appendEvent(group, 'completed', `GitHub ${result.commit.slice(0, 12)} 적용 완료`);
    contentPreview = { ...contentPreview, installedCommit: result.commit, changes: [] };
    if (inspection?.linux) inspection.linux.contentCommit = result.commit;
    return snapshot();
  } catch (error) {
    await atomic(log, { status: 'failed', message: String(error) });
    throw error;
  }
}
async function run(step?: string) {
  config = validate(config, catalog);
  if (step && (!catalog.some(i => i.id === step) || !config.selected.includes(step)))
    throw Error('선택된 설치 항목만 실행할 수 있습니다.');
  if (
    (!step || CONTENT_GROUPS.includes(step)) &&
    config.selected.some(id => CONTENT_GROUPS.includes(id)) &&
    !config.contentCommit
  )
    throw Error('변경 내용 확인 화면에서 커맨드·스킬 버전을 먼저 확인하세요.');
  await inspect();
  if (!inspection?.supported || !inspection.linux) throw Error('환경 확인과 Ubuntu 준비를 먼저 완료하세요.');
  if (inspection.linux.osId !== 'ubuntu') throw Error('이 설치기는 Ubuntu만 지원합니다.');
  if (inspection.distros.find(i => i.name === config.distro)?.version !== 2)
    throw Error('WSL2 배포판을 선택하세요.');
  if (
    (!step || step === 'orca-patch') &&
    config.selected.includes('orca-patch') &&
    !inspection.patchSupported
  )
    throw Error('현재 Orca 파일은 패치 대상이 아닙니다. 패치 선택을 해제하세요.');
  const directory = path.join(stateDir, `run-${Date.now()}`);
  await fs.mkdir(directory, { recursive: true });
  const configFile = path.join(directory, 'config.json');
  currentEvents = path.join(directory, 'events.jsonl');
  await atomic(configFile, config);
  phase = 'install';
  await persist();
  const script = await linuxPath(path.join(assets, 'linux/app-launch.sh'));
  trackingRun = true;
  const result = await helper('launch', {
    config,
    script,
    arguments: [await linuxPath(configFile), await linuxPath(currentEvents), step || ''],
  });
  trackingRun = false;
  const history = await events();
  if (
    !history.some(
      e => e.step === '_run' && ['completed', 'incomplete', 'paused', 'failed'].includes(e.status),
    )
  ) {
    await appendEvent(
      '_run',
      'failed',
      `터미널이 종료되었습니다 (${result.exitCode}). sudo 인증과 터미널 출력을 확인하고 재시도하세요.`,
    );
  }
  phase = 'connect';
  await inspect();
  const finalEvents = await events();
  const end = finalEvents.filter(e => e.step === '_run').at(-1);
  if (end?.status !== 'completed') {
    report({ label: end?.message || '미완료 항목을 확인하세요.' });
    operation.finish(
      end?.status === 'failed' || finalEvents.some(e => e.status === 'failed') ? 'failed' : 'waiting',
    );
  }
  return snapshot();
}

// Plans and artifacts are bound to the inspected Ubuntu account, never arbitrary renderer paths.
const setupPlans = new Map<string, string>();
const setupResults = new Map<string, { target: string; result: SetupResult }>();
function setupTarget() {
  return JSON.stringify([config.distro, config.user]);
}
async function setupCommand(args: string[], input?: string) {
  if (
    process.platform !== 'win32' ||
    inspection?.linux?.osId !== 'ubuntu' ||
    inspection.linux.user !== config.user
  )
    throw Error('대상 Ubuntu와 개발 계정을 먼저 확인하세요.');
  const script = await linuxPath(path.join(assets, 'linux/skill-setup-launch.sh'));
  const value = JSON.parse(
    await capture(
      'wsl.exe',
      ['-d', config.distro, '-u', config.user, '--exec', 'bash', script, ...args],
      30 * 60 * 1000,
      [0, 1],
      input,
    ),
  );
  if (value.error) throw Error(value.error);
  return value;
}

// The downloaded portable EXE carries Mark-of-the-Web, so SmartScreen and the "open file" warning ask on
// every launch. Once the user has chosen to run it, drop the mark so later launches (e.g. after the WSL
// reboot) start without the prompt. The stream can be removed while the launcher is still running.
async function unblockPortableExecutable() {
  const file = process.env.PORTABLE_EXECUTABLE_FILE;
  if (process.platform !== 'win32' || !file) return;
  try {
    await fs.unlink(file + ':Zone.Identifier');
  } catch {
    /* No mark, or not removable: SmartScreen will simply ask again. */
  }
}

async function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  await unblockPortableExecutable();
  stateDir =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA!, 'dev-bootstrap')
      : path.join(app.getPath('userData'), 'dev-bootstrap-preview');
  assets = app.isPackaged ? path.join(process.resourcesPath, 'bootstrap') : path.resolve(__dirname, '../..');
  await fs.mkdir(stateDir, { recursive: true });
  catalog = JSON.parse(await fs.readFile(path.join(assets, 'shared/catalog.json'), 'utf8'));
  config = defaults(catalog);
  try {
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'state.json'), 'utf8'));
    config = validate(state.config, catalog);
    phase = state.phase;
    currentEvents = state.currentEvents || '';
    if (currentEvents && !path.resolve(currentEvents).startsWith(path.resolve(stateDir) + path.sep))
      currentEvents = '';
  } catch {
    /* First launch or invalid old state: use safe defaults. */
  }
  window = new BrowserWindow({
    width: 1460,
    height: 850,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  app.on('second-instance', () => {
    window.show();
    window.focus();
  });
  window.on('close', event => {
    if (busy) {
      event.preventDefault();
      void dialog.showMessageBox(window, {
        message: '설치가 실행 중입니다.',
        detail: '현재 단계 후 중지를 누르고 실행 터미널이 끝날 때까지 기다려 주세요.',
      });
    }
  });
  ipcMain.handle('setup-discover', (_event, skill: unknown) =>
    guarded('실행환경 탐색', async () => {
      return setupCommand(['discover', '--skill', setupSkill(skill)]);
    }),
  );
  ipcMain.handle('setup-preview', (_event, request: unknown) =>
    guarded('실행환경 변경 확인', async () => {
      if (!request || typeof request !== 'object' || JSON.stringify(request).length > 65536)
        throw Error('준비 옵션을 확인하세요.');
      setupSkill((request as { skill?: unknown }).skill);
      const plan = await setupCommand(['preview', '--request-stdin'], JSON.stringify(request));
      setupPlans.set(plan.id, setupTarget());
      return plan;
    }),
  );
  ipcMain.handle('setup-execute', (_event, id: unknown, input: unknown = {}) =>
    guarded('스킬 실행환경 준비', async () => {
      if (typeof id !== 'string' || setupPlans.get(id) !== setupTarget())
        throw Error('대상 계정의 준비 내용을 다시 확인하세요.');
      const credentials = blogCredentials(input);
      setupPlans.delete(id);
      const result = (await setupCommand(
        ['execute', '--id', id, '--credentials-stdin'],
        JSON.stringify(credentials),
      )) as SetupResult;
      setupResults.set(id, { target: setupTarget(), result });
      if (inspection?.linux) {
        try {
          inspection.linux.skillReadiness = await setupCommand(['status']);
        } catch {
          inspection.linux.skillReadiness = undefined;
        }
      }
      if (result.status !== 'completed') operation.finish(result.status === 'failed' ? 'failed' : 'waiting');
      return result;
    }),
  );
  ipcMain.handle('setup-artifact', async (_event, id: unknown, index: unknown) => {
    if (typeof id !== 'string' || typeof index !== 'number' || !Number.isInteger(index))
      throw Error('준비 결과를 다시 확인하세요.');
    const saved = setupResults.get(id);
    const artifact = saved?.result.artifacts[index];
    if (
      !saved ||
      saved.target !== setupTarget() ||
      !artifact ||
      !/\.(?:html|json|example)$/.test(artifact.path)
    )
      throw Error('현재 계정의 확인된 준비 결과만 열 수 있습니다.');
    const windowsPath = (
      await capture('wsl.exe', [
        '-d',
        config.distro,
        '-u',
        config.user,
        '--exec',
        'wslpath',
        '-w',
        artifact.path,
      ])
    ).trim();
    const error = await shell.openPath(windowsPath);
    if (error) throw Error('파일을 열지 못했습니다. 표시된 Ubuntu 경로에서 확인하세요.');
  });
  ipcMain.handle('snapshot', snapshot);
  ipcMain.handle('catalog', () => catalog);
  ipcMain.handle('setup-guide', async (_event, skill: unknown) => {
    if (typeof skill !== 'string' || !['blog-draft', 'usage-report', 'storage-maintenance'].includes(skill))
      throw Error('지원하지 않는 초기 설정 가이드입니다.');
    await shell.openExternal(
      `https://github.com/Muring/dev-tools/blob/main/skills/${skill}/references/setup.md`,
    );
  });
  ipcMain.handle('save', async (_event, value) => {
    if (busy) throw Error('설치 중에는 구성을 변경할 수 없습니다.');
    const next = validate(value, catalog);
    if (contentKey(config) !== contentKey(next)) {
      contentPreview = undefined;
      next.contentCommit = '';
    }
    if (config.distro !== next.distro || config.user !== next.user) inspection = undefined;
    if (JSON.stringify(config) !== JSON.stringify(next)) currentEvents = '';
    config = next;
    await persist();
    return snapshot();
  });
  ipcMain.handle('inspect', () => guarded('환경 확인', inspect));
  ipcMain.handle('orca-install', () =>
    guarded('Orca 다운로드 · 설치', async () => {
      const current = (await helper('inspect')) as Inspection;
      if (!current.supported) throw Error('Windows 11 x64에서 실행하세요.');
      if (current.orcaInstalled)
        throw Error('Orca가 이미 설치되어 있습니다. 업데이트는 Orca 앱에서 진행하세요.');
      const installer = await downloadOrca(path.join(stateDir, 'downloads'), fetch, report);
      report({ label: '검증된 Orca 설치 창 열기' });
      const error = await shell.openPath(installer);
      if (error) throw Error(`Orca 설치 창을 열지 못했습니다: ${error}`);
      report({ label: 'Orca 설치 창에서 설치를 마친 뒤 설치 상태를 확인하세요.' });
      operation.finish('waiting');
      return snapshot();
    }),
  );
  ipcMain.handle('content-preview', () => guarded('커맨드 · 스킬 버전 확인', previewContent));
  ipcMain.handle('content-update', () => guarded('커맨드 · 스킬 업데이트', updateContent));
  ipcMain.handle('prepare', () =>
    guarded('WSL 준비', async () => {
      const result = await helper('prepare');
      phase = result.reboot ? 'reboot' : 'inspect';
      await inspect();
      if (result.reboot) {
        report({ label: 'Windows 재부팅 후 다시 실행하세요.' });
        operation.finish('waiting');
      } else if (!inspection?.wslReady) {
        // Prepared without a reboot request, yet --status/--version still fail: do not open the next stage.
        report({ label: 'WSL 준비를 확인하지 못했습니다. 재부팅 후 WSL 준비를 다시 실행하세요.' });
        operation.finish('waiting');
      }
      return { reboot: result.reboot };
    }),
  );
  ipcMain.handle('install', () =>
    guarded('Ubuntu 준비', async () => {
      config = validate(config, catalog);
      const current = (await helper('inspect')) as Inspection;
      const existing = current.distros.find(i => i.name === config.distro);
      if (
        existing &&
        config.installLocation &&
        existing.location.replace(/\\$/, '').toLowerCase() !==
          config.installLocation.replace(/\\$/, '').toLowerCase()
      )
        throw Error('기존 Ubuntu는 자동 이동하지 않습니다. 현재 위치를 사용하세요.');
      if (existing && existing.version !== 2)
        throw Error('WSL1 배포판입니다. 별도 백업 후 WSL2 전환을 진행하세요.');
      const result = await helper('install', { config });
      phase = result.restartWsl ? 'wsl-restart' : 'configure';
      await inspect();
      if (result.restartWsl) {
        report({ label: 'Ubuntu 설정 반영을 위해 WSL 재시작이 필요합니다.' });
        operation.finish('waiting');
      }
      return result;
    }),
  );
  ipcMain.handle('run', (_event, step) => guarded('개발환경 설치', () => run(step)));
  ipcMain.handle('stop', async () => {
    if (currentEvents && busy) await fs.writeFile(currentEvents.replace(/\.jsonl$/, '.stop'), 'stop');
  });
  ipcMain.handle('login', (_event, tool) =>
    guarded('계정 로그인', async () => {
      if (!['gh', 'claude', 'codex'].includes(tool)) throw Error('Unknown login target');
      report({ label: `${tool} 로그인 창 준비` });
      const script = await linuxPath(path.join(assets, 'linux/login.sh'));
      await helper('launch', { config, script, arguments: [tool] });
      await inspect();
      if (!inspection?.linux?.auth[tool]) {
        report({ label: `${tool} 로그인이 확인되지 않았습니다. 로그인 창에서 인증을 완료하세요.` });
        operation.finish('waiting');
      }
      return snapshot();
    }),
  );
  ipcMain.handle('shutdown', () =>
    guarded('WSL 재시작', async () => {
      if (
        await confirm('WSL을 다시 시작할까요?', '실행 중인 모든 WSL 작업이 종료됩니다. 작업을 저장하세요.')
      ) {
        await helper('shutdown');
        phase = 'configure';
        await inspect();
      }
      return snapshot();
    }),
  );
  ipcMain.handle('reboot', () =>
    guarded('Windows 재부팅', async () => {
      if (
        await confirm(
          'Windows를 재부팅할까요?',
          '30초 후 재부팅합니다. 작업을 저장하고, 부팅 후 앱을 다시 열어 주세요.',
        )
      )
        await helper('reboot');
    }),
  );
  ipcMain.handle('logs', async () => {
    await shell.openPath(stateDir);
  });
  await window.loadFile(path.join(__dirname, '../dist/index.html'));
}
void main().catch(error => {
  dialog.showErrorBox('dev-tools', String(error));
  app.quit();
});
app.on('window-all-closed', () => {
  app.quit();
});
