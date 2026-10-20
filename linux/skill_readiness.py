"""Bounded, read-only prerequisite checks; never reads credentials or runs setup."""
import os
import json
from pathlib import Path
import shutil
import sys
from datetime import datetime, timezone


def registered_codex_home(home, env):
    value = env.get('CODEX_HOME')
    if not value:
        state = home / '.local/share/dev-bootstrap/content/state.json'
        try:
            if state.is_file() and state.stat().st_size <= 1024 * 1024:
                value = json.loads(state.read_text()).get('codexHome')
        except (OSError, ValueError, AttributeError):
            pass
    if isinstance(value, str) and value.startswith('/') and not any(ord(c) < 32 for c in value):
        return Path(value)
    return home / '.codex'


def probe(home=None, environ=None, which=None):
    home = Path(home) if home is not None else Path.home()
    env = os.environ if environ is None else environ
    which = shutil.which if which is None else which
    codex = registered_codex_home(home, env)
    config = home / '.config'  # Matches usage_tracker.DEFAULT; --config is not discoverable here.

    def exists(path):
        try:
            return path.is_file()
        except OSError:
            return None

    def installed(name):
        paths = [codex / 'skills' / name / 'SKILL.md',
                 home / '.claude/skills' / name / 'SKILL.md',
                 home / '.claude/commands' / (name + '.md')]
        values = [exists(p) for p in paths]
        return True if True in values else (None if None in values else False)

    saved = {}
    settings = home / '.config/dev-bootstrap/skill-setup.json'
    try:
        if settings.is_file() and settings.stat().st_size <= 1024 * 1024:
            saved = json.loads(settings.read_text()).get('blog-draft', {})
            if not isinstance(saved, dict) or not isinstance(saved.get('path', ''), str):
                saved = {}
    except (OSError, ValueError, AttributeError):
        pass
    blog = Path(env.get('MUBLOG_DIR') or saved.get('path') or str(home / 'dev/mublog'))
    return {
        'checkedAt': datetime.now(timezone.utc).isoformat(),
        'checks': {
            'blogSkill': installed('blog-draft'),
            'blogProject': exists(blog / 'package.json'),
            'blogDependencies': exists(blog / 'node_modules/sharp/package.json'),
            'usageSkill': installed('usage-report'),
            'trackingConfig': exists(config / 'ai-workflow/tracking.json'),
            'storageSkill': installed('storage-maintenance'),
            'python': sys.version_info >= (3, 10),
            'storageTools': all(which(tool) is not None for tool in ('du', 'df', 'findmnt', 'git')),
            'powershell': which('powershell.exe') is not None,
        },
    }
