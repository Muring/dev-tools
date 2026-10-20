#!/usr/bin/env python3
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'linux'))
from skill_readiness import probe


class ReadinessTests(unittest.TestCase):
    def test_missing_setup_does_not_claim_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = probe(tmp, {}, lambda _: None)['checks']
            self.assertFalse(result['blogSkill'])
            self.assertFalse(result['blogProject'])
            self.assertFalse(result['trackingConfig'])
            self.assertFalse(result['storageTools'])
            self.assertFalse(result['powershell'])

    def test_custom_paths_and_shared_links_without_reading_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            source = home / 'source/SKILL.md'
            source.parent.mkdir(); source.write_text('skill')
            link = home / 'custom-codex/skills/blog-draft/SKILL.md'
            link.parent.mkdir(parents=True); link.symlink_to(source)
            blog = home / 'custom-blog'; blog.mkdir()
            (blog / 'package.json').write_text('{}')
            (blog / '.env').write_text('SECRET=must-not-be-read')
            config = home / '.config/ai-workflow/tracking.json'
            config.parent.mkdir(parents=True); config.write_text('{invalid config with secret}')
            with patch.object(Path, 'read_text', side_effect=AssertionError('No file content reads')):
                result = probe(home, {'CODEX_HOME': str(home / 'custom-codex'), 'MUBLOG_DIR': str(blog),
                                      'XDG_CONFIG_HOME': str(home / 'custom-config')}, lambda _: '/bin/tool')
            self.assertTrue(result['checks']['blogSkill'])
            self.assertTrue(result['checks']['blogProject'])
            self.assertTrue(result['checks']['trackingConfig'])
            self.assertNotIn('secret', json.dumps(result))
            self.assertNotIn('auth', result['checks'])
            source.unlink()
            self.assertFalse(probe(home, {'CODEX_HOME': str(home / 'custom-codex')}, lambda _: None)['checks']['blogSkill'])

    def test_access_error_is_unknown(self):
        with patch.object(Path, 'is_file', side_effect=PermissionError()):
            checks = probe('/unused', {}, lambda _: None)['checks']
        self.assertIsNone(checks['blogSkill'])
        self.assertIsNone(checks['trackingConfig'])

    def test_saved_blog_path_is_rechecked_and_invalid_settings_do_not_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)
            project=home/'chosen-blog'; project.mkdir(); (project/'package.json').write_text('{}')
            settings=home/'.config/dev-bootstrap/skill-setup.json'; settings.parent.mkdir(parents=True)
            settings.write_text(json.dumps({'blog-draft':{'path':str(project)}}))
            self.assertTrue(probe(home, {}, lambda _: None)['checks']['blogProject'])
            settings.write_text('{"blog-draft":"invalid"}')
            self.assertFalse(probe(home, {}, lambda _: None)['checks']['blogProject'])


if __name__ == '__main__':
    unittest.main()
