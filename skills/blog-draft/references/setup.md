# blog-draft 초기 설정

## 시작 전에

이 명령은 mublog 전용 초안 작성 도구다. 새 블로그를 생성하지 않는다. 접근 권한이 있는 mublog 저장소, Node·Yarn, 블로그 DB 연결이 필요하다. 이미지 업로드에는 해당 저장소의 스토리지 설정도 필요하다.

## 앱에서 준비하기

설치 완료 화면에서 해당 스킬을 펼치고 **내 환경에서 경로 찾기**를 누른다. 찾은 경로와 준비 옵션을 검토한 뒤 **준비할 변경 내용 확인**을 누른다. 대상과 작업을 확인했다는 체크를 선택하고 **확인한 환경 준비 실행**을 누르면 진행 단계와 결과 파일이 표시된다. 입력을 바꾸면 이전 확인은 무효가 된다. 실패·추가 확인 항목은 원인을 해결하고 새 계획으로 재시도한다.

기존 저장소를 선택하거나, 폴더가 없으면 인증 정보 없는 GitHub HTTPS 주소로 clone할 수 있다. 의존성 설치를 선택하면 해당 프로젝트에서 yarn install을 실행한다. 저장한 경로는 이후 스킬이 MUBLOG_DIR이 없을 때 재사용한다.

**블로그 인증값 입력**에서 아래 값을 입력하고 변경 내용을 확인한 뒤 실행하면 선택한 저장소의 `.env`를 자동 생성하거나 빈 항목을 채운다.

| 입력 항목 | 용도와 찾는 위치 |
|---|---|
| DATABASE_URL | 글을 저장하는 DB 연결 주소. Supabase 프로젝트의 Connect → Transaction pooler에서 복사하고 DB 비밀번호를 채운다. mublog는 포트 6543과 pgbouncer=true를 사용한다. 비밀번호의 특수문자는 URL 인코딩한다. |
| NEXT_PUBLIC_SUPABASE_URL | 이미지 저장소의 프로젝트 URL. 같은 프로젝트의 Connect에서 Project URL을 복사한다. |
| SUPABASE_SECRET_KEY | 이미지 저장소에 접근하는 서버용 키. Settings → API Keys의 Secret key를 사용한다. publishable 키나 계정 비밀번호가 아니다. |

찾는 위치는 [Supabase DB 연결 안내](https://supabase.com/docs/guides/database/connecting-to-postgres)와 [API 키 안내](https://supabase.com/docs/guides/getting-started/api-keys)를 참고한다. 프로젝트 권한이 없으면 관리자에게 요청한다.

입력칸은 마스킹되며 계획·로그·앱 상태에는 실제 값을 저장하지 않는다. 실행 시 표준 입력으로 전달하고 실행 후 입력칸을 비운다. 대상 경로를 바꿔도 입력값을 비운다. `.env`는 소유자만 읽고 쓸 수 있는 권한으로 저장하고 `.gitignore`에 `/.env`를 추가한다. Git에서 이미 추적하는 `.env`, 링크 파일, 중복·여러 줄 설정은 자동 수정하지 않는다. 기본 입력에서는 기존에 값이 있는 항목을 비워 유지한다. 연결 실패 결과의 수정 흐름에서 교체에 동의한 항목만 덮어쓴다. 다른 설정과 주석은 보존한다.

화면의 **직접 설정할 때 사용할 .env 예시**에서도 형식을 볼 수 있다. 아래 값은 예시이며 실제 인증값이 아니다.

```dotenv
DATABASE_URL='postgresql://postgres.PROJECT:비밀번호@HOST:6543/postgres?pgbouncer=true'
NEXT_PUBLIC_SUPABASE_URL='https://프로젝트-ID.supabase.co'
SUPABASE_SECRET_KEY='sb_secret_실제키'
```

저장 후 DB 접속·SELECT 1 실행과 Supabase post-images 버킷 정보 조회를 수행하고 항목별 결과를 표시한다. 블로그 의존성(pg, @supabase/supabase-js)이 필요하다. 실패하거나 값이 없으면 추가 확인 필요로 표시한다. 읽기 연결 성공과 글 등록·업로드 권한은 구분한다. 설치에서는 초안 파일을 요구하지 않으며 실제 글 등록·이미지 업로드를 실행하지 않는다. 터미널 실행기의 선택 draft 인자로 DB 읽기를 포함한 dry-run을 실행할 수 있다.

## 터미널에서 준비하기

새 설치기의 runtime에 `linux/skill_setup.py`가 포함된다. 같은 실행기를 터미널에서도 사용할 수 있다. `discover --skill <스킬명>`으로 후보를 확인하고, 선택한 옵션을 담은 요청 JSON으로 `preview --request <파일>`을 실행한다. 반환된 작업·대상을 검토한 뒤에만 `execute --id <계획 ID>`를 실행한다. 계획은 1시간 뒤 만료하며 계정별로 저장된다. 계획 요청 JSON에는 비밀값을 넣지 않는다. 앱은 credentialKeys에 항목 이름만 보내고 실행 시 --credentials-stdin으로 값을 별도 전달한다. 인증값을 명령행 인자나 요청 JSON 파일에 넣지 않는다. 앱을 사용할 수 없으면 아래 개별 도구 순서를 따른다.

요청 JSON 예시다. 실제 경로·선택으로 바꿔 `~/skill-setup-request.json`에 저장한다.

```json
{"skill":"blog-draft","path":"~/dev/mublog","installDependencies":true,"draft":""}
```

```sh
PREP="$HOME/.local/share/dev-bootstrap/runtime/linux/skill_setup.py"
python3 "$PREP" discover --skill blog-draft
python3 "$PREP" preview --request "$HOME/skill-setup-request.json"
# 출력의 작업·대기 사유를 확인한 뒤 해당 계획만 실행
python3 "$PREP" execute --id "확인한-계획의-id"
```

구형 EXE의 runtime에는 이 실행기가 없다. 새 설치기로 준비하거나 dev-tools checkout의 `linux/skill_setup.py`를 사용한다. 실제 실행 없이 상태만 확인하려면 discover·preview까지만 수행한다.

## 개별 도구로 준비하기

1. GitHub 로그인 후 본인이 사용하는 mublog 저장소를 Ubuntu에 clone한다. 저장소 주소는 소유자에게 확인한다. 기존 checkout이 있으면 재사용하고 덮어쓰지 않는다.
2. 앱에서 저장한 경로가 없을 때 기본 위치는 `~/dev/mublog`다. 다른 위치라면 이 스킬을 실행할 터미널에 `export MUBLOG_DIR="/실제/블로그/경로"`를 설정한다. 계속 사용하려면 해당 셸의 개인 설정에 넣는다.
3. 블로그 폴더의 README·프로젝트 지침에 따라 의존성을 설치한다. 해당 저장소의 Yarn 버전을 사용한다. `package.json`에 `draft:post` 명령이 있는지, 기존 글이 `backup/posts`에 있는지 확인한다.
4. 저장소의 환경변수 안내에 따라 DB·스토리지 설정을 준비한다. 현재 초안 등록 스크립트는 `.env` 또는 실행 환경에서 값을 읽는다. `.env.local`만 설정한 경우 CLI에서도 읽는다고 가정하지 않는다. 비밀값은 승인된 비밀 저장소에서 받아 로컬에 설정하며 채팅·Git·로그에 붙이지 않는다.
5. 기존 글과 썸네일을 확인하고 초안 MDX를 준비한다. 실제 등록 전에 아래 모의 검사를 실행한다. 이 검사는 DB에서 slug 중복도 조회하므로 DB 접근이 필요하지만 글을 저장하지 않는다.

```sh
cd "${MUBLOG_DIR:-$HOME/dev/mublog}"
yarn draft:post "/초안/경로/새-slug.mdx" --dry-run
```

6. 검사가 통과하고 초안 등록을 요청받은 경우에만 `--dry-run`을 빼고 실행한다. 이미지 업로드는 별도 요청 범위에서 스킬의 이미지 절차를 따른다.

## 준비 완료 기준

저장소·의존성·기준 글이 있고, 실제 초안의 dry-run이 통과해야 초안 등록 준비가 됐다고 판단한다. 환경 파일 존재만으로 인증 성공을 판단하지 않는다. 이미지 기능은 스토리지 연결을 별도로 검증한다.

## 문제가 생기면

경로 오류는 `MUBLOG_DIR`, 모듈 오류는 프로젝트 의존성, DB 오류는 연결 정보·권한을 확인한다. 기존 slug를 임의로 덮어쓰지 않는다. 수정 요청인 경우에만 스킬의 `--update` 절차를 사용한다.

## 설치 화면의 확인 범위

상단 준비 상태는 저장한 블로그 경로, 기본 경로 또는 검사 프로세스에 전달된 MUBLOG_DIR의 파일 존재를 확인한다. 터미널에만 설정된 다른 경로는 앱이 모를 수 있다. 준비 실행 시 입력한 인증값을 .env에 저장하고 필요한 변수의 값 유무와 실제 읽기 연결 검사 결과를 구분해 표시한다. 비밀값은 결과에 포함하지 않는다. 초안 없이 SELECT 1과 버킷 정보 조회로 연결을 검사하며 DB 쓰기·파일 업로드·삭제는 하지 않는다. 실제 작업 절차는 [스킬 본문](../SKILL.md)을 따른다.

### 연결 실패 후 인증값 수정

실행 결과의 **인증값 수정**을 누르면 기존 입력 단계로 돌아간다. 붉게 표시된 연결 항목의 새 값만 입력한다. 빈 항목과 다른 설정은 유지한다. 기존 인증값 교체에 동의하고 변경 내용을 확인한 뒤 실행하면 `.env`의 승인된 항목만 교체하고 DB·버킷 연결을 다시 검사한다. 값 변경 시 교체 동의가 해제되며, 경로 변경·취소·실행 시 입력값은 비운다. 기존 비밀값은 화면·계획·결과에 표시하지 않는다. 계획 확인 후 `.env`가 변경되면 실행을 중단한다. 실행 프로세스의 환경변수가 `.env`보다 우선하는 경우 해당 환경변수를 수정하거나 해제하라는 안내를 표시한다.
