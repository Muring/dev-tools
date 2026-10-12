"""Download versioned command/skill data, never executable installer updates."""
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPO = 'Muring/dev-tools'
GROUPS = ('claude-skill', 'claude-commands', 'codex-skills')
SHA = re.compile(r'^[0-9a-f]{40}$')
NAME = re.compile(r'^[a-z0-9][a-z0-9-]*$')


def blob_hash(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


def inventory(tree):
    if tree.get('truncated'):
        raise ValueError('GitHub 파일 목록이 잘렸습니다. 업데이트하지 않았습니다.')
    files = []
    seen = set()
    for item in tree['tree']:
        name = item.get('path', '')
        if not name.startswith(('commands/', 'skills/')):
            continue
        parts = PurePosixPath(name).parts
        if name != '/'.join(parts) or any(p in ('.', '..', '.git') for p in parts) or '\\' in name or any(ord(c) < 32 for c in name):
            raise ValueError('허용되지 않은 콘텐츠 경로')
        if item.get('type') == 'tree':
            continue
        if item.get('type') != 'blob' or item.get('mode') not in ('100644', '100755', '120000'):
            raise ValueError(f'지원하지 않는 콘텐츠 항목: {name}')
        if name in seen or not SHA.fullmatch(item.get('sha', '')):
            raise ValueError('중복 경로 또는 잘못된 Git 파일 해시')
        seen.add(name)
        size = item.get('size', -1)
        if not isinstance(size, int) or not 0 <= size <= 1024 * 1024:
            raise ValueError('콘텐츠 파일은 1 MiB 이하여야 합니다.')
        files.append({key: item[key] for key in ('path', 'mode', 'sha', 'size')})
    if not files or len(files) > 500 or sum(f['size'] for f in files) > 20 * 1024 * 1024:
        raise ValueError('콘텐츠 파일 목록 또는 전체 크기를 확인하세요.')
    paths = {item['path'] for item in files}
    for name in paths:
        if any(str(parent) in paths for parent in PurePosixPath(name).parents):
            raise ValueError('파일과 디렉터리 경로가 충돌합니다.')
    commands = sorted(PurePosixPath(p).stem for p in paths if re.fullmatch(r'commands/[^/]+\.md', p))
    skills = sorted(PurePosixPath(p).parts[1] for p in paths if re.fullmatch(r'skills/[^/]+/SKILL\.md', p))
    if not commands or not skills or any(not NAME.fullmatch(n) for n in commands + skills):
        raise ValueError('커맨드·스킬 이름을 확인하세요.')
    modes = {f['path']: f['mode'] for f in files}
    for name in commands:
        if modes.get(f'commands/{name}.md') != '120000' or modes.get(f'skills/{name}/SKILL.md') not in ('100644', '100755'):
            raise ValueError(f'{name}: 일반 SKILL.md 원본과 상대 commands 링크가 필요합니다.')
    return sorted(files, key=lambda f: f['path']), commands, skills


class GitHub:
    def json(self, suffix):
        request = Request(f'https://api.github.com/repos/{REPO}/{suffix}', headers={
            'Accept': 'application/vnd.github+json', 'User-Agent': 'dev-bootstrap-content/1',
            'X-GitHub-Api-Version': '2022-11-28'})
        try:
            with urlopen(request, timeout=30) as response:
                data = response.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError('GitHub 응답이 너무 큽니다.')
            return json.loads(data)
        except HTTPError as error:
            raise ValueError(f'GitHub 다운로드 실패 (HTTP {error.code}). 네트워크 또는 API 호출 한도를 확인하고 다시 시도하세요.') from error
        except (URLError, TimeoutError) as error:
            raise ValueError('GitHub에 연결할 수 없습니다. 기존 설치는 유지됩니다.') from error

    def resolve(self, commit=''):
        if commit and not SHA.fullmatch(commit):
            raise ValueError('커밋은 40자리 Git SHA여야 합니다.')
        data = self.json('commits/' + (commit or 'main'))
        sha = data['sha']
        if not SHA.fullmatch(sha) or (commit and commit != sha):
            raise ValueError('GitHub 커밋이 요청과 다릅니다.')
        tree_sha = data['commit']['tree']['sha']
        if not SHA.fullmatch(tree_sha):
            raise ValueError('잘못된 Git tree 해시')
        files, commands, skills = inventory(self.json(f'git/trees/{tree_sha}?recursive=1'))
        return dict(version=1, repository=REPO, commit=sha,
                    message=data['commit']['message'].splitlines()[0],
                    date=data['commit']['committer']['date'], files=files, commands=commands, skills=skills)

    def blob(self, item):
        data = self.json('git/blobs/' + item['sha'])
        if data.get('encoding') != 'base64':
            raise ValueError('지원하지 않는 GitHub 파일 인코딩')
        content = base64.b64decode(data['content'].replace('\n', ''), validate=True)
        if len(content) != item['size'] or blob_hash(content) != item['sha']:
            raise ValueError(f'Git 파일 검증 실패: {item["path"]}')
        return content


def validate_frontmatter(path, name):
    text = path.read_text(encoding='utf-8')
    if not text.startswith('---\n') or '\n---\n' not in text[4:]:
        raise ValueError(f'name과 description frontmatter가 필요합니다: {name}')
    header = text[4:].split('\n---\n', 1)[0]
    values = dict(re.findall(r'^(name|description):\s*([^\n]+)$', header, re.M))
    if values.get('name', '').strip('"\'') != name or not values.get('description', '').strip('"\' '):
        raise ValueError(f'잘못된 커맨드·스킬 frontmatter: {name}')


def verify_release(root, metadata):
    expected = {i['path'] for i in metadata['files']}
    actual = {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() or p.is_symlink()}
    if actual != expected | {'.release.json'}:
        raise ValueError('설치한 콘텐츠 파일 목록이 변경되었습니다. 기존 파일을 보존하고 중단합니다.')
    for item in metadata['files']:
        path = root / item['path']
        if item['mode'] == '120000':
            match = re.fullmatch(r'commands/([a-z0-9-]+)\.md', item['path'])
            if not match or not path.is_symlink() or os.readlink(path) != f'../skills/{match[1]}/SKILL.md':
                raise ValueError(f'허용되지 않은 스킬 링크: {item["path"]}')
            content = os.readlink(path).encode()
            if not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
                raise ValueError('스킬 링크가 다운로드한 원본을 가리키지 않습니다.')
        else:
            if path.is_symlink() or not path.is_file():
                raise ValueError('콘텐츠 파일 형식이 변경되었습니다.')
            content = path.read_bytes()
        if len(content) != item['size'] or blob_hash(content) != item['sha']:
            raise ValueError(f'콘텐츠가 변경되었습니다. 파일을 보존하고 중단합니다: {path}')
    for name in metadata['commands']:
        validate_frontmatter(root / f'commands/{name}.md', name)
        if (root / f'skills/{name}/SKILL.md').resolve() != (root / f'commands/{name}.md').resolve():
            raise ValueError('공용 명령의 원본이 일치하지 않습니다.')
    for name in metadata['skills']:
        validate_frontmatter(root / f'skills/{name}/SKILL.md', name)


class ContentStore:
    def __init__(self, home=None, codex_home=None, client=None, progress=None):
        self.progress = progress or (lambda **event: None)
        self.home = Path(home) if home else Path.home()
        self.root = self.home / '.local/share/dev-bootstrap/content'
        self.explicit_codex_home = bool(codex_home or os.environ.get('CODEX_HOME'))
        self.codex_home = Path(codex_home or os.environ.get('CODEX_HOME', str(self.home / '.codex'))).expanduser().absolute()
        self.client = client or GitHub()

    def state(self):
        path = self.root / 'state.json'
        state = json.loads(path.read_text()) if path.exists() else {}
        if not self.explicit_codex_home and state.get('codexHome'):
            self.codex_home = Path(state['codexHome'])
        return state

    def preview(self, commit=''):
        self.progress(label='GitHub 커밋과 커맨드·스킬 파일 목록 확인')
        meta = self.client.resolve(commit)
        self.progress(label='현재 설치와 원격 파일 변경 비교')
        old = self.state()
        before = {f['path']: (f['sha'], f['mode']) for f in old.get('files', [])}
        after = {f['path']: (f['sha'], f['mode']) for f in meta['files']}
        return {**meta, 'installedCommit': old.get('commit', ''),
                'changes': [{'path': p, 'status': 'added' if p not in before else 'removed' if p not in after else 'modified'}
                            for p in sorted(before.keys() | after.keys()) if before.get(p) != after.get(p)]}

    @contextmanager
    def locked(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / 'lock').open('w') as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError('다른 커맨드·스킬 업데이트가 실행 중입니다.')
            self.recover()
            yield

    def targets(self, meta, groups):
        result = {}
        current = self.root / 'current'
        if 'claude-commands' in groups:
            result[str(self.home / '.claude/commands')] = str(current / 'commands')
        for group, directory in [('claude-skill', self.home / '.claude/skills'), ('codex-skills', self.codex_home / 'skills')]:
            if group in groups:
                for name in meta['skills']:
                    result[str(directory / name)] = str(current / 'skills' / name)
        return result

    def owned(self, path, state):
        if not path.is_symlink():
            return False
        link = os.readlink(path)
        if state.get('links', {}).get(str(path)) == link:
            return True
        # Migrate only known links from the bundled 0.1.0 installer.
        legacy = self.home / '.local/share/dev-bootstrap/runtime'
        allowed = {self.home / '.claude/commands': legacy / 'commands',
                   self.home / '.claude/skills/dev-setup': legacy / 'skills/dev-setup'}
        return path in allowed and path.resolve() == allowed[path].resolve()

    def stage(self, meta):
        release = self.root / 'releases' / meta['commit']
        if release.exists():
            self.progress(label='기존 다운로드 파일 검증')
            verify_release(release, meta)
            return release
        release.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.download-', dir=release.parent) as temporary:
            staging = Path(temporary)
            for index, item in enumerate(meta['files']):
                self.progress(label='커맨드·스킬 다운로드 및 해시 검증', completed=index, total=len(meta['files']), unit='items')
                content = self.client.blob(item)
                # Also verify injected/download adapters, not just GitHub's implementation.
                if len(content) != item['size'] or blob_hash(content) != item['sha']:
                    raise ValueError('다운로드한 파일의 Git 해시가 다릅니다.')
                path = staging / item['path']
                path.parent.mkdir(parents=True, exist_ok=True)
                if item['mode'] == '120000':
                    expected = f'../skills/{path.stem}/SKILL.md'
                    if item['path'] != f'commands/{path.stem}.md' or content.decode() != expected:
                        raise ValueError('허용되지 않은 원격 심볼릭 링크')
                    path.symlink_to(expected)
                else:
                    path.write_bytes(content)
                    path.chmod(0o755 if item['mode'] == '100755' else 0o644)
            self.progress(label='커맨드·스킬 다운로드 및 해시 검증', completed=len(meta['files']), total=len(meta['files']), unit='items')
            atomic_json(staging / '.release.json', meta)
            verify_release(staging, meta)
            staging.rename(release)
        return release

    @staticmethod
    def link(path, target):
        path = Path(path)
        if path.exists() and not path.is_symlink():
            raise ValueError(f'기존 파일·디렉터리를 보존했습니다: {path}')
        if target is None:
            path.unlink(missing_ok=True)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + '.bootstrap-link')
        if temp.exists() or temp.is_symlink():
            raise ValueError(f'임시 경로가 이미 있습니다: {temp}')
        temp.symlink_to(target)
        try:
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)

    def recover(self):
        journal = self.root / 'pending.json'
        if not journal.exists():
            return
        transaction = json.loads(journal.read_text())
        for entry in reversed(transaction['changes']):
            path = Path(entry['path'])
            actual = os.readlink(path) if path.is_symlink() else None
            if (path.exists() and not path.is_symlink()) or actual not in (entry['before'], entry['after']):
                raise ValueError(f'업데이트 복구 중 경로 충돌: {path}. 백업을 확인하세요.')
            self.link(path, entry['before'])
        if transaction['state']:
            atomic_json(self.root / 'state.json', transaction['state'])
        else:
            (self.root / 'state.json').unlink(missing_ok=True)
        journal.unlink()

    def check(self, group, commit=''):
        state = self.state()
        if (self.root / 'pending.json').exists() or not state or (commit and state['commit'] != commit):
            return False
        current = self.root / 'current'
        release = self.root / 'releases' / state['commit']
        if not current.is_symlink() or current.resolve() != release.resolve():
            return False
        verify_release(release, state)
        for path, target in self.targets(state, [group]).items():
            link = Path(path)
            if not link.is_symlink() or os.readlink(link) != target or not link.exists():
                return False
        return True

    def apply(self, commit, groups):
        if not SHA.fullmatch(commit) or not groups or any(group not in GROUPS for group in groups):
            raise ValueError('검토한 커밋 SHA와 설치 대상이 필요합니다.')
        self.progress(label='업데이트 잠금 및 이전 작업 복구 확인')
        with self.locked():
            old = self.state()
            self.progress(label='적용할 커밋과 기존 경로 충돌 확인')
            if old.get('commit') == commit:
                meta = {key: old[key] for key in ('version', 'repository', 'commit', 'message', 'date', 'files', 'commands', 'skills')}
            else:
                meta = self.client.resolve(commit)
            all_groups = sorted(set(old.get('groups', [])) | set(groups))
            desired = self.targets(meta, all_groups)
            changes = []
            for raw in sorted(desired.keys() | old.get('links', {}).keys()):
                path = Path(raw)
                before = os.readlink(path) if path.is_symlink() else None
                after = desired.get(raw)
                if path.exists() or path.is_symlink():
                    if not self.owned(path, old):
                        raise ValueError(f'기존 연결·파일을 보존했습니다: {path}. 내용을 확인하고 경로를 정리한 뒤 다시 시도하세요.')
                if before != after:
                    changes.append(dict(path=raw, before=before, after=after))
            release = self.stage(meta)
            current = self.root / 'current'
            before = os.readlink(current) if current.is_symlink() else None
            if current.exists() and not current.is_symlink():
                raise ValueError('콘텐츠 current 경로 충돌')
            if before and (not old or current.resolve() != (self.root / 'releases' / old['commit']).resolve()):
                raise ValueError('관리하지 않는 콘텐츠 current 링크입니다.')
            if old.get('commit') == commit and not changes and before == str(release):
                return old
            backup = self.root / 'backups' / str(time.time_ns())
            self.progress(label='이전 콘텐츠와 연결 백업')
            backup.mkdir(parents=True)
            if old and current.exists():
                shutil.copytree(current.resolve(), backup / 'content', symlinks=True)
            for index, entry in enumerate(changes):
                original = Path(entry['path'])
                if entry['before'] and str(original) not in old.get('links', {}) and original.is_dir():
                    shutil.copytree(original.resolve(), backup / f'legacy-{index}', symlinks=True)
            if before != str(release):
                changes.append(dict(path=str(current), before=before, after=str(release)))
            transaction = dict(state=old, changes=changes)
            atomic_json(backup / 'transaction.json', transaction)
            atomic_json(self.root / 'pending.json', transaction)
            try:
                self.progress(label='콘텐츠 적용 및 Claude·Codex 연결 검증')
                for entry in changes:
                    self.link(entry['path'], entry['after'])
                new = {**meta, 'groups': all_groups, 'links': desired, 'backup': str(backup), 'codexHome': str(self.codex_home)}
                atomic_json(self.root / 'state.json', new)
                for group in all_groups:
                    # pending journal remains until all files and target links are verified.
                    for path, target in self.targets(meta, [group]).items():
                        if not Path(path).exists() or os.readlink(path) != target:
                            raise ValueError('공용 원본 연결 검증 실패')
                (self.root / 'pending.json').unlink()
                return new
            except BaseException:
                self.progress(label='실패한 업데이트의 이전 연결 복구')
                self.recover()
                raise
