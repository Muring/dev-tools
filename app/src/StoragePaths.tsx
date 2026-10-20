import { useState } from 'react';
import { Select } from './Select';
import type { SetupDiscovery, SetupPath, SetupRequest } from '../electron/skill-setup-model';

export function StoragePaths({
  found,
  disabled,
  targets,
  preserve,
  discover,
  onChange,
}: {
  found?: SetupDiscovery;
  disabled: boolean;
  targets?: SetupPath[];
  preserve: SetupPath[];
  discover(): Promise<void>;
  onChange(value: Partial<SetupRequest>): void;
}) {
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<'linux' | 'windows'>('linux');
  const [kind, setKind] = useState<SetupPath['kind']>('directory');
  const [purpose, setPurpose] = useState<'targets' | 'preserve'>('targets');
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const selected = targets ?? found?.targets ?? [];
  function add() {
    const value = path.trim();
    const valid =
      platform === 'linux'
        ? /^(\/|~\/).+/.test(value) && !/[\x00-\x1f]/.test(value)
        : /^[A-Za-z]:\\[^\x00-\x1f<>"|?*]+$/.test(value);
    if (!valid) {
      setError(
        platform === 'linux'
          ? 'Ubuntu 절대 경로를 입력하세요. 예: /home/me/data'
          : 'Windows 절대 경로를 입력하세요. 예: D:\\data',
      );
      return;
    }
    const entries = purpose === 'targets' ? selected : preserve;
    if (
      entries.some(
        entry =>
          entry.platform === platform &&
          (platform === 'windows' ? entry.path.toLowerCase() === value.toLowerCase() : entry.path === value),
      ) ||
      (purpose === 'preserve' && found?.preserve.includes(value))
    ) {
      setError('이미 목록에 있는 경로입니다.');
      return;
    }
    if (entries.length + (purpose === 'preserve' ? (found?.preserve.length ?? 0) : 0) >= 30) {
      setError('각 목록에는 최대 30개 경로를 지정할 수 있습니다.');
      return;
    }
    onChange({
      [purpose]: [...entries, { platform, path: value, kind: purpose === 'targets' ? kind : 'directory' }],
    });
    setPath('');
    setError('');
  }
  return (
    <section className="setup-storage-paths" aria-label="진단·보존 위치 직접 지정">
      <button
        type="button"
        aria-expanded={open}
        onClick={async () => {
          setOpen(!open);
          if (!open && !found) await discover();
        }}>
        {open ? '직접 지정 접기' : '진단·보존 위치 직접 지정'}
        {targets !== undefined || preserve.length ? ' · 변경 있음' : ''}
      </button>
      {open &&
        (found ? (
          <>
            <p>
              변경 확인 단계에서 선택한 진단 경로의 존재 여부와 접근 상태를 검사합니다. 보존 위치는 아직 없는
              폴더도 등록할 수 있습니다.
            </p>
            <h4>진단할 위치 ({selected.length}개)</h4>
            <ul className="setup-storage-list">
              {selected.map((entry, index) => (
                <li key={entry.platform + entry.path}>
                  <span>
                    {entry.platform === 'windows' ? 'Windows' : 'Ubuntu'} · {entry.path}
                  </span>
                  <button
                    type="button"
                    aria-label={`${entry.path} 진단 제외`}
                    onClick={() => onChange({ targets: selected.filter((_, i) => i !== index) })}>
                    제외
                  </button>
                </li>
              ))}
            </ul>
            {!selected.length && <p role="alert">진단할 위치를 하나 이상 추가하세요.</p>}
            <h4>추가로 보존할 위치 ({preserve.length}개)</h4>
            <p className="muted">
              기본 보호 경로와 기존 보존 설정은 유지합니다. 아래에서 이번에 추가한 위치만 취소할 수 있습니다.
            </p>
            <ul className="setup-storage-list">
              {preserve.map((entry, index) => (
                <li key={entry.platform + entry.path}>
                  <span>
                    {entry.platform === 'windows' ? 'Windows' : 'Ubuntu'} · {entry.path}
                  </span>
                  <button
                    type="button"
                    aria-label={`${entry.path} 추가 보존 취소`}
                    onClick={() => onChange({ preserve: preserve.filter((_, i) => i !== index) })}>
                    추가 취소
                  </button>
                </li>
              ))}
            </ul>
            <div className="setup-path-controls">
              <Select
                label="추가할 목록"
                value={purpose}
                disabled={disabled}
                options={[
                  { value: 'targets', label: '진단할 위치' },
                  { value: 'preserve', label: '보존할 위치' },
                ]}
                onChange={value => {
                  setPurpose(value as typeof purpose);
                  setError('');
                }}
              />
              <Select
                label="경로 환경"
                value={platform}
                disabled={disabled}
                options={[
                  { value: 'linux', label: 'Ubuntu' },
                  { value: 'windows', label: 'Windows' },
                ]}
                onChange={value => {
                  setPlatform(value as typeof platform);
                  setError('');
                }}
              />
              {purpose === 'targets' && (
                <Select
                  label="대상 종류"
                  value={kind || 'directory'}
                  disabled={disabled}
                  options={[
                    { value: 'directory', label: '폴더' },
                    { value: 'file', label: '파일' },
                    { value: 'vhd', label: '가상 디스크 (VHD)' },
                  ]}
                  onChange={setKind}
                />
              )}
            </div>
            <label className="setup-field">
              추가할 경로
              <input
                value={path}
                placeholder={platform === 'linux' ? '/home/me/data' : 'D:\\data'}
                onChange={e => {
                  setPath(e.target.value);
                  setError('');
                }}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <div className="actions">
              <button type="button" onClick={add}>
                목록에 추가
              </button>
              <button
                type="button"
                onClick={() => {
                  onChange({ targets: undefined, preserve: [] });
                  setError('');
                }}>
                자동 탐색 목록으로 되돌리기
              </button>
            </div>
          </>
        ) : (
          <p>경로를 확인하고 있습니다. 결과가 나오지 않으면 ‘내 환경에서 경로 찾기’를 다시 눌러주세요.</p>
        ))}
    </section>
  );
}
