#!/usr/bin/env python3
"""Prepare selected skill environments using reviewed, target-bound local plans."""
import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid
from skill_readiness import registered_codex_home, probe
from blog_credentials import KEYS as BLOG_KEYS, LIMIT as CREDENTIAL_LIMIT, validate_credentials, read_private, assignments, save_credentials, tracked

SKILLS = ('blog-draft', 'usage-report', 'storage-maintenance')


def read_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    if path.stat().st_size > 1024 * 1024:
        raise ValueError('설정 파일이 너무 큽니다.')
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError('설정 JSON은 객체 형식이어야 합니다.')
    return value


def write_json(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def fingerprint(path):
    path = Path(path)
    if not path.exists():
        return None
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ValueError('대상 설정 파일 형식을 확인하세요.')
    return hashlib.sha256(path.read_bytes()).hexdigest()


def progress(label):
    print('BOOTSTRAP_PROGRESS ' + json.dumps({'label': label}, ensure_ascii=False), file=sys.stderr, flush=True)


class Setup:
    def __init__(self, home=None, runner=None, env=None):
        self.home = Path(home) if home else Path.home()
        self.env = dict(os.environ if env is None else env)
        self.env['CODEX_HOME'] = str(registered_codex_home(self.home, self.env))
        self.state = self.home / '.local/state/dev-bootstrap/skill-setup'
        self.settings_path = self.home / '.config/dev-bootstrap/skill-setup.json'
        self.runner = runner or self.command

    def path(self, value):
        if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(c) < 32 for c in value):
            raise ValueError('Ubuntu의 절대 경로를 입력하세요.')
        if value == '~' or value.startswith('~/'):
            value = str(self.home) + value[1:]
        path = Path(value)
        if not path.is_absolute() or path == Path('/'):
            raise ValueError('루트가 아닌 절대 경로를 지정하세요.')
        return path.resolve()

    def skill(self, name):
        if name not in SKILLS:
            raise ValueError('지원하지 않는 스킬입니다.')
        codex = Path(self.env.get('CODEX_HOME', str(self.home / '.codex')))
        candidates = [codex / 'skills' / name, self.home / '.claude/skills' / name]
        command = self.home / '.claude/commands' / (name + '.md')
        if command.is_file():
            candidates.append(command.resolve().parent)
        for candidate in candidates:
            if (candidate / 'SKILL.md').is_file():
                return candidate.resolve()
        raise ValueError('공용 스킬을 먼저 설치하거나 업데이트하세요: ' + name)

    def discover(self, name):
        self.skill(name)
        saved = read_json(self.settings_path, {}).get(name, {})
        if not isinstance(saved, dict):
            raise ValueError('저장된 스킬 경로 설정을 확인하세요.')
        if name == 'usage-report':
            existing = read_json(self.home / '.config/ai-workflow/tracking.json', {})
            if existing.get('repo'):
                saved = dict(saved, path=existing['repo'])
        existing = read_json(self.home / '.config/ai-workflow/tracking.json', {}) if name == 'usage-report' else {}
        roots = []
        codex = Path(self.env.get('CODEX_HOME', str(self.home / '.codex')))
        claude = Path(self.env.get('CLAUDE_CONFIG_DIR', str(self.home / '.claude')))
        for tool, path in [('Codex', codex / 'sessions'), ('Codex', codex / 'archived_sessions'), ('Claude', claude / 'projects')]:
            roots.append({'tool': tool, 'path': str(path), 'exists': path.is_dir()})
        if name == 'usage-report' and existing.get('roots'):
            roots = [{'tool': entry['tool'], 'path': entry['path'], 'exists': Path(entry['path']).is_dir()} for entry in existing['roots']]
        projects, blogs = [], []
        dev = self.home / 'dev'
        if dev.is_dir():
            for child in sorted(dev.iterdir())[:100]:
                if child.is_dir() and (child / '.git').exists():
                    projects.append({'path': str(child), 'alias': existing.get('projects', {}).get(str(child), existing.get('projects', {}).get(child.name, child.name))})
                    try:
                        if 'draft:post' in read_json(child / 'package.json', {}).get('scripts', {}):
                            blogs.append(str(child))
                    except (OSError, ValueError):
                        pass
        if name == 'usage-report':
            # Include already configured absolute paths even outside ~/dev; keep their names.
            configured = [{'path': path, 'alias': alias} for path, alias in existing.get('projects', {}).items()
                          if isinstance(path, str) and path.startswith('/')]
            known = {item['path'] for item in configured}
            projects = (configured + [item for item in projects if item['path'] not in known])[:100]
        targets = [{'platform': 'linux', 'path': str(p), 'kind': 'directory'} for p in
                   (self.home / '.cache', self.home / '.npm', Path('/tmp')) if p.exists()]
        windows_state = 'not_requested'
        if name == 'storage-maintenance':
            # Existing collector performs bounded, read-only Windows discovery, not a scan.
            directory = self.skill(name) / 'scripts'
            sys.path.insert(0, str(directory))
            try:
                spec = importlib.util.spec_from_file_location('setup_storage', directory / 'storage.py')
                module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
                discovered = module.discovery()
                windows_state = discovered.get('state', 'unknown')
                targets.extend(discovered.get('targets', []))
            except (OSError, ValueError, ImportError, subprocess.SubprocessError):
                windows_state = 'unknown'
            finally:
                sys.path.pop(0)
        preserve = [str(self.home / p) for p in ('dev', '.codex', '.claude', '.local/share')]
        if name == 'storage-maintenance':
            for configured_home in (self.env.get('CODEX_HOME'), self.env.get('CLAUDE_CONFIG_DIR')):
                if isinstance(configured_home, str) and configured_home.startswith('/'):
                    preserve.append(str(self.path(configured_home)))
            config = read_json(self.home / '.config/dev-bootstrap/storage-maintenance.json', {})
            if config.get('targets'):
                targets = config['targets']
            preserve = list(dict.fromkeys([p['path'] for p in config.get('preserve', [])] + preserve))
        return {'skill': name, 'path': saved.get('path', str(self.home / 'dev' / ('mublog' if name == 'blog-draft' else 'muring-kb'))),
                'blogs': blogs, 'roots': roots, 'projects': projects, 'targets': targets, 'windowsDiscovery': windows_state,
                'preserve': preserve,
                'trackingConfig': str(self.home / '.config/ai-workflow/tracking.json'),
                'trackingConfigured': bool(existing), 'publisherConfigured': existing.get('publisher', {}).get('mode') == 'git-workflow'}

    def normalize(self, raw):
        if not isinstance(raw, dict) or raw.get('skill') not in SKILLS:
            raise ValueError('준비할 스킬을 선택하세요.')
        name = raw['skill']
        allowed = {'skill', 'path', 'repository', 'installDependencies', 'draft', 'initialize', 'projects',
                   'sync', 'schedule', 'allowPublish', 'approveTemplate', 'fingerprint', 'targets', 'preserve', 'schedulePlan', 'credentialKeys', 'replaceCredentialKeys'}
        if set(raw) - allowed:
            raise ValueError('알 수 없는 준비 옵션입니다.')
        result = {'skill': name}
        for key in ('installDependencies', 'initialize', 'sync', 'schedule', 'allowPublish', 'approveTemplate', 'schedulePlan'):
            if key in raw and not isinstance(raw[key], bool):
                raise ValueError('잘못된 선택 값입니다.')
            result[key] = raw.get(key, False)
        if name in ('blog-draft', 'usage-report'):
            result['path'] = str(self.path(raw.get('path', '')))
        if name == 'blog-draft':
            repo = raw.get('repository', '')
            if not isinstance(repo, str) or (repo and not re.fullmatch(r'https://github\.com/[\w.-]+/[\w.-]+(?:\.git)?', repo)):
                raise ValueError('인증 정보가 없는 GitHub HTTPS 저장소 주소를 입력하세요.')
            keys = raw.get('credentialKeys', [])
            if not isinstance(keys, list) or any(not isinstance(k, str) or k not in BLOG_KEYS for k in keys) or len(set(keys)) != len(keys):
                raise ValueError('블로그 인증 항목 이름을 확인하세요.')
            result['credentialKeys'] = sorted(keys)
            replace_keys = raw.get('replaceCredentialKeys', [])
            if not isinstance(replace_keys, list) or any(not isinstance(k, str) or k not in keys for k in replace_keys) or len(set(replace_keys)) != len(replace_keys):
                raise ValueError('교체할 인증 항목은 입력할 항목 안에서 선택하세요.')
            result['replaceCredentialKeys'] = sorted(replace_keys)
            result['repository'] = repo
            result['draft'] = str(self.path(raw['draft'])) if raw.get('draft') else ''
        if name == 'usage-report':
            projects = raw.get('projects', {})
            if not isinstance(projects, dict) or len(projects) > 100:
                raise ValueError('프로젝트 매핑은 100개 이하로 지정하세요.')
            result['projects'] = {}
            for path, alias in projects.items():
                if not isinstance(alias, str) or not re.fullmatch(r'[\w.-]+(?:/[\w.-]+)*', alias):
                    raise ValueError('프로젝트 별칭은 영문·숫자·한글과 / . _ - 로 지정하세요.')
                result['projects'][str(self.path(path))] = alias
            value = raw.get('fingerprint', '')
            if not isinstance(value, str) or (value and not re.fullmatch('[a-f0-9]{64}', value)):
                raise ValueError('보고서에서 확인한 fingerprint를 입력하세요.')
            result['fingerprint'] = value
        if name == 'storage-maintenance':
            for key in ('targets', 'preserve'):
                entries = raw.get(key, [])
                if not isinstance(entries, list) or len(entries) > 30:
                    raise ValueError('진단·보존 경로는 각각 30개 이하로 지정하세요.')
                result[key] = []
                for entry in entries:
                    if not isinstance(entry, dict) or entry.get('platform') not in ('linux', 'windows'):
                        raise ValueError('진단 경로의 플랫폼을 확인하세요.')
                    path = entry.get('path', '')
                    if entry['platform'] == 'linux':
                        path = str(self.path(path))
                    elif not isinstance(path, str) or not re.fullmatch(r'[A-Za-z]:\\[^\x00-\x1f<>"|?*]+', path):
                        raise ValueError('Windows 절대 경로를 입력하세요.')
                    result[key].append({'platform': entry['platform'], 'path': path,
                                        **({'kind': entry.get('kind', 'directory')} if key == 'targets' else {})})
                if key == 'targets' and (not result[key] or any(e['kind'] not in ('directory', 'file', 'vhd', 'swap') for e in result[key])):
                    raise ValueError('유효한 진단 대상을 하나 이상 선택하세요.')
        return result

    def make_plan(self, raw):
        request = self.normalize(raw); name = request['skill']; source = self.skill(name)
        config_path = self.home / '.config/ai-workflow/tracking.json'
        storage_path = self.home / '.config/dev-bootstrap/storage-maintenance.json'
        actions, blockers, facts = [], [], {'skill': str(source), 'skillEntry': fingerprint(source / 'SKILL.md'), 'settings': fingerprint(self.settings_path)}
        if name == 'blog-draft':
            path = Path(request['path'])
            facts.update(project=path.exists(), package=fingerprint(path / 'package.json'), lock=fingerprint(path / 'yarn.lock'), blogEnv=fingerprint(path / '.env'))
            if not path.exists():
                if request['repository']:
                    actions.append('지정한 GitHub 저장소를 새 폴더에 clone')
                else:
                    blockers.append('저장소가 없습니다. 기존 경로 또는 clone할 GitHub 주소를 지정하세요.')
            elif 'draft:post' not in read_json(path / 'package.json', {}).get('scripts', {}):
                blockers.append('선택한 폴더에 draft:post 명령이 없습니다. mublog 저장소를 선택하세요.')
            if request['credentialKeys']:
                env_text = read_private(path / '.env')
                entries = assignments(env_text)
                facts['blogEnv'] = fingerprint(path / '.env')
                facts['blogIgnore'] = fingerprint(path / '.gitignore')
                for key in request['credentialKeys']:
                    if entries.get(key, (None, False))[1] and key not in request['replaceCredentialKeys']:
                        blockers.append(key + ': 기존 값이 있습니다. 해당 입력칸을 비우면 기존 값을 유지합니다.')
                for key in request['replaceCredentialKeys']:
                    if self.env.get(key):
                        blockers.append(key + ': 실행환경의 환경변수가 .env보다 우선합니다. 해당 환경변수를 수정하거나 해제한 뒤 다시 실행하세요.')
                if request['replaceCredentialKeys']:
                    actions.append('기존 .env 인증값 교체: ' + ', '.join(request['replaceCredentialKeys']) + ' (나머지 항목 유지)')
                if path.exists() and tracked(path):
                    blockers.append('.env가 Git에 추적되고 있습니다. 추적 상태를 먼저 정리하세요.')
                actions += ['입력한 인증 항목을 ' + str(path / '.env') + '에 저장 (소유자만 읽기·쓰기, 승인한 항목만 교체)',
                            '저장할 항목: ' + ', '.join(request['credentialKeys']), '.gitignore에 /.env 제외 규칙 추가']
            if request['installDependencies']:
                actions.append('선택한 프로젝트의 yarn install 실행 (의존성·설치 스크립트 포함)')
            actions += ['선택한 블로그 경로 저장', '필수 인증 항목의 설정 여부 확인; 비밀값은 표시하지 않음']
            if request['draft']:
                if not Path(request['draft']).is_file():
                    blockers.append('모의 검사할 초안 파일이 없습니다.')
                actions.append('지정한 초안의 dry-run 실행 (DB 읽기 포함, 등록하지 않음)')
            actions.append('DB 접속·SELECT 1 및 Supabase post-images 버킷 정보 조회 (읽기 전용, 글 등록·업로드 없음)')
        elif name == 'usage-report':
            config = read_json(config_path, {})
            facts['tracking'] = fingerprint(config_path)
            if config and config.get('repo') != request['path']:
                blockers.append('기존 추적 설정의 KB 경로를 사용하세요: ' + str(config.get('repo', '미상')))
            facts['tracker'] = fingerprint(source / 'scripts/usage_tracker.py')
            if (request['initialize'] or config) and 'collect-local' not in (source / 'scripts/usage_tracker.py').read_text():
                blockers.append('로컬 전용 수집을 지원하는 최신 공용 스킬로 업데이트하세요.')
            if request['initialize'] and not config:
                if not (Path(request['path']) / '.git').exists() or not (Path(request['path']) / 'templates/usage-report.html').is_file():
                    blockers.append('usage-report 보고서 템플릿을 포함한 기존 KB checkout을 선택하세요.')
                actions.append('KB 원격 fetch 후 usage-data 전용 worktree·새 기기 ID·추적 설정 생성')
            if request['initialize'] or config:
                actions += ['프로젝트별 보고서 표시 이름 저장 (선택하지 않은 기존 설정 보존, 변경 시 백업)', '외부 전송 없는 로컬 수집과 HTML 미리보기 생성']
                for path, alias in request['projects'].items():
                    existing_alias = config.get('projects', {}).get(path, config.get('projects', {}).get(Path(path).name))
                    if existing_alias is not None and existing_alias != alias:
                        actions.append('보고서 표시 이름 변경: ' + path + ' · ' + existing_alias + ' → ' + alias)
            else:
                actions.append('추적 설정 없이 일회성 로컬 집계 JSON 생성')
            publishing = config.get('publisher', {}).get('mode') == 'git-workflow'
            if request['sync'] or request['schedule']:
                if not (config or request['initialize']):
                    blockers.append('동기화·예약 전에 지속 추적을 초기화하세요.')
                if publishing and not request['allowPublish']:
                    blockers.append('기존 설정은 동기화·예약 시 블로그도 발행합니다. 발행 허용을 별도로 선택하세요.')
            if request['sync']:
                actions.append('private usage-data를 Git 원격에 동기화' + ('하고 기존 workflow 발행 실행' if publishing else ''))
            if request['schedule']:
                if not request['approveTemplate']:
                    blockers.append('생성된 HTML을 직접 확인하고 보고서 양식 승인도 별도로 선택하세요.')
                if not request['fingerprint']:
                    blockers.append('먼저 생성한 HTML을 확인한 뒤 fingerprint로 양식 승인을 지정하세요.')
                actions.append('해당 보고서 양식 승인 후 매일 KST 09:00·시작 시 보충 예약 활성화 (원격 동기화 포함)')
                if publishing:
                    actions.append('예약 실행 때 기존 설정에 따라 블로그 workflow 발행')
        else:
            facts['storage'] = fingerprint(storage_path)
            facts['storageScript'] = fingerprint(source / 'scripts/storage.py')
            for target in request['targets']:
                issue = self.storage_target_issue(target)
                if issue:
                    blockers.append(target['path'] + ': ' + issue)
            actions = ['진단 대상·보존 정책 설정 저장 (기존 파일은 변경 시 백업)',
                       '선택한 정확한 경로를 읽기 전용으로 진단하고 스냅샷 생성']
            if request['schedulePlan']:
                actions.append('주간 읽기 전용 진단 예약안 생성 (OS 등록·활성화는 하지 않음)')
        value = {'request': request, 'actions': actions, 'blockers': blockers, 'facts': facts}
        value['digest'] = digest(value)
        return value

    def storage_target_issue(self, entry):
        path = entry['path']
        if entry['platform'] == 'linux':
            target = Path(path)
            if not target.exists():
                return '경로가 없습니다'
            if (entry['kind'] == 'directory') != target.is_dir():
                return '선택한 대상 종류와 실제 경로가 다릅니다'
            if not os.access(target, os.R_OK | (os.X_OK if target.is_dir() else 0)):
                return '읽기 접근 권한이 없습니다'
            return None
        # User paths are data, never interpolated into PowerShell source.
        payload = base64.b64encode(json.dumps(entry).encode()).decode()
        script = "$ErrorActionPreference='Stop'; try { $r=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + payload + "')) | ConvertFrom-Json; $i=Get-Item -LiteralPath $r.path -Force; if (($r.kind -eq 'directory') -ne [bool]$i.PSIsContainer) { throw 'kind' }; if ($i.PSIsContainer) { Get-ChildItem -LiteralPath $r.path -Force -ErrorAction Stop | Select-Object -First 1 | Out-Null }; @{ok=$true} | ConvertTo-Json -Compress } catch { @{ok=$false} | ConvertTo-Json -Compress }"
        try:
            output = self.runner(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                                  base64.b64encode(script.encode('utf-16-le')).decode()], timeout=20)
            if json.loads(output).get('ok') is True:
                return None
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
            pass
        return 'Windows 경로의 존재·종류·접근 상태를 확인하지 못했습니다'

    def preview(self, raw):
        value = self.make_plan(raw); identity = uuid.uuid4().hex
        value.update(id=identity, createdAt=time.time())
        write_json(self.state / identity / 'plan.json', value)
        return value

    def command(self, argv, cwd=None, timeout=600):
        # Never persist raw child output: tools may print credential-bearing errors.
        with tempfile.TemporaryFile() as output:
            env = dict(self.env, GIT_TERMINAL_PROMPT='0', COREPACK_ENABLE_DOWNLOAD_PROMPT='0')
            if shutil.which(argv[0], path=env.get('PATH')) is None:
                raise RuntimeError('필요한 실행 도구가 없습니다: ' + Path(argv[0]).name + '. 개발 도구 설치 상태를 확인하세요.')
            child = subprocess.Popen(argv, cwd=cwd, env=env, stdout=output, stderr=subprocess.DEVNULL,
                                     stdin=subprocess.DEVNULL, start_new_session=True)
            try:
                child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait()
                raise RuntimeError('실행 시간이 초과됐습니다. 연결·인증 상태를 확인하고 재시도하세요.')
            if child.returncode:
                raise RuntimeError(f'명령이 종료 코드 {child.returncode}로 실패했습니다. 해당 도구의 터미널에서 상태를 확인하세요.')
            output.seek(0, 2)
            if output.tell() > 4 * 1024 * 1024:
                raise RuntimeError('결과가 너무 큽니다. 대상 범위를 줄여 재시도하세요.')
            output.seek(0)
            return output.read().decode('utf-8', errors='replace')

    def execute(self, identity, credentials=None):
        credentials = validate_credentials({} if credentials is None else credentials)
        if not isinstance(identity, str) or not re.fullmatch('[a-f0-9]{32}', identity):
            raise ValueError('준비 계획을 다시 확인하세요.')
        directory = self.state / identity
        plan = read_json(directory / 'plan.json')
        if not plan or time.time() - plan['createdAt'] > 3600:
            raise ValueError('준비 계획이 만료됐습니다. 다시 확인하세요.')
        if set(credentials) != set(plan['request'].get('credentialKeys', [])):
            raise ValueError('확인한 인증 항목과 입력값이 다릅니다. 다시 입력하고 변경 내용을 확인하세요.')
        if plan['blockers']:
            raise ValueError('준비 계획의 대기 사유를 먼저 해결하세요.')
        self.state.mkdir(parents=True, exist_ok=True)
        with (self.state / 'setup.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError('다른 실행환경 준비가 진행 중입니다.')
            if read_json(directory / 'result.json') is not None:
                raise ValueError('실행한 계획입니다. 상태를 다시 확인하고 새 계획으로 재시도하세요.')
            if self.make_plan(plan['request'])['digest'] != plan['digest']:
                raise ValueError('대상이나 설정이 변경됐습니다. 준비 내용을 다시 확인하세요.')
            result = {'id': identity, 'skill': plan['request']['skill'], 'status': 'running', 'steps': [], 'artifacts': []}
            write_json(directory / 'result.json', result)
            def step(label, work):
                progress(label)
                entry = {'label': label, 'status': 'running'}; result['steps'].append(entry)
                write_json(directory / 'result.json', result)
                try:
                    value = work()
                    entry['status'] = 'completed'
                    return value
                except Exception:
                    entry['status'] = 'failed'
                    raise
                finally:
                    write_json(directory / 'result.json', result)
            try:
                request = plan['request']
                if request['skill'] == 'blog-draft':
                    self.blog(request, result, step, directory, credentials)
                elif request['skill'] == 'usage-report':
                    self.usage(request, result, step, directory)
                else:
                    self.storage(request, result, step, directory)
                result['status'] = result.get('outcome', 'completed')
            except (OSError, ValueError, RuntimeError, TypeError, KeyError, AttributeError, subprocess.SubprocessError) as error:
                result['status'] = 'failed'
                # Only controlled errors; JSON decoder details and subprocess output are not exposed.
                result['message'] = str(error) if isinstance(error, RuntimeError) else '경로·설정 또는 접근 권한을 확인하고 새 계획으로 재시도하세요.'
            result['finishedAt'] = datetime.now(timezone.utc).isoformat()
            write_json(directory / 'result.json', result)
            return result

    def save_settings(self, name, values):
        current = read_json(self.settings_path, {})
        current[name] = dict(current.get(name, {}), **values)
        write_json(self.settings_path, current)

    def update_config(self, path, value):
        old = read_json(path, {})
        if old == value:
            return
        if path.is_symlink():
            raise RuntimeError('설정 파일이 링크입니다. 원본을 확인한 뒤 직접 설정하세요.')
        if path.exists():
            backup = path.with_name(path.name + '.bak.' + uuid.uuid4().hex)
            shutil.copyfile(path, backup)
            backup.chmod(0o600)
        write_json(path, value)

    def blog(self, request, result, step, directory, credentials=None):
        path = Path(request['path'])
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            step('블로그 저장소 다운로드', lambda: self.runner(['git', 'clone', '--', request['repository'], str(path)]))
        if 'draft:post' not in read_json(path / 'package.json', {}).get('scripts', {}):
            raise RuntimeError('선택한 저장소에 draft:post 명령이 없습니다.')
        if request['installDependencies']:
            step('블로그 의존성 설치', lambda: self.runner(['corepack', 'yarn', 'install'], cwd=path))
        if credentials:
            step('블로그 .env 인증 항목 저장', lambda: save_credentials(path, credentials, request['replaceCredentialKeys']))
        step('블로그 경로 저장', lambda: self.save_settings('blog-draft', {'path': str(path)}))
        # Only names and booleans leave this process, never values or raw .env text.
        configured = {key: bool(self.env.get(key)) for key in ('DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY')}
        env_file = path / '.env'
        if env_file.is_file():
            if env_file.stat().st_size > 1024 * 1024:
                raise RuntimeError('환경 파일 크기를 확인하세요.')
            for line in env_file.read_text().splitlines():
                match = re.match(r'^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$', line)
                if match and match[1] in configured:
                    configured[match[1]] = configured[match[1]] or bool(match[2].strip('\"\''))
        result['checks'] = [{'label': key + ' 값 설정', 'status': 'configured' if present else 'missing'} for key, present in configured.items()]
        template = directory / 'blog.env.example'
        template.write_text('# 승인된 비밀 저장소에서 값을 받아 블로그의 .env에 직접 설정하세요.\n' + '\n'.join(key + '=' for key in configured) + '\n')
        result['artifacts'].append({'label': '환경변수 이름 템플릿', 'path': str(template)})
        def check_connections():
            try:
                value = json.loads(self.runner(['node', str(Path(__file__).with_name('blog_connection.mjs'))], cwd=path, timeout=30))
                checks = value.get('checks', [])
                if not isinstance(checks, list) or not all(isinstance(item, dict) for item in checks):
                    raise ValueError('invalid checks')
                connections = [item for item in checks if item.get('label') in ('DB 연결·읽기', '이미지 버킷 접근')]
                if len(connections) != 2:
                    raise ValueError('missing checks')
                return connections
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                return [{'label': label, 'status': 'failed', 'message': '검사 도구를 실행하지 못했습니다. Node.js·블로그 패키지 설치와 환경 파일을 확인하세요. 응답 시간 초과일 수도 있습니다.'}
                        for label in ('DB 연결·읽기', '이미지 버킷 접근')]
        connections = step('DB·이미지 버킷 읽기 전용 연결 검사', check_connections)
        result['checks'].extend(connections)
        if request['draft']:
            step('DB 읽기 연결·초안 모의 검사', lambda: self.runner(['corepack', 'yarn', 'draft:post', request['draft'], '--dry-run'], cwd=path))
        if all(check.get('status') == 'connected' for check in connections):
            result['message'] = '블로그 설정과 DB 연결·이미지 버킷 조회를 확인했습니다. 글 등록·이미지 업로드 권한은 검사하지 않았습니다.'
        else:
            result['outcome'] = 'waiting'
            result['message'] = '블로그 설정은 저장했습니다. 연결 검사에서 확인할 항목이 있습니다. 아래 항목별 안내를 확인한 뒤 다시 실행하세요.'

    def usage(self, request, result, step, directory):
        scripts = self.skill('usage-report') / 'scripts'
        config_path = self.home / '.config/ai-workflow/tracking.json'
        cli = [sys.executable, str(scripts / 'usage_tracker.py'), '--config', str(config_path)]
        if request['initialize'] and not config_path.exists():
            step('기기별 추적 설정 초기화', lambda: self.runner(cli + ['init', '--repo', request['path']]))
        if not config_path.exists():
            output = step('일회성 로컬 사용량 집계', lambda: self.runner([sys.executable, str(scripts / 'usage_report.py'), '--week', '--by', 'project,tool', '--json']))
            data = json.loads(output)
            report = directory / 'usage-report.json'; write_json(report, data)
            result['artifacts'].append({'label': '로컬 집계 결과', 'path': str(report)})
            result['message'] = '로컬 집계를 생성했습니다. 누락·경고를 보고서에서 확인하세요. 지속 추적·동기화·예약은 활성화하지 않았습니다.'
            return
        config = read_json(config_path)
        # Reject configuration drift that could enable publication after the approved preview.
        publishing = config.get('publisher', {}).get('mode') == 'git-workflow'
        if publishing and (request['sync'] or request['schedule']) and not request['allowPublish']:
            raise RuntimeError('블로그 발행 승인이 필요합니다. 새 계획에서 별도로 선택하세요.')
        if request['projects']:
            config['projects'] = dict(config.get('projects', {}), **request['projects'])
            step('프로젝트 표시 이름 저장·설정 백업', lambda: self.update_config(config_path, config))
        # A separate CLI mode guarantees no sync/publication even for configured publishers.
        if 'collect-local' not in (scripts / 'usage_tracker.py').read_text():
            raise RuntimeError('로컬 전용 수집을 지원하는 최신 공용 스킬로 업데이트하세요.')
        collected = json.loads(step('외부 전송 없는 첫 로컬 수집', lambda: self.runner(cli + ['collect-local'])))
        if collected.get('state') not in ('ok',):
            result['outcome'] = 'waiting'
            result['message'] = '수집 결과에 확인할 경고가 있습니다. 보고서를 검토하세요.'
        preview = json.loads(step('보고서 미리보기 생성', lambda: self.runner(cli + ['report', '--preview'])))
        result['artifacts'].append({'label': '사용량 HTML 미리보기', 'path': preview['path']})
        result['fingerprint'] = preview['fingerprint']
        if result.get('outcome') == 'waiting':
            result['message'] = '수집 경고를 먼저 확인하세요. 보고서는 생성했으며 선택한 동기화·예약은 실행하지 않았습니다.'
            return
        if request['sync']:
            synced = json.loads(step('선택한 원격 동기화·발행', lambda: self.runner(cli + ['sync'])))
            # Receipt is interpreted by the existing publisher; queue acceptance alone is not success.
            if publishing:
                result['outcome'] = 'waiting'
                result['message'] = '동기화를 실행했습니다. 블로그 반영 완료는 발행 상태와 receipt로 확인하세요.'
            elif synced.get('state') == 'failed':
                raise RuntimeError('동기화 결과를 확인하세요.')
        if request['schedule']:
            if request['fingerprint'] != preview['fingerprint']:
                raise RuntimeError('보고서 양식이 변경됐습니다. 생성된 HTML을 확인한 후 다시 승인하세요.')
            step('확인한 보고서 양식 승인', lambda: self.runner(cli + ['approve', '--fingerprint', request['fingerprint']]))
            step('일일 수집·동기화 예약 활성화', lambda: self.runner(cli + ['schedule', '--enable']))
            step('예약 활성 상태 검증', lambda: self.runner(['systemctl', '--user', 'is-active', 'ai-usage.timer']))
            step('로그인 후 예약 유지 상태 검증', lambda: self.runner(['systemctl', '--user', 'is-enabled', 'ai-usage.timer']))
        step('사용량 준비 경로 저장', lambda: self.save_settings('usage-report', {'path': config['repo']}))

    def storage(self, request, result, step, directory):
        path = self.home / '.config/dev-bootstrap/storage-maintenance.json'
        config = read_json(path, {'version': 1, 'timeout_seconds': 15, 'low_free_gib': 20, 'growth_gib': 5,
                                  'cleanup_roots': [], 'candidates': []})
        kept = {(p['platform'], p['path']): p for p in config.get('preserve', [])}
        kept.update({(p['platform'], p['path']): p for p in request['preserve']})
        config.update(targets=request['targets'], preserve=list(kept.values()))
        step('진단 대상·보존 정책 저장', lambda: self.update_config(path, config))
        cli = [sys.executable, str(self.skill('storage-maintenance') / 'scripts/storage.py')]
        measured = json.loads(step('선택한 경로 읽기 전용 진단', lambda: self.runner(cli + ['scan', '--config', str(path)], timeout=1200)))
        result['artifacts'].append({'label': '진단 결과 (JSON)', 'path': measured['snapshot']})
        if measured.get('state') != 'complete':
            result['outcome'] = 'waiting'
            result['message'] = '일부 경로를 확인하지 못했습니다. 스냅샷의 부분 측정·권한·시간 초과를 확인하세요.'
        if request['schedulePlan']:
            value = json.loads(step('주간 진단 예약안 생성', lambda: self.runner(cli + ['schedule-plan', '--period', 'week', '--config', str(path)])))
            output = directory / 'storage-schedule-plan.json'; write_json(output, value)
            result['artifacts'].append({'label': '주간 진단 예약안 (미등록)', 'path': str(output)})
        step('저장공간 준비 경로 저장', lambda: self.save_settings('storage-maintenance', {'config': str(path)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    sub.add_parser('discover').add_argument('--skill', choices=SKILLS, required=True)
    preview = sub.add_parser('preview').add_mutually_exclusive_group(required=True)
    preview.add_argument('--request')
    preview.add_argument('--request-stdin', action='store_true')
    execute = sub.add_parser('execute')
    execute.add_argument('--id', required=True)
    execute.add_argument('--credentials-stdin', action='store_true')
    sub.add_parser('status')
    args = parser.parse_args()
    try:
        setup = Setup()
        if args.mode == 'status':
            result = probe(setup.home, setup.env)
        elif args.mode == 'discover':
            result = setup.discover(args.skill)
        elif args.mode == 'preview':
            if args.request_stdin:
                payload = sys.stdin.buffer.read(65537)
                if len(payload) > 65536:
                    raise ValueError('준비 입력 크기를 확인하세요.')
                request = json.loads(payload)
            else:
                request = read_json(args.request)
            result = setup.preview(request)
        else:
            credentials = {}
            if args.credentials_stdin:
                payload = sys.stdin.buffer.read(CREDENTIAL_LIMIT + 1)
                if len(payload) > CREDENTIAL_LIMIT:
                    raise ValueError('인증 입력 크기를 확인하세요.')
                credentials = validate_credentials(json.loads(payload))
            result = setup.execute(args.id, credentials)
        print(json.dumps(result, ensure_ascii=False))
        return 1 if result.get('status') == 'failed' else 0
    except (OSError, ValueError, RuntimeError, TypeError, KeyError, AttributeError) as error:
        print(json.dumps({'error': str(error) if isinstance(error, (ValueError, RuntimeError)) and not isinstance(error, json.JSONDecodeError) else '파일·경로·권한을 확인하세요.'}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())
