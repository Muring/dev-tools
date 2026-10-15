"""Local review signals only: never create tasks or infer task/token linkage."""
from collections import Counter
from datetime import datetime
from pathlib import Path

from usage_store import TZ, atomic, now, read


def day(value):
    value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if value.tzinfo is None:
        raise ValueError('Diagnostic timestamps need an explicit timezone')
    return value.astimezone(TZ).date().isoformat()


def task_day(task):
    if 'activity' in task:
        timing = task['activity']['timing']
        if timing['precision'] == 'date':
            return timing['occurredOn']
        if timing['precision'] == 'timestamp':
            return day(timing['occurredAt'])
        return None  # Explicit unknown must not fall back to an ID or legacy date.
    value = (task.get('presentation') or {}).get('occurredAt')
    return day(value) if value else None


def diagnose(records, tasks, runs, observed_at):
    today = day(observed_at)
    observed = Counter()
    seen = set()
    for row in records:
        if row['key'] in seen:
            continue
        seen.add(row['key'])
        observed[(row['project'], day(row['timestamp']))] += 1
    dated = Counter()
    unknown = Counter()
    conflicts = 0
    identities = set()
    for task in tasks:
        identity = (task['project'], task['id'])
        if identity in identities:
            continue
        identities.add(identity)
        if task.get('conflict'):
            conflicts += 1
            continue
        date = task_day(task)
        if date:
            dated[(task['project'], date)] += 1
        else:
            unknown[task['project']] += 1
    gaps, current, future = [], [], []
    for (project, date), count in sorted(observed.items()):
        if not dated[(project, date)]:
            row = dict(project=project, date=date, observedResponses=count,
                       unknownDateTasks=unknown[project])
            (gaps if date < today else current if date == today else future).append(row)
    unfinished = []
    for handle, run in runs:
        if run.get('result'):
            continue
        start_day = day(run['since'])
        unfinished.append(dict(handle=handle, project=run['project'], taskId=run['id'],
                               since=run['since'], date=start_day, previousDay=start_day < today,
                               completionPending=bool(run.get('until')),
                               storedTaskPresent=(run['project'], run['id']) in identities))
    return dict(schemaVersion=1, state='observed', generatedAt=observed_at, timezone='Asia/Seoul',
                scope='local collected usage; merged tasks from all devices; local task-runs',
                missingTaskDates=gaps, currentDayWithoutTask=current,
                futureDatedUsage=future,
                unfinishedRuns=sorted(unfinished, key=lambda r: (r['since'], r['handle'])),
                unknownDateTasks=[dict(project=p, count=n) for p, n in sorted(unknown.items())],
                taskConflicts=conflicts,
                limitations=['확인 필요 신호이며 작업 누락의 확정 판정이 아닙니다.',
                             '날짜가 있는 기록 1건도 그날의 모든 작업 기록 완료를 보장하지 않습니다.',
                             '사용량 출처 프로젝트와 실제 작업 대상 프로젝트는 다를 수 있습니다.',
                             '진행 중 작업과 과거 미종료 핸들은 자동 종료하거나 결과를 추정하지 않습니다.'])


def render_text(result):
    lines = ['작업 기록 확인 보고', '관측 시각: ' + result['generatedAt']]
    if result.get('sourceObservedAt'):
        lines.append('사용량 수집 기준: ' + result['sourceObservedAt'])
    if result['state'] != 'observed':
        return '\n'.join(lines + ['진단 미완료: ' + result['errorType'], '이 결과로 기록 누락 여부를 판단할 수 없습니다.']) + '\n'
    lines += ['', '작업 기록 확인 필요 (오늘 이전):']
    lines += [f"- {r['date']} | {r['project']} | 응답 {r['observedResponses']}건, 날짜 미상 작업 {r['unknownDateTasks']}건"
              for r in result['missingTaskDates']] or ['- 해당 없음']
    lines += ['', '오늘 사용량은 있으나 날짜가 확인된 작업 기록이 없는 프로젝트:']
    lines += [f"- {r['date']} | {r['project']} (진행 중일 수 있음)" for r in result['currentDayWithoutTask']] or ['- 해당 없음']
    lines += ['', '종료되지 않은 작업 핸들:']
    lines += [f"- {r['date']} | {r['project']} / {r['taskId']} | "
              + ('이전 날짜' if r['previousDay'] else '오늘 시작')
              + (' | 저장된 작업 있음, 종료 연결 확인 필요' if r['storedTaskPresent'] else '')
              for r in result['unfinishedRuns']] or ['- 해당 없음']
    lines += ['', '날짜 미상 작업:']
    lines += [f"- {r['project']}: {r['count']}건" for r in result['unknownDateTasks']] or ['- 해당 없음']
    lines += ['', f"충돌 작업 {result['taskConflicts']}건 / 미래 날짜 사용량 그룹 {len(result['futureDatedUsage'])}건 (누락 판정에서 제외)"]
    lines += ['', *result['limitations']]
    return '\n'.join(lines) + '\n'


def write_report(config, records, tasks, source_observed_at=None):
    """Diagnostic failures are visible but cannot authorize/block publishing."""
    state = Path(config['state'])
    observed_at = now().isoformat()
    try:
        runs = []
        for path in sorted((state / 'task-runs').glob('*.json')):
            if path.is_symlink():
                raise ValueError('Invalid task-run path')
            runs.append((path.stem, read(path)))
        result = diagnose(records, tasks, runs, observed_at)
        result['sourceObservedAt'] = source_observed_at
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        result = dict(schemaVersion=1, state='unavailable', generatedAt=observed_at,
                      errorType=type(error).__name__)
    try:
        atomic(state / 'task-record-diagnostics.json', result)
        path = state / 'task-record-diagnostics.txt'
        temporary = path.with_suffix('.tmp')
        temporary.write_text(render_text(result), encoding='utf-8')
        temporary.replace(path)
        result['reportPath'] = str(path)
    except OSError as error:
        result = dict(schemaVersion=1, state='unavailable', generatedAt=observed_at,
                      errorType=type(error).__name__)
    return result
