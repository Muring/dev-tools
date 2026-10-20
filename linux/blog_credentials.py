"""Private credential setup; replacement requires explicit per-key approval."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlsplit

KEYS = ('DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY')
LIMIT = 32768


def validate_credentials(value):
    if not isinstance(value, dict) or set(value) - set(KEYS):
        raise ValueError('지원하는 블로그 인증 항목만 입력하세요.')
    for key, entry in value.items():
        if not isinstance(entry, str) or not entry or len(entry) > 8192 or any(c.isspace() or ord(c) < 32 for c in entry) or "'" in entry:
            raise ValueError(key + ': 한 줄 값을 입력하세요. DB 비밀번호의 특수문자는 URL 인코딩하세요.')
        if entry != entry.strip() or any(c in entry for c in '<>[]'):
            raise ValueError(key + ': 예시 대신 실제 값을 입력하세요.')
        if key in ('DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'):
            try:
                url = urlsplit(entry)
                valid = bool(url.hostname) and bool(url.port or url.hostname)
                if key == 'DATABASE_URL':
                    valid = valid and url.scheme in ('postgres', 'postgresql') and bool(url.username and url.password)
                else:
                    valid = valid and url.scheme == 'https' and not (url.username or url.password or url.query or url.fragment) and url.path in ('', '/')
            except ValueError:
                valid = False
            if not valid:
                raise ValueError(key + ': 연결 주소 형식을 확인하세요.')
        elif not (entry.startswith('sb_secret_') or entry.startswith('eyJ')) or any(c.isspace() for c in entry):
            raise ValueError('SUPABASE_SECRET_KEY: 서버용 secret 키를 입력하세요. publishable 키는 사용할 수 없습니다.')
    return value


def read_private(path):
    path = Path(path)
    if path.is_symlink():
        raise ValueError('연결된 환경 파일은 자동 수정하지 않습니다. 일반 파일을 사용하세요.')
    if not path.exists():
        return ''
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'r') as stream:
        stat = os.fstat(stream.fileno())
        if stat.st_size > 1024 * 1024 or stat.st_nlink != 1:
            raise ValueError('환경 파일 크기 또는 링크 상태를 확인하세요.')
        return stream.read()


def assignments(text):
    """Refuse ambiguous/multiline syntax when editing; never return values to UI."""
    result = {}
    for index, line in enumerate(text.splitlines(keepends=True)):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r"""\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^'"\r\n]*?))\s*(?:#.*)?[\r\n]*""", line)
        if not match:
            raise ValueError('기존 .env에 여러 줄 값 또는 지원하지 않는 형식이 있습니다. 원본을 보존했으니 형식을 확인하세요.')
        key = match[1]
        if key in result:
            raise ValueError('기존 .env에 중복 항목이 있습니다. 원본을 보존했으니 중복을 정리하세요.')
        raw = next((group for group in match.groups()[1:] if group is not None), '')
        result[key] = (index, bool(raw.strip()))
    return result


def tracked(path):
    if not path.is_dir():
        return False
    repo = subprocess.run(['git', '-C', str(path), 'rev-parse', '--is-inside-work-tree'],
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
    if repo.returncode == 128:
        return False
    if repo.returncode != 0 or repo.stdout.strip() != b'true':
        raise ValueError('Git 저장소 상태를 확인할 수 없습니다.')
    result = subprocess.run(['git', '-C', str(path), 'ls-files', '--error-unmatch', '--', '.env'],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    if result.returncode not in (0, 1):
        raise ValueError('Git의 .env 추적 상태를 확인할 수 없습니다.')
    return result.returncode == 0


def atomic_text(path, text, mode):
    fd, temp = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(text)
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)


def save_credentials(path, values, replace_keys=()):
    values = validate_credentials(values)
    if not isinstance(replace_keys, (list, tuple)) or any(key not in values for key in replace_keys):
        raise ValueError('교체할 인증 항목을 확인하세요.')
    if not values:
        return
    path = Path(path)
    env_path = path / '.env'
    original = read_private(env_path)
    entries = assignments(original)
    for key in values:
        if entries.get(key, (None, False))[1] and key not in replace_keys:
            raise ValueError(key + ': 기존 값이 있어 덮어쓰지 않았습니다. 입력칸을 비우고 다시 확인하세요.')
    if tracked(path):
        raise ValueError('.env가 Git에 추적되고 있어 저장하지 않았습니다. 추적 상태를 먼저 정리하세요.')
    # Ignore the file before writing any credentials; preserve unrelated ignore rules.
    ignore_path = path / '.gitignore'
    ignored = read_private(ignore_path)
    if '/.env' not in ignored.splitlines():
        atomic_text(ignore_path, ignored + ('' if not ignored or ignored.endswith('\n') else '\n') + '/.env\n', 0o644)
    lines = original.splitlines(keepends=True)
    for key, value in values.items():
        entry = key + "='" + value + "'\n"
        if key in entries:
            lines[entries[key][0]] = entry
        else:
            if lines and not lines[-1].endswith('\n'):
                lines[-1] += '\n'
            lines.append(entry)
    # Catch an external editor changing the file during preparation.
    if read_private(env_path) != original:
        raise ValueError('.env가 변경됐습니다. 새 계획으로 다시 확인하세요.')
    atomic_text(env_path, ''.join(lines), 0o600)
