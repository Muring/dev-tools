# usage-report 초기 설정

## 시작 전에

일회성 로컬 집계에는 Python 3.10+와 본인 계정의 Codex·Claude 로그가 필요하다. 지속 수집·Git 저장소 동기화에는 Git과 접근 가능한 개인 KB 저장소가 추가로 필요하다. 블로그 전송은 수신 API와 KB workflow까지 준비된 환경에서만 설정한다.

아래 `<scripts>`는 설치된 이 스킬의 `scripts` 폴더다. Codex 기본 경로는 `~/.codex/skills/usage-report/scripts`이며 별도 CODEX_HOME이나 Claude 등록 경로를 쓰면 실제 경로로 바꾼다.

## 앱에서 준비하기

설치 완료 화면에서 해당 스킬을 펼치고 **내 환경에서 경로 찾기**를 누른다. 찾은 경로와 준비 옵션을 검토한 뒤 **준비할 변경 내용 확인**을 누른다. 대상과 작업을 확인했다는 체크를 선택하고 **확인한 환경 준비 실행**을 누르면 진행 단계와 결과 파일이 표시된다. 입력을 바꾸면 이전 확인은 무효가 된다. 실패·추가 확인 항목은 원인을 해결하고 새 계획으로 재시도한다.

로그 경로와 기존 기록·발행 설정 유무를 확인한다. 추적 초기화를 선택하면 기존 KB에서 원격을 fetch하고 usage-data 전용 worktree와 기기 설정을 만든다. 설치 화면은 기존 프로젝트 이름 설정을 변경하지 않는다. 기본 준비는 collect-local과 HTML 미리보기만 실행한다. 추적 설정을 만들지 않으면 일회성 집계 JSON을 만든다.

동기화·예약은 기본 선택 해제다. 자동 기록은 처음부터 선택할 수 있다. 첫 준비 실행에서는 설정과 HTML 보고서를 만들고 예약은 켜지 않는다. 결과 단계에서 보고서를 열어 양식을 승인하고, 예약 변경 내용을 확인한 뒤 **자동 기록 시작**을 누른다. 결과의 양식 식별값은 앱이 자동으로 사용한다. 경로 등 설정을 바꾸면 보고서를 다시 준비해야 한다. 기존 설정이 블로그 발행을 포함한 경우에만 발행 허용 선택지를 표시한다. 이 확인은 설정 존재만 의미하며 실제 연결 검증이 아니다. 수집 경고가 있으면 보고서까지만 만들고 선택한 동기화·예약을 보류한다. 스케줄러 활성 상태는 확인하지만 이후 모든 예약 실행의 성공까지 보장하지 않는다. 블로그 수신 API·workflow·인증정보의 새 연결은 아래 발행 가이드를 따른다.

설치 화면에서는 프로젝트 이름을 입력하지 않는다. 기본 이름으로 분석하며 기존에 저장한 프로젝트 매핑은 그대로 보존한다.

Git 동기화·자동 기록을 선택하면 필요한 기록 설정 준비도 함께 선택된다. 일회성 분석에서는 KB 경로 입력을 표시하지 않는다.

앱의 **이 기기의 사용량 기록 설정 저장**은 최초 설정만 만들며 자동 기록을 켜지 않는다. **사용량 자동 기록과 Git 동기화 켜기**는 두 동작을 함께 예약한다. **기존 블로그 발행 설정 사용 허용**은 기존 연동의 실행 허용이며 새 연결이나 인증 검증이 아니다. 블로그 초안의 저장소·인증 확인과 사용량 보고서 발행 연결은 별개다.

## 터미널에서 준비하기

새 설치기의 runtime에 `linux/skill_setup.py`가 포함된다. 같은 실행기를 터미널에서도 사용할 수 있다. `discover --skill <스킬명>`으로 후보를 확인하고, 선택한 옵션을 담은 요청 JSON으로 `preview --request <파일>`을 실행한다. 반환된 작업·대상을 검토한 뒤에만 `execute --id <계획 ID>`를 실행한다. 계획은 1시간 뒤 만료하며 계정별로 저장된다. 입력 JSON은 앱이 사용하는 것과 같고 비밀값 필드는 없다. 앱을 사용할 수 없으면 아래 개별 도구 순서를 따른다.

요청 JSON 예시다. 실제 경로·선택으로 바꿔 `~/skill-setup-request.json`에 저장한다.

```json
{"skill":"usage-report","path":"~/dev/muring-kb","initialize":true,"projects":{},"sync":false,"schedule":false}
```

```sh
PREP="$HOME/.local/share/dev-bootstrap/runtime/linux/skill_setup.py"
python3 "$PREP" discover --skill usage-report
python3 "$PREP" preview --request "$HOME/skill-setup-request.json"
# 출력의 작업·대기 사유를 확인한 뒤 해당 계획만 실행
python3 "$PREP" execute --id "확인한-계획의-id"
```

구형 EXE의 runtime에는 이 실행기가 없다. 새 설치기로 준비하거나 dev-tools checkout의 `linux/skill_setup.py`를 사용한다. 실제 실행 없이 상태만 확인하려면 discover·preview까지만 수행한다.

## 개별 도구로 준비하기

1. 먼저 로컬 집계만 실행해 로그를 읽는지 확인한다. 별도 설정 홈이나 Windows 로그를 쓰면 [스킬 본문](../SKILL.md)의 경로 설정을 적용한다. 로그가 없으면 사용량이 0이라는 뜻이 아니라 수집할 기록이 없는 상태다.

```sh
python3 <scripts>/usage_report.py --week --by project,tool,session --json
```

2. 지속 추적이 필요하면 본인이 접근할 수 있는 KB checkout을 지정해 초기화한다. 기존 설정이 있으면 다시 초기화하지 말고 `status`로 확인한다. 새 기기는 자기 기기 ID를 발급받으며 다른 PC의 설정 파일을 그대로 복사하지 않는다.

```sh
python3 <scripts>/usage_tracker.py init --repo /실제/KB/경로
python3 <scripts>/usage_tracker.py status
```

3. 생성된 `~/.config/ai-workflow/tracking.json`의 로그 roots와 프로젝트 별칭을 실제 경로에 맞춘다. 사용자 지정 `--config` 경로를 사용하면 이후 명령에도 지정한다. 상세 형식은 [지속 수집 안내](tracking.md)를 따른다.
4. 수집·보고서를 미리 확인한다. 누락·충돌·미분류가 있으면 먼저 원인을 확인한다.

```sh
python3 <scripts>/usage_tracker.py collect-local
python3 <scripts>/usage_tracker.py report --preview
```

5. Git 저장소 동기화를 원하면 원격 저장소·전송 범위를 확인하고 승인 후 `sync`를 실행한다. 로컬 분석만 필요하면 이 단계와 예약·발행은 생략한다.
6. 자동 실행을 원하면 보고서 양식을 보여주고 승인된 fingerprint로 `approve`를 실행한다. 실행 주기·대상에 대한 승인도 받은 뒤에만 `schedule --enable`을 사용한다. 정확한 명령과 OS별 확인은 [양식 승인과 자동화](tracking.md#양식-승인과-자동화)를 따른다.
7. 블로그 전송은 [Git 기반 일일 발행](git-publish.md)에 따라 KB main workflow·수신 API·권한·publisher 설정을 준비한다. 인증 정보는 해당 담당 환경에서 설정한다. 설정만으로 완료 처리하지 말고 실행 결과와 receipt로 DB 반영을 확인한다.

## 준비 완료 기준

로컬 분석은 집계 결과와 경고를 확인하면 된다. 지속 수집은 `run` 성공, 동기화는 `sync` 결과, 예약은 해당 OS 등록·실행 상태, 블로그 전송은 workflow와 receipt까지 각각 확인한다. 필요한 모드까지만 준비한다.

## 문제가 생기면

로그 경로·권한·기기 ID·프로젝트 매핑을 확인한다. 수집기가 실행 중이면 끝난 뒤 재시도한다. 충돌을 강제 push하거나 원본 로그를 삭제해 해결하지 않는다. 예약 환경이 꺼져 있으면 자동 수집이 실행되지 않는다.

## 설치 화면의 확인 범위

스킬 연결, Python 버전, 기본 경로의 추적 설정 파일 존재만 확인한다. 설정 내용의 유효성·사용자 지정 설정 경로·인증·동기화·예약·발행 성공은 별도로 확인해야 한다. 상단 상태 조회만으로 예약이나 전송을 활성화하지 않는다. 준비 실행에서 별도로 선택·확인한 동기화·예약만 실행한다.
