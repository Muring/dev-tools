# storage-maintenance 초기 설정

## 시작 전에

Ubuntu의 Python 3.10+와 `du`, `df`, `findmnt`, `git`을 사용한다. Windows 진단은 WSL에서 Windows PowerShell 5.1 수집기를 호출한다. 기본 진단은 읽기 전용이며 계정·외부 서비스 인증이 필요하지 않다.

아래 `<scripts>`는 이 스킬의 `scripts` 폴더다. Codex 기본 경로는 `~/.codex/skills/storage-maintenance/scripts`이며 다른 등록 경로를 쓰면 실제 경로로 바꾼다.

## 앱에서 준비하기

설치 완료 화면에서 **저장공간 진단 준비하기**를 선택하고 **내 환경에서 경로 찾기**를 누른다. 찾은 경로와 준비 옵션을 검토한 뒤 **준비할 변경 내용 확인**을 누른다. 대상과 작업을 확인했다는 체크를 선택하고 **확인한 환경 준비 실행**을 누르면 진행 단계와 결과 파일이 표시된다. 입력을 바꾸면 이전 확인은 무효가 된다. 실패·추가 확인 항목은 원인을 해결하고 새 계획으로 재시도한다.

Linux와 Windows의 진단 대상 후보를 찾아 보여준다. 기본은 자동 탐색이며 기존 대상 설정이 있으면 우선 사용한다. **진단·보존 위치 직접 지정**에서 Ubuntu/Windows와 대상 종류를 선택해 진단 경로를 추가·제외하고 보존할 경로를 추가할 수 있다. 변경 확인 단계에서 진단 경로의 존재·종류·접근 상태를 검사하며 확인하지 못한 경로는 수정하거나 제외한 뒤 진행한다. 보존 경로는 아직 존재하지 않아도 등록할 수 있다. 기존 보존 경로와 개발·도구 설정 폴더의 기본 보호 목록을 함께 유지한다. 자동 탐색 목록과 직접 지정한 최종 목록을 확인한 뒤 준비 실행을 선택하면 개인 설정을 저장하고 첫 진단을 실행한다. 기존 설정을 바꿀 때는 백업하며 기존 보존 경로를 제거하지 않는다. **진단 결과 (JSON) 열기**에서 스냅샷의 완료·부분 측정을 확인한다. **설정 수정**은 선택한 경로를 유지하며, **스킬 선택으로 돌아가기**는 준비 화면을 종료한다. 설치 화면에서는 첫 진단까지만 제공한다. 예약 계획 생성은 아래 터미널 절차에서 별도로 사용할 수 있으며 OS에 등록하거나 활성화하지 않는다. 삭제·앱 종료·WSL 압축은 준비 기능에서 실행하지 않는다.

## 터미널에서 준비하기

새 설치기의 runtime에 `linux/skill_setup.py`가 포함된다. 같은 실행기를 터미널에서도 사용할 수 있다. `discover --skill <스킬명>`으로 후보를 확인하고, 선택한 옵션을 담은 요청 JSON으로 `preview --request <파일>`을 실행한다. 반환된 작업·대상을 검토한 뒤에만 `execute --id <계획 ID>`를 실행한다. 계획은 1시간 뒤 만료하며 계정별로 저장된다. 입력 JSON은 앱이 사용하는 것과 같고 비밀값 필드는 없다. 앱을 사용할 수 없으면 아래 개별 도구 순서를 따른다.

요청 JSON 예시다. 실제 경로·선택으로 바꿔 `~/skill-setup-request.json`에 저장한다.

```json
{"skill":"storage-maintenance","targets":[{"platform":"linux","path":"~/.cache","kind":"directory"}],"preserve":[{"platform":"linux","path":"~/dev"}],"schedulePlan":true}
```

```sh
PREP="$HOME/.local/share/dev-bootstrap/runtime/linux/skill_setup.py"
python3 "$PREP" discover --skill storage-maintenance
python3 "$PREP" preview --request "$HOME/skill-setup-request.json"
# 출력의 작업·대기 사유를 확인한 뒤 해당 계획만 실행
python3 "$PREP" execute --id "확인한-계획의-id"
```

구형 EXE의 runtime에는 이 실행기가 없다. 새 설치기로 준비하거나 dev-tools checkout의 `linux/skill_setup.py`를 사용한다. 실제 실행 없이 상태만 확인하려면 discover·preview까지만 수행한다.

## 개별 도구로 준비하기

1. 대상 Ubuntu 터미널에서 Python과 도구를 확인한다.

```sh
python3 --version
command -v du df findmnt git powershell.exe
```

2. 기본 대상으로 읽기 전용 진단을 실행한다. Windows 경로를 WSL의 `du`로 직접 순회하지 않는다.

```sh
python3 <scripts>/storage.py scan
```

3. 결과에서 완료·부분 측정·접근 실패를 구분한다. 기본 스냅샷은 `~/.local/state/storage-audit`에 저장된다. 하루 또는 일주일 뒤 다시 측정하면 `compare --period day` 또는 `compare --period week`로 비교한다. 첫 실행에는 비교 기준이 없을 수 있다.
4. 추가 대상이 필요하면 [설정과 보존 정책](operations.md#설정과-보존-정책)의 JSON 예시로 개인 설정 파일을 만들고 실제 경로를 넣는다. 실행 중인 프로젝트·캐시·고유 자료를 `preserve`에 명시한다. 예시 경로와 소유 확인 값을 그대로 사용하지 않는다.
5. 정리가 필요할 때만 `plan --config <설정 파일> --output <계획 파일>`을 실행한다. 정확한 경로·소유 작업·현재 사용 여부·보존 대상을 검토한다.
6. [계획과 승인 절차](operations.md#계획-승인-dry-run-실행)에 따라 승인받은 항목만 승인 파일에 넣고 `apply`로 모의 실행한다. 실제 삭제 승인 뒤에만 `--execute`를 붙인다. 진단을 시작한 것은 삭제·앱 종료·WSL 압축 승인이 아니다.
7. 정기 진단이 필요하면 `schedule-plan`으로 예약안을 확인한다. 주기·대상 승인 후 OS에 읽기 전용 scan만 등록한다. 이 명령 자체는 예약을 활성화하지 않는다.

## 준비 완료 기준

기본 진단 결과가 생성되고 실패·미상 범위를 확인했으면 진단을 사용할 수 있다. 모든 경로를 읽을 수 있어야만 시작 가능한 것은 아니다. 정리·예약은 선택 기능이며 기본 진단 준비와 따로 판단한다.

## 문제가 생기면

Windows PowerShell이 없거나 WSL 연동이 끊겼으면 Windows 측정 범위를 미확인으로 남긴다. 권한 오류를 사용량 0으로 해석하지 않는다. 활성 여부를 확인할 수 없는 경로는 삭제하지 않는다. WSL 압축은 별도의 중단·백업·승인이 필요한 작업이다.

## 설치 화면의 확인 범위

스킬 연결, Python 버전, 진단 명령의 PATH 존재 여부만 확인한다. 상단 상태 조회는 스캔이나 삭제를 하지 않는다. 준비 실행을 선택하면 선택한 경로를 실제 scan하고 결과를 표시한다. 파일 삭제는 실행하지 않는다.
