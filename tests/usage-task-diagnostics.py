#!/usr/bin/env python3
"""Local task-gap review signals; no network or production records."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/usage-report/scripts'))
import usage_task_diagnostics as diagnostic
import usage_tracker as tracker
import usage_store as store

AT = '2026-10-15T00:00:00+00:00'


def usage(key='a', timestamp='2026-10-13T23:00:00Z', project='test/app'):
    return dict(key=key, timestamp=timestamp, project=project)


def task(precision='date', date='2026-10-14', project='test/app', id='result'):
    return dict(project=project, id=id, activity=dict(timing=dict(
        precision=precision, occurredOn=date if precision == 'date' else None,
        occurredAt=date if precision == 'timestamp' else None)))


class DiagnosticsTests(unittest.TestCase):
    def test_missing_result_is_signal_not_linkage_and_deduplicates_usage(self):
        rows=[usage(),usage(),usage('b',project='test/other')]
        original=copy.deepcopy(rows)
        result=diagnostic.diagnose(rows, [], [], AT)
        self.assertEqual(len(result['missingTaskDates']),2)
        self.assertEqual(result['missingTaskDates'][0]['observedResponses'],1)
        self.assertEqual(result['state'],'observed')
        self.assertEqual(rows,original)

    def test_date_and_kst_timestamp_cover_only_same_project_and_date(self):
        for value in (task(),task('timestamp','2026-10-13T15:01:00Z')):
            result=diagnostic.diagnose([usage(),usage('b',project='test/other')],[value],[],AT)
            self.assertEqual([r['project'] for r in result['missingTaskDates']],['test/other'])
        result=diagnostic.diagnose([usage()],[task(date='2026-10-13')],[],AT)
        self.assertEqual(len(result['missingTaskDates']),1)

    def test_explicit_unknown_never_uses_id_or_legacy_date(self):
        value=task('unknown',id='20261014-task')
        value['presentation']=dict(occurredAt='2026-10-14T00:00:00Z')
        result=diagnostic.diagnose([usage()],[value],[],AT)
        self.assertEqual(result['missingTaskDates'][0]['unknownDateTasks'],1)
        self.assertEqual(result['unknownDateTasks'],[dict(project='test/app',count=1)])
        del value['activity']
        self.assertEqual(diagnostic.diagnose([usage()],[value],[],AT)['missingTaskDates'],[])

    def test_today_and_unfinished_are_separate_from_prior_day_gaps(self):
        runs=[('old',dict(project='test/app',id='result',since='2026-10-13T23:00:00Z',until=AT)),
              ('current',dict(project='test/app',id='current',since=AT)),
              ('done',dict(project='test/app',id='done',since=AT,result='saved'))]
        result=diagnostic.diagnose([usage(timestamp=AT)],[task()],runs,AT)
        self.assertEqual(result['missingTaskDates'],[])
        self.assertEqual(len(result['currentDayWithoutTask']),1)
        self.assertEqual(len(result['unfinishedRuns']),2)
        old=result['unfinishedRuns'][0]
        self.assertTrue(old['previousDay'] and old['completionPending'] and old['storedTaskPresent'])
        self.assertFalse(result['unfinishedRuns'][1]['previousDay'])

    def test_conflicting_task_cannot_hide_gap(self):
        value=task();value['conflict']=True
        result=diagnostic.diagnose([usage()],[value],[],AT)
        self.assertEqual(result['taskConflicts'],1)
        self.assertEqual(len(result['missingTaskDates']),1)

    def test_future_usage_is_not_mislabeled_as_today_or_missing_task(self):
        result=diagnostic.diagnose([usage(timestamp='2026-10-20T00:00:00Z')],[],[],AT)
        self.assertEqual(result['missingTaskDates'],[])
        self.assertEqual(result['currentDayWithoutTask'],[])
        self.assertEqual(len(result['futureDatedUsage']),1)

    def test_bad_run_replaces_old_diagnostic_with_unavailable_without_repairing_run(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg=dict(state=directory);path=Path(directory)/'task-runs/bad.json'
            path.parent.mkdir();path.write_text('{broken')
            store.atomic(Path(directory)/'task-record-diagnostics.json',dict(state='observed'))
            result=diagnostic.write_report(cfg,[usage()],[])
            self.assertEqual(result['state'],'unavailable')
            self.assertEqual(store.read(Path(directory)/'task-record-diagnostics.json')['state'],'unavailable')
            self.assertEqual(path.read_text(),'{broken')
            self.assertIn('진단 미완료',(Path(directory)/'task-record-diagnostics.txt').read_text())

    def test_report_write_failure_is_visible_and_nonthrowing(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(diagnostic,'atomic',side_effect=OSError('private detail')):
            result=diagnostic.write_report(dict(state=directory),[usage()],[])
            self.assertEqual(result['state'],'unavailable')
            self.assertNotIn('private detail',json.dumps(result))

    def test_run_writes_diagnostic_without_turning_gap_into_collection_issue(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);data=root/'data';data.mkdir()
            cfg=dict(state=str(root/'state'),worktree=str(data),device='test',reports=str(root/'reports'))
            quality=dict(issues=[],state='observed')
            with patch.object(tracker,'guard'),patch.object(tracker,'scan',return_value=(dict(records=[usage()]),quality)),patch.object(tracker,'publish'),patch.object(tracker,'git',return_value=''),patch.object(tracker,'aggregate',return_value=dict(tasks=[])),patch.object(tracker,'is_approved',return_value=False):
                result=tracker.run(cfg)
            self.assertEqual(result['state'],'ok')
            self.assertEqual(quality['issues'],[])
            self.assertEqual(len(result['task_record_diagnostics']['missingTaskDates']),1)
            self.assertTrue((root/'state/task-record-diagnostics.txt').exists())


if __name__ == '__main__':
    unittest.main()
