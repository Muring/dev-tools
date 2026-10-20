#!/usr/bin/env python3
import json
import base64
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'linux'))
from skill_setup import Setup, write_json


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.calls = []
        self.setup = Setup(self.home, runner=self.runner, env={})
        for name in ('blog-draft', 'usage-report', 'storage-maintenance'):
            source = self.home / '.codex/skills' / name
            (source / 'scripts').mkdir(parents=True)
            (source / 'SKILL.md').write_text('skill')
            (source / 'scripts/usage_tracker.py').write_text('collect-local')
        self.blog = self.home / 'blog'; self.blog.mkdir()
        (self.blog / 'package.json').write_text('{"scripts":{"draft:post":"tsx draft.mts"}}')
        self.config = self.home / '.config/ai-workflow/tracking.json'
        self.kb = self.home / 'kb'; (self.kb / '.git').mkdir(parents=True)
        (self.kb / 'templates').mkdir(); (self.kb / 'templates/usage-report.html').write_text('template')

    def runner(self, argv, **kwargs):
        self.calls.append(argv)
        if 'init' in argv:
            write_json(self.config, {'repo': str(self.kb), 'projects': {}, 'state': str(self.home/'state')})
        if 'collect-local' in argv:
            return '{"state":"ok"}'
        if 'report' in argv:
            return json.dumps({'path': str(self.home/'preview.html'), 'fingerprint': 'a'*64})
        if 'scan' in argv:
            return json.dumps({'snapshot': str(self.home/'snapshot.json'), 'state': 'partial'})
        return '{}'

    def execute(self, request):
        plan = self.setup.preview(request)
        self.assertEqual(plan['blockers'], [])
        return self.setup.execute(plan['id'])

    def test_preview_is_non_mutating_and_input_is_not_shell(self):
        request = {'skill':'blog-draft', 'path':str(self.blog), 'installDependencies':True}
        plan = self.setup.preview(request)
        self.assertFalse(self.calls)
        self.assertFalse(self.setup.settings_path.exists())
        result = self.setup.execute(plan['id'])
        self.assertEqual(result['status'], 'waiting')
        self.assertEqual(self.calls[0], ['corepack','yarn','install'])
        self.assertTrue(self.calls[1][1].endswith('blog_connection.mjs'))
        with self.assertRaises(ValueError): self.setup.execute(plan['id'])
        with self.assertRaises(ValueError): self.setup.preview({**request, 'repository':'https://token@github.com/a/b'})
        with self.assertRaises(ValueError): self.setup.execute('../../elsewhere')

    def test_changed_plan_rejected_before_execution(self):
        plan = self.setup.preview({'skill':'blog-draft','path':str(self.blog),'installDependencies':True})
        (self.blog/'package.json').write_text('{"scripts":{"draft:post":"changed"}}')
        with self.assertRaises(ValueError): self.setup.execute(plan['id'])
        self.assertFalse(self.calls)

    def test_secrets_not_in_results_and_no_draft_registration(self):
        (self.blog/'.env').write_text('DATABASE_URL=super-secret\nSUPABASE_SECRET_KEY=also-secret\n')
        draft = self.home/'draft.mdx'; draft.write_text('draft')
        result = self.execute({'skill':'blog-draft','path':str(self.blog),'draft':str(draft)})
        self.assertEqual(result['status'], 'waiting')
        self.assertIn('--dry-run', self.calls[-1])
        self.assertNotIn('secret',json.dumps(result))
        self.assertNotIn('super-secret', ''.join(p.read_text() for p in self.setup.state.rglob('*.json')))

    def test_blog_connection_success_and_partial_failure(self):
        for statuses, expected in [(['connected', 'connected'], 'completed'), (['connected', 'failed'], 'waiting')]:
            checks = [{'label': label, 'status': status, 'message': 'safe message'} for label, status in
                      zip(['DB 연결·읽기', '이미지 버킷 접근'], statuses)]
            with patch.object(self.setup, 'runner', return_value=json.dumps({'checks': checks})):
                result = self.execute({'skill': 'blog-draft', 'path': str(self.blog)})
            self.assertEqual(result['status'], expected)
            self.assertEqual(result['checks'][-2:], checks)

    def test_blog_credentials_create_private_env_without_secret_artifacts(self):
        import os, subprocess
        values = {'DATABASE_URL':'postgresql://user:encoded%23pass@db.example:6543/postgres?pgbouncer=true',
                  'NEXT_PUBLIC_SUPABASE_URL':'https://project.supabase.co',
                  'SUPABASE_SECRET_KEY':'sb_secret_synthetic_test'}
        request = {'skill':'blog-draft', 'path':str(self.blog), 'credentialKeys':list(values)}
        plan = self.setup.preview(request)
        result = self.setup.execute(plan['id'], values)
        self.assertEqual(result['status'], 'waiting')
        env = self.blog/'.env'
        self.assertEqual(env.stat().st_mode & 0o777, 0o600)
        self.assertIn('/.env', (self.blog/'.gitignore').read_text())
        output = subprocess.check_output(['node', '--env-file='+str(env), '-e',
            'console.log(JSON.stringify(Object.fromEntries(["DATABASE_URL","NEXT_PUBLIC_SUPABASE_URL","SUPABASE_SECRET_KEY"].map(k=>[k,process.env[k]]))))'],
            env={k:v for k,v in os.environ.items() if k not in values}, text=True)
        self.assertEqual(json.loads(output), values)
        artifacts = ''.join(p.read_text() for p in self.setup.state.rglob('*') if p.is_file())
        for value in values.values():
            self.assertNotIn(value, artifacts)
        self.assertTrue(self.calls[0][1].endswith('blog_connection.mjs'))

    def test_blog_credentials_preserve_existing_values_and_unrelated_lines(self):
        env = self.blog/'.env'
        original = '# keep comment\nOTHER=kept\nDATABASE_URL=\nSUPABASE_SECRET_KEY=existing\n'
        env.write_text(original)
        request = {'skill':'blog-draft', 'path':str(self.blog), 'credentialKeys':['SUPABASE_SECRET_KEY']}
        self.assertTrue(self.setup.preview(request)['blockers'])
        request['credentialKeys'] = ['DATABASE_URL']
        plan = self.setup.preview(request)
        result = self.setup.execute(plan['id'], {'DATABASE_URL':'postgres://user:pass@db.example/db'})
        self.assertEqual(result['status'], 'waiting')
        self.assertIn('# keep comment\nOTHER=kept\n',env.read_text())
        self.assertIn('SUPABASE_SECRET_KEY=existing\n',env.read_text())
        self.assertEqual(env.read_text().count('DATABASE_URL='),1)

    def test_blog_credentials_explicit_replacement(self):
        env = self.blog / '.env'
        env.write_text("# keep\nDATABASE_URL='postgres://u:old@db.example/db'\nSUPABASE_SECRET_KEY=sb_secret_keep\nOTHER=keep\n")
        request = {'skill': 'blog-draft', 'path': str(self.blog), 'credentialKeys': ['DATABASE_URL']}
        self.assertTrue(self.setup.preview(request)['blockers'])
        request['replaceCredentialKeys'] = ['DATABASE_URL']
        plan = self.setup.preview(request)
        self.assertFalse(plan['blockers'])
        self.assertTrue(any('기존 .env 인증값 교체: DATABASE_URL' in action for action in plan['actions']))
        result = self.setup.execute(plan['id'], {'DATABASE_URL': 'postgres://u:new-secret@db.example/db'})
        self.assertIn('postgres://u:new-secret@db.example/db', env.read_text())
        self.assertNotIn('u:old', env.read_text())
        self.assertIn('SUPABASE_SECRET_KEY=sb_secret_keep\nOTHER=keep\n', env.read_text())
        self.assertTrue(env.read_text().startswith('# keep\n'))
        self.assertEqual(env.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('new-secret', json.dumps(result))
        for file in self.setup.state.rglob('*.json'):
            self.assertNotIn('new-secret', file.read_text())
        with self.assertRaises(ValueError):
            self.setup.preview({**request, 'replaceCredentialKeys': ['SUPABASE_SECRET_KEY']})

    def test_blog_replacement_rejects_changed_env_and_environment_override(self):
        env = self.blog / '.env'
        env.write_text('SUPABASE_SECRET_KEY=sb_secret_old\n')
        request = {'skill': 'blog-draft', 'path': str(self.blog), 'credentialKeys': ['SUPABASE_SECRET_KEY'],
                   'replaceCredentialKeys': ['SUPABASE_SECRET_KEY']}
        plan = self.setup.preview(request)
        env.write_text('SUPABASE_SECRET_KEY=sb_secret_external_edit\n')
        with self.assertRaises(ValueError):
            self.setup.execute(plan['id'], {'SUPABASE_SECRET_KEY': 'sb_secret_new'})
        self.assertIn('sb_secret_external_edit', env.read_text())
        self.setup.env['SUPABASE_SECRET_KEY'] = 'sb_secret_environment'
        self.assertTrue(any('환경변수' in item for item in self.setup.preview(request)['blockers']))

    def test_blog_credentials_reject_stale_plan_and_mismatched_keys(self):
        request = {'skill':'blog-draft', 'path':str(self.blog), 'credentialKeys':['SUPABASE_SECRET_KEY']}
        plan = self.setup.preview(request)
        with self.assertRaises(ValueError):
            self.setup.execute(plan['id'], {'NEXT_PUBLIC_SUPABASE_URL':'https://project.supabase.co'})
        (self.blog/'.env').write_text('OTHER=new\n')
        with self.assertRaises(ValueError):
            self.setup.execute(plan['id'], {'SUPABASE_SECRET_KEY':'sb_secret_test'})
        self.assertEqual((self.blog/'.env').read_text(),'OTHER=new\n')

    def test_blog_credentials_reject_symlink_tracked_env_and_multiline(self):
        import subprocess
        from blog_credentials import save_credentials, validate_credentials
        external = self.home/'external'; external.write_text('unchanged')
        (self.blog/'.env').symlink_to(external)
        with self.assertRaises(ValueError):
            save_credentials(self.blog, {'SUPABASE_SECRET_KEY':'sb_secret_test'})
        self.assertEqual(external.read_text(),'unchanged')
        (self.blog/'.env').unlink()
        (self.blog/'.env').write_text('OTHER="multi\nline"\n')
        with self.assertRaises(ValueError):
            save_credentials(self.blog, {'SUPABASE_SECRET_KEY':'sb_secret_test'})
        (self.blog/'.env').write_text('OTHER=value\n')
        subprocess.run(['git','init',str(self.blog)],check=True,capture_output=True)
        subprocess.run(['git','-C',str(self.blog),'add','.env'],check=True,capture_output=True)
        with self.assertRaises(ValueError):
            save_credentials(self.blog, {'SUPABASE_SECRET_KEY':'sb_secret_test'})
        for value in ['sb_secret_x\nINJECT=x', "sb_secret_quote'", 'sb_publishable_wrong', 'sb_secret_<example>']:
            with self.assertRaises(ValueError):
                validate_credentials({'SUPABASE_SECRET_KEY':value})
        self.assertEqual((self.blog/'.env').read_text(),'OTHER=value\n')

    def test_blog_credentials_cli_uses_stdin_and_omits_secret_from_output(self):
        import os, subprocess
        env = dict(os.environ, HOME=str(self.home), CODEX_HOME=str(self.home/'.codex'))
        cli = [sys.executable,str(Path(__file__).resolve().parents[1]/'linux/skill_setup.py')]
        request = {'skill':'blog-draft','path':str(self.blog),'credentialKeys':['SUPABASE_SECRET_KEY']}
        preview = subprocess.run(cli+['preview','--request-stdin'],input=json.dumps(request),env=env,capture_output=True,text=True,check=True)
        plan = json.loads(preview.stdout)
        result = subprocess.run(cli+['execute','--id',plan['id'],'--credentials-stdin'],
            input=json.dumps({'SUPABASE_SECRET_KEY':'sb_secret_cli_synthetic'}),env=env,capture_output=True,text=True,check=True)
        self.assertNotIn('sb_secret_cli_synthetic',result.stdout+result.stderr+preview.stdout+preview.stderr)
        self.assertIn('sb_secret_cli_synthetic',(self.blog/'.env').read_text())
        self.assertEqual(json.loads(result.stdout)['status'],'waiting')

    def test_usage_local_never_sends_even_with_publisher(self):
        write_json(self.config, {'repo':str(self.kb),'projects':{},'publisher':{'mode':'git-workflow'}})
        result=self.execute({'skill':'usage-report','path':str(self.kb)})
        self.assertEqual(result['status'],'completed')
        self.assertTrue(any('collect-local' in c for c in self.calls))
        self.assertFalse(any(any(x in c for x in ('run','sync','schedule','publish-retry')) for c in self.calls))
        plan=self.setup.preview({'skill':'usage-report','path':str(self.kb),'sync':True})
        self.assertTrue(plan['blockers'])

    def test_initialize_once_and_reviewed_project_name_change(self):
        req={'skill':'usage-report','path':str(self.kb),'initialize':True,'projects':{str(self.blog):'me/blog'}}
        self.execute(req); self.execute(req)
        self.assertEqual(sum('init' in c for c in self.calls),1)
        plan=self.setup.preview({**req,'projects':{str(self.blog):'other/blog'}})
        self.assertFalse(plan['blockers'])
        self.assertTrue(any('me/blog → other/blog' in action for action in plan['actions']))
        self.assertEqual(json.loads(self.config.read_text())['projects'][str(self.blog)],'me/blog')
        self.setup.execute(plan['id'])
        self.assertEqual(json.loads(self.config.read_text())['projects'][str(self.blog)],'other/blog')
        self.assertTrue(list(self.config.parent.glob(self.config.name+'.bak.*')))

    def test_discovery_uses_folder_names_and_retains_existing_display_names(self):
        dev = self.home/'dev'
        for name in ['new-project', 'renamed']:
            (dev/name/'.git').mkdir(parents=True)
        external = str(self.home/'elsewhere')
        write_json(self.config, {'projects':{str(dev/'renamed'):'kept/name',external:'outside/name'}})
        projects = {p['path']:p['alias'] for p in self.setup.discover('usage-report')['projects']}
        self.assertEqual(projects[str(dev/'new-project')],'new-project')
        self.assertEqual(projects[str(dev/'renamed')],'kept/name')
        self.assertEqual(projects[external],'outside/name')

    def test_storage_discovery_keeps_saved_targets_and_preserve_defaults(self):
        path = self.home/'.config/dev-bootstrap/storage-maintenance.json'
        target = {'platform':'linux','path':str(self.home/'custom'),'kind':'directory'}
        write_json(path, {'targets':[target], 'preserve':[{'platform':'linux','path':str(self.home/'keep')}]})
        found = self.setup.discover('storage-maintenance')
        self.assertEqual(found['targets'], [target])
        self.assertIn(str(self.home/'keep'), found['preserve'])
        for folder in ('dev', '.codex', '.claude', '.local/share'):
            self.assertIn(str(self.home/folder), found['preserve'])
        self.assertFalse(self.calls)

    def test_discovery_reports_publisher_configuration_without_values(self):
        write_json(self.config, {'publisher': {'mode':'git-workflow','secret':'do-not-display'}})
        found = self.setup.discover('usage-report')
        self.assertTrue(found['trackingConfigured'])
        self.assertTrue(found['publisherConfigured'])
        self.assertNotIn('do-not-display', json.dumps(found))
        setup = Setup(self.home, runner=self.runner, env={'CLAUDE_CONFIG_DIR':str(self.home/'custom-claude')})
        self.assertIn(str(self.home/'custom-claude'), setup.discover('storage-maintenance')['preserve'])

    def test_storage_preserves_existing_policy_and_never_deletes(self):
        path=self.home/'.config/dev-bootstrap/storage-maintenance.json'
        keep={'platform':'linux','path':str(self.home/'important')}
        write_json(path, {'preserve':[keep], 'retention':{'keep_latest':5}})
        result=self.execute({'skill':'storage-maintenance','targets':[{'platform':'linux','path':str(self.blog)}], 'preserve':[], 'schedulePlan':True})
        self.assertEqual(result['status'],'waiting')
        config=json.loads(path.read_text())
        self.assertEqual(config['preserve'],[keep]);self.assertEqual(config['retention'],{'keep_latest':5})
        self.assertTrue(list(path.parent.glob(path.name+'.bak.*')))
        self.assertFalse(any('apply' in c or '--execute' in c for c in self.calls))
        self.assertTrue(any('schedule-plan' in c for c in self.calls))

    def test_storage_preview_checks_selected_paths_without_scanning(self):
        request = {'skill': 'storage-maintenance', 'targets': [{'platform': 'linux', 'path': str(self.blog), 'kind': 'directory'}],
                   'preserve': [{'platform': 'linux', 'path': str(self.home/'future-protected')}]}
        self.assertEqual(self.setup.preview(request)['blockers'], [])
        self.assertFalse(self.calls)
        with patch('skill_setup.os.access', return_value=False):
            self.assertIn('권한', self.setup.preview(request)['blockers'][0])
        request['targets'][0]['kind'] = 'file'
        self.assertIn('종류', self.setup.preview(request)['blockers'][0])
        request['targets'][0]['path'] = str(self.home/'missing')
        self.assertIn('경로가 없습니다', self.setup.preview(request)['blockers'][0])
        self.assertFalse((self.home/'.config/dev-bootstrap/storage-maintenance.json').exists())

    def test_storage_windows_probe_treats_paths_as_data(self):
        target = {'platform': 'windows', 'path': "D:\\data'; Write-Output injected", 'kind': 'directory'}
        def runner(argv, **kwargs):
            self.assertEqual(argv[:4], ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
            script = base64.b64decode(argv[4]).decode('utf-16-le')
            self.assertNotIn(target['path'], script)
            self.assertIn('-LiteralPath', script)
            self.assertEqual(kwargs['timeout'], 20)
            return '{"ok":true}'
        self.setup.runner = runner
        self.assertEqual(self.setup.preview({'skill':'storage-maintenance', 'targets':[target]})['blockers'], [])
        self.setup.runner = lambda *args, **kwargs: '{"ok":false}'
        self.assertTrue(self.setup.preview({'skill':'storage-maintenance', 'targets':[target]})['blockers'])

    def test_failure_is_retryable_only_with_new_plan(self):
        self.setup.runner=lambda *a,**k: (_ for _ in ()).throw(RuntimeError('의존성 설치 실패'))
        request={'skill':'blog-draft','path':str(self.blog),'installDependencies':True}
        result=self.execute(request)
        self.assertEqual(result['status'],'failed')
        self.assertEqual(result['steps'][0]['status'],'failed')
        self.setup.runner=self.runner
        self.assertEqual(self.execute(request)['status'],'waiting')

    def test_schedule_requires_explicit_fingerprint(self):
        write_json(self.config, {'repo':str(self.kb),'projects':{}})
        req={'skill':'usage-report','path':str(self.kb),'schedule':True}
        self.assertTrue(self.setup.preview(req)['blockers'])
        self.assertTrue(self.setup.preview({**req,'fingerprint':'a'*64})['blockers'])
        result=self.execute({**req,'fingerprint':'a'*64,'approveTemplate':True})
        self.assertEqual(result['status'],'completed')
        self.assertTrue(any('approve' in c for c in self.calls))
        self.assertTrue(any('--enable' in c for c in self.calls))
        self.assertTrue(any('is-active' in c for c in self.calls))

    def test_collect_warning_prevents_requested_sync(self):
        write_json(self.config, {'repo':str(self.kb),'projects':{}})
        original = self.runner
        def warned(argv, **kwargs):
            if 'collect-local' in argv:
                self.calls.append(argv)
                return '{"state":"attention"}'
            return original(argv, **kwargs)
        self.setup.runner = warned
        result = self.execute({'skill':'usage-report','path':str(self.kb),'sync':True})
        self.assertEqual(result['status'],'waiting')
        self.assertFalse(any('sync' in c for c in self.calls))
        self.assertTrue(result['artifacts'])

    def test_persisted_custom_codex_home_is_resolved(self):
        custom = self.home / 'custom-codex'
        (self.home/'.codex').rename(custom)
        write_json(self.home/'.local/share/dev-bootstrap/content/state.json', {'codexHome':str(custom)})
        setup = Setup(self.home, runner=self.runner, env={})
        self.assertEqual(setup.skill('blog-draft'), custom/'skills/blog-draft')

    def test_cli_preview_and_prepare_in_isolated_home(self):
        import os, subprocess
        env = dict(os.environ, HOME=str(self.home), CODEX_HOME=str(self.home/'.codex'))
        request = self.home/'request.json'
        write_json(request, {'skill':'blog-draft','path':str(self.blog)})
        script = str(Path(__file__).resolve().parents[1]/'linux/skill_setup.py')
        plan = json.loads(subprocess.check_output([sys.executable,script,'preview','--request',str(request)],env=env,text=True))
        self.assertFalse(self.setup.settings_path.exists())
        result = json.loads(subprocess.check_output([sys.executable,script,'execute','--id',plan['id']],env=env,text=True,stderr=subprocess.DEVNULL))
        self.assertEqual(result['status'],'waiting')
        invalid = subprocess.run([sys.executable,script,'execute','--id','invalid'],env=env,text=True,capture_output=True)
        self.assertEqual(invalid.returncode,1)
        self.assertIn('error',json.loads(invalid.stdout))
        self.assertEqual(json.loads(self.setup.settings_path.read_text())['blog-draft']['path'],str(self.blog))

    def test_storage_discovery_marks_unavailable_windows(self):
        result = self.setup.discover('storage-maintenance')
        self.assertEqual(result['windowsDiscovery'], 'unknown')
        self.assertFalse(self.calls)
        self.assertTrue(all(p['platform'] == 'linux' for p in result['targets']))


if __name__ == '__main__': unittest.main()
