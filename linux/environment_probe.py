#!/usr/bin/env python3
"""Read-only inspection. Authentication output never leaves this process."""
import json
import sys
from pathlib import Path
import pwd
import subprocess
from lib.content import ContentStore
from skill_readiness import probe


def output(args):
    try:
        result = subprocess.run(args, text=True, capture_output=True, timeout=15)
        return result.stdout.strip() if result.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''


def succeeds(args):
    try:
        return subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


count = 0
TOTAL = 13

def report(label):
    global count
    print('BOOTSTRAP_PROGRESS ' + json.dumps(dict(label=label, completed=count, total=TOTAL, unit='items'), ensure_ascii=False), file=sys.stderr, flush=True)
    count += 1

report('Ubuntu 사용자와 콘텐츠 설치 상태 확인')
home = Path.home()
try:
    content_commit = ContentStore().state().get('commit', '')
except (ValueError, OSError):
    content_commit = ''
report('GitHub 로그인 상태 확인')
auth = {'gh': succeeds(['gh', 'auth', 'status', '--hostname', 'github.com'])}
report('Codex 로그인 상태 확인')
auth['codex'] = succeeds(['codex', 'login', 'status'])
report('Claude 로그인 상태 확인')
try:
    result = json.loads(output(['claude', 'auth', 'status']))
    auth['claude'] = result.get('loggedIn') is True
except (OSError, ValueError, subprocess.TimeoutExpired):
    auth['claude'] = False
report('Ubuntu 버전과 사용자 설정 확인')
os_id = next((line.split('=', 1)[1].strip('"') for line in Path('/etc/os-release').read_text().splitlines() if line.startswith('ID=')), '')
report('Git 작성자와 기본 브랜치 확인')
settings={key:output(['git','config','--global',field]) for key,field in [('gitName','user.name'),('gitEmail','user.email'),('gitBranch','init.defaultBranch')]}
tools={}
for tool in ['git','node','gh','claude','codex','orca-ide']:
    report(f'{tool} 설치 및 실행 상태 확인')
    tools[tool]=succeeds([tool,'--version'])
report('Ubuntu 검사 결과 정리')
print(json.dumps(dict(osId=os_id, contentCommit=content_commit, users=[u.pw_name for u in pwd.getpwall() if 1000 <= u.pw_uid < 65534],
                     user=pwd.getpwuid(__import__('os').getuid()).pw_name, zshrc=(home / '.zshrc').exists(),
                     gitName=settings['gitName'],
                     gitEmail=settings['gitEmail'],
                     gitBranch=settings['gitBranch'],
                     timezone=Path('/etc/timezone').read_text().strip() if Path('/etc/timezone').exists() else '',
                     auth=auth, tools=tools, skillReadiness=probe())))
report('Ubuntu 검사 완료')
