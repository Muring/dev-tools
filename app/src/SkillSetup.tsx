import { useState } from 'react';
import type { SkillReadiness } from '../electron/model';
import { SkillSetupWizard, SetupActions } from './SkillSetupWizard';
import type { SetupSkill } from '../electron/skill-setup-model';

const guides = [
  {
    id: 'blog-draft',
    title: '블로그 초안',
    purpose: '블로그 저장소를 연결하고 인증값을 준비합니다.',
    checks: [
      ['blogSkill', '공용 명령 연결'],
      ['blogProject', '블로그 저장소'],
      ['blogDependencies', '이미지 처리 패키지'],
    ],
    note: '위 상태는 저장된 블로그 경로의 파일·패키지를 확인한 결과입니다. 새로 입력한 경로는 준비 실행 후 반영됩니다. DB·이미지 버킷 연결 검사는 아래 준비 실행 결과에서 확인하세요.',
  },
  {
    id: 'usage-report',
    title: '사용량 분석',
    purpose: '이 기기의 사용량을 확인하고, 필요하면 자동 기록을 설정합니다.',
    checks: [
      ['usageSkill', '공용 명령 연결'],
      ['python', 'Python 3.10 이상'],
      ['trackingConfig', '사용량 기록 설정 (선택)'],
    ],
    note: '일회성 분석에는 추적 설정이 없어도 됩니다. 기본 상태 표는 설정 파일 존재만 확인하며, 수집·동기화·예약 결과는 준비 실행 결과에서 따로 확인합니다.',
  },
  {
    id: 'storage-maintenance',
    title: '저장공간 진단',
    purpose: '삭제 없이 저장공간을 살펴보고 진단 보고서를 만듭니다.',
    checks: [
      ['storageSkill', '공용 명령 연결'],
      ['python', 'Python 3.10 이상'],
      ['storageTools', 'Linux 진단 도구'],
      ['powershell', 'Windows 진단 도구'],
    ],
    note: '기본 상태 표는 명령 경로만 확인합니다. 준비 실행을 선택하면 실제 스캔 결과를 확인할 수 있습니다. 삭제·앱 종료·WSL 압축은 별도 작업입니다.',
  },
];

export function SkillSetup({
  readiness,
  busy,
  refresh,
  openGuide,
  onOpen,
  ...setupActions
}: SetupActions & {
  onOpen?(): void;
  readiness?: SkillReadiness;
  busy: boolean;
  refresh(): void;
  openGuide(skill: string): void;
}) {
  const [active, setActive] = useState<SetupSkill>();
  const [showingResult, setShowingResult] = useState(false);
  const guide = guides.find(item => item.id === active);
  if (guide)
    return (
      <section className="card skill-setup setup-workspace" aria-label="스킬 실행환경 준비">
        <div className="setup-workspace-heading">
          <div>
            <h2>{guide.title}</h2>
            {busy && <p role="status">환경 준비 작업을 처리하고 있습니다…</p>}
            <p>
              {showingResult
                ? '준비 결과를 확인하세요. 다른 스킬로 이동해도 저장한 설정과 보고서는 유지됩니다.'
                : '준비를 취소하면 편집 중인 입력을 지웁니다. 이미 저장한 설정·예약은 유지됩니다.'}
            </p>
          </div>
          <button disabled={busy} onClick={() => setActive(undefined)}>
            {showingResult ? '스킬 선택으로 돌아가기' : '준비 취소 · 스킬 선택'}
          </button>
        </div>
        <SkillSetupWizard
          key={guide.id}
          skill={guide.id as SetupSkill}
          busy={busy}
          onResultChange={setShowingResult}
          {...setupActions}
          readinessContent={
            <details className="setup-readiness">
              <summary>
                설치 상태와 확인 범위{' '}
                <span>
                  {
                    guide.checks.filter(
                      ([key]) => key !== 'trackingConfig' && readiness?.checks[key] === true,
                    ).length
                  }
                  /{guide.checks.filter(([key]) => key !== 'trackingConfig').length}개 확인
                </span>
              </summary>
              <dl className="setup-checks">
                {guide.checks.map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>
                      {readiness?.checks[key] === true
                        ? '확인됨'
                        : readiness?.checks[key] === false
                          ? key === 'trackingConfig'
                            ? '아직 설정하지 않음 · 일회성 분석 가능'
                            : '준비 필요'
                          : '미확인'}
                    </dd>
                  </div>
                ))}
              </dl>
              <p>{guide.note}</p>
              <div className="actions">
                <button disabled={busy} onClick={refresh}>
                  준비 상태 다시 확인
                </button>
                <button disabled={busy} onClick={() => openGuide(guide.id)}>
                  {guide.title} 전체 가이드 열기
                </button>
              </div>
            </details>
          }
        />
      </section>
    );
  return (
    <section className="card skill-setup" aria-label="스킬 실행환경 준비">
      <h2>준비할 스킬 선택</h2>
      <p>사용할 기능만 선택하세요. 건너뛰어도 개발 도구 설치는 완료된 상태입니다.</p>
      <div className="setup-skill-list">
        {guides.map(item => (
          <div className="setup-skill-choice" key={item.id}>
            <div>
              <h3>{item.title}</h3>
              <p>{item.purpose}</p>
            </div>
            <button
              disabled={busy}
              onClick={() => {
                onOpen?.();
                setShowingResult(false);
                setActive(item.id as SetupSkill);
              }}>
              {item.title} 준비하기
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
