#!/usr/bin/env python3
"""No network or real profile changes: exercise the production transactional updater."""
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'linux'))
from lib.content import ContentStore, GROUPS, blob_hash, inventory, atomic_json

ROOT = Path(__file__).resolve().parents[1]


def fixture(source, commit):
    tree=[]; blobs={}
    for folder in ('commands','skills'):
        for path in sorted((source / folder).rglob('*')):
            if path.is_file() or path.is_symlink():
                data=os.readlink(path).encode() if path.is_symlink() else path.read_bytes()
                sha=blob_hash(data);blobs[sha]=data
                tree.append(dict(path=str(path.relative_to(source)),mode='120000' if path.is_symlink() else '100644',type='blob',sha=sha,size=len(data)))
    files,commands,skills=inventory(dict(tree=tree,truncated=False))
    return dict(version=1,repository='Muring/dev-tools',commit=commit,message='fixture',date='2026-09-17',files=files,commands=commands,skills=skills),blobs


class Client:
    def __init__(self, snapshots):
        self.snapshots=snapshots;self.fail=False;self.calls=[];self.head=next(iter(snapshots))
    def resolve(self, commit=''):
        self.calls.append(('resolve',commit))
        if self.fail: raise ValueError('network failure')
        return deepcopy(self.snapshots[commit or self.head][0])
    def blob(self,item):
        self.calls.append(('blob',item['path']))
        if self.fail: raise ValueError('network failure')
        return next(blobs[item['sha']] for _,blobs in self.snapshots.values() if item['sha'] in blobs)


class ContentTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.home=self.root/'home';self.home.mkdir()
        self.source=self.root/'source';self.source.mkdir()
        for folder in ('commands','skills'):shutil.copytree(ROOT/folder,self.source/folder,symlinks=True)
        first=fixture(self.source,'1'*40)
        (self.source/'commands/code-audit.md').unlink();(self.source/'skills/code-audit/SKILL.md').unlink()
        (self.source/'skills/fresh').mkdir()
        (self.source/'skills/fresh/SKILL.md').write_text('---\nname: fresh\ndescription: New command\n---\nShared body\n')
        (self.source/'commands/fresh.md').symlink_to('../skills/fresh/SKILL.md')
        second=fixture(self.source,'2'*40)
        self.client=Client({'1'*40:first,'2'*40:second})
        self.store=ContentStore(self.home,self.root/'custom codex',self.client)
    def test_shared_original_backup_removal_repeat_and_custom_codex(self):
        first=self.store.apply('1'*40,list(GROUPS))
        for name in first['commands']:
            self.assertEqual((self.home/'.claude/commands'/f'{name}.md').resolve(),(self.root/'custom codex/skills'/name/'SKILL.md').resolve())
            self.assertTrue(self.store.check('codex-skills','1'*40))
        unrelated=self.root/'custom codex/skills/mine';unrelated.mkdir();(unrelated/'SKILL.md').write_text('keep')
        preview=self.store.preview('2'*40)
        self.assertIn({'path':'commands/fresh.md','status':'added'},preview['changes'])
        second=self.store.apply('2'*40,['claude-commands'])
        self.assertTrue((self.root/'custom codex/skills/fresh/SKILL.md').is_file())
        self.assertFalse((self.root/'custom codex/skills/code-audit').exists())
        self.assertEqual((unrelated/'SKILL.md').read_text(),'keep')
        self.assertTrue((Path(second['backup'])/'content/commands/code-audit.md').is_file())
        backups=list((self.store.root/'backups').iterdir());self.client.fail=True
        self.store.apply('2'*40,list(GROUPS))
        self.assertEqual(list((self.store.root/'backups').iterdir()),backups)
        with patch.dict(os.environ):
            os.environ.pop('CODEX_HOME',None)
            restored=ContentStore(self.home,client=self.client)
            self.assertTrue(restored.check('codex-skills','2'*40))
            self.assertEqual(restored.codex_home,self.root/'custom codex')
    def test_network_failure_keeps_previous_installation(self):
        self.store.apply('1'*40,list(GROUPS));before=(self.store.root/'state.json').read_bytes()
        self.client.fail=True
        with self.assertRaises(ValueError):self.store.apply('2'*40,list(GROUPS))
        self.assertEqual((self.store.root/'state.json').read_bytes(),before)
        self.assertTrue(self.store.check('claude-commands','1'*40))
    def test_mid_download_failure_and_hash_mismatch_do_not_switch(self):
        self.store.apply('1'*40,list(GROUPS));original=self.client.blob
        def broken(item):
            if item['path']=='commands/fresh.md':return b'corrupt'
            return original(item)
        self.client.blob=broken
        with self.assertRaises(ValueError):self.store.apply('2'*40,list(GROUPS))
        self.assertTrue(self.store.check('codex-skills','1'*40))
        self.assertFalse(list((self.store.root/'releases').glob('.download-*')))
    def test_conflicts_preserve_files_and_foreign_links(self):
        target=self.home/'.claude/commands';target.mkdir(parents=True);(target/'keep').write_text('mine')
        with self.assertRaises(ValueError):self.store.apply('1'*40,['claude-commands'])
        self.assertEqual((target/'keep').read_text(),'mine')
        shutil.rmtree(target);target.symlink_to(self.source/'commands')
        with self.assertRaises(ValueError):self.store.apply('1'*40,['claude-commands'])
        self.assertEqual(target.resolve(),self.source/'commands')
    def test_legacy_migration_has_backup(self):
        legacy=self.home/'.local/share/dev-bootstrap/runtime/commands';legacy.mkdir(parents=True);(legacy/'old.md').write_text('old content')
        target=self.home/'.claude/commands';target.parent.mkdir();target.symlink_to(legacy)
        result=self.store.apply('1'*40,['claude-commands'])
        self.assertEqual((Path(result['backup'])/'legacy-0/old.md').read_text(),'old content')
        self.assertTrue(self.store.check('claude-commands','1'*40))
    def test_failed_switch_rolls_back_links_and_state(self):
        self.store.apply('1'*40,list(GROUPS));before=(self.store.root/'state.json').read_bytes()
        link=self.store.link;failed=False
        def fail_once(path,target):
            nonlocal failed
            if str(path).endswith('/current') and not failed:
                failed=True;raise OSError('simulated switch failure')
            return link(path,target)
        self.store.link=fail_once
        with self.assertRaises(OSError):self.store.apply('2'*40,list(GROUPS))
        self.assertEqual((self.store.root/'state.json').read_bytes(),before)
        self.assertTrue(self.store.check('codex-skills','1'*40))
        self.assertFalse((self.root/'custom codex/skills/fresh').is_symlink())
        self.assertFalse((self.store.root/'pending.json').exists())
    def test_interrupted_transaction_recovers_on_next_update(self):
        self.store.apply('1'*40,list(GROUPS));old=self.store.state()
        target=self.home/'.claude/commands';before=os.readlink(target)
        transaction=dict(state=old,changes=[dict(path=str(target),before=before,after=None)])
        atomic_json(self.store.root/'pending.json',transaction);target.unlink()
        self.assertFalse(self.store.check('claude-commands','1'*40))
        self.store.apply('1'*40,['claude-commands'])
        self.assertTrue(self.store.check('claude-commands','1'*40))
    def test_unreviewed_head_is_never_substituted(self):
        preview=self.store.preview();self.client.head='2'*40
        result=self.store.apply(preview['commit'],['codex-skills'])
        self.assertEqual(result['commit'],'1'*40)
        self.assertFalse((self.home/'.claude').exists())
    def test_unexpected_local_changes_are_preserved(self):
        result=self.store.apply('1'*40,['claude-commands'])
        command=self.store.root/'releases'/result['commit']/'commands/commit.md';command.write_text('local change')
        with self.assertRaises(ValueError):self.store.apply('1'*40,['claude-commands'])
        self.assertEqual(command.read_text(),'local change')
    def test_path_escape_and_external_symlink_rejected(self):
        item=dict(path='skills/../../outside',mode='100644',type='blob',sha='a'*40,size=1)
        with self.assertRaises(ValueError):inventory(dict(tree=[item]))
        meta,blobs=self.client.snapshots['1'*40]
        item=next(i for i in meta['files'] if i['path']=='commands/commit.md')
        content=b'/etc/passwd';item['sha']=blob_hash(content);item['size']=len(content);blobs[item['sha']]=content
        with self.assertRaises(ValueError):self.store.apply('1'*40,['codex-skills'])
        self.assertFalse((self.root/'custom codex/skills').exists())


if __name__=='__main__':unittest.main()
