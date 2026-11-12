# 출장서류 검증 및 여비 산정 시스템

## 로컬 FastAPI 실행

PowerShell에서 이 폴더로 이동해 실행합니다. Python 3.10 이상을 권장합니다.

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe local_server.py
```

서버 시작 시 Upstage API 키를 입력합니다. 이미 `UPSTAGE_API_KEY` 환경변수가 설정돼 있으면 그 값을 사용합니다. 키 입력을 건너뛰면 로그인과 폴더 선택을 확인할 수 있습니다.

1. [로컬 관리자 화면](http://127.0.0.1:8000/)을 열고 서버 터미널에 표시된 **Local login password**로 로그인합니다.
2. **폴더 선택**에서 바탕화면의 폴더로 이동해 **현재 폴더 사용**을 누르거나, **PDF 직접 등록**으로 전환해 PDF를 목록에 끌어 놓습니다. 직접 등록 화면의 **파일등록** 버튼으로도 PDF를 고를 수 있습니다.
3. **PDF 직접 등록**에서는 검증할 파일 옆 체크박스를 선택한 뒤 **검증실행**을 누릅니다. **폴더 선택**에서는 지정한 폴더의 PDF 전체가 대상입니다. FastAPI가 대상 PDF에 `workflow_test.py`의 Upstage 워크플로우를 실행하고, 출장 내역과 검토 사항을 하나의 엑셀로 만듭니다. PDF는 검증 시 Upstage로 전송됩니다.
4. **처리내역조회**에서 처리번호를 누르면 해당 행 바로 아래에 정산서가 펼쳐집니다. 같은 번호를 다시 누르면 접힙니다. **조회** 버튼은 검토내용을 포함한 **정산결과조회**로 이동합니다.
5. 엑셀을 받으려면 **처리내역조회** 아래 **엑셀에 포함할 PDF**에서 파일을 체크하고 **선택 PDF 엑셀다운로드**를 누릅니다. 여러 실행에서 파일을 고를 수 있으며 페이지를 넘기거나 검색 조건을 바꿔도 같은 화면에서 체크한 파일은 선택에 남습니다.

폴더 선택은 로그인 세션에 저장됩니다. 서버를 종료하면 세션과 처리 결과가 초기화되므로 필요한 엑셀은 종료 전에 내려받으세요.

구형 공공기관 업무 화면을 재현한 프론트엔드입니다. 실제 PDF 처리와 엑셀 생성은 로컬 FastAPI 서버에서 실행합니다.

## 바로 실행

압축을 풀고 `index.html`을 Chrome 또는 Edge에서 열면 됩니다. 패키지 설치나 빌드 없이 시연 모드가 실행됩니다. HTML만 옮기지 말고 `css`, `js`, `samples` 폴더를 함께 보관하세요.

1. `파일등록`에서 PDF 여러 개를 선택합니다. `samples` 폴더에 가상의 출장신청서와 출장복명서가 있습니다.
2. 추가 등록·체크 선택·선택삭제·전체삭제·개별 미리보기를 사용할 수 있습니다. 파일 목록에 PDF를 끌어 놓아도 등록됩니다.
3. `시연결과`를 선택하고 `검증실행`을 누릅니다. 처리 중에는 중복 실행과 등록·삭제가 차단됩니다. 체크 여부와 관계없이 등록된 PDF 전체를 한 번에 접수합니다.
4. 처리내역에서 결과를 조회하고 정산서·검토내용을 확인합니다. 엑셀 예시는 `samples` 폴더의 시연용 XLSX에서 확인할 수 있습니다.

시연 모드의 처리내역·판정·금액은 업로드 내용과 무관한 가상 데이터입니다. PDF를 분석하거나 정산 규칙을 계산하지 않습니다. 화면과 XLSX의 시연 표기를 확인하세요. 등록 파일과 이번 실행 내역은 메모리에만 있으며 새로고침하면 초기화됩니다. 시연 초기 예시 내역은 다시 나타납니다.

## 별도 서버에 파일 업로드로 연동

`js/config.js`의 다음 항목을 수정한 뒤 페이지를 새로고침합니다.

```js
mode: 'api',
apiBaseUrl: 'http://127.0.0.1:8000',
endpoints: {
  create: '/api/verification/batches',
  status: '/api/verification/batches/{id}',
  excel: '/api/verification/batches/{id}/excel'
},
fileField: 'files'
```

이 경로는 제안값입니다. 서버와 협의한 경로·필드명으로 변경할 수 있습니다. 같은 서버에서 화면과 API를 제공한다면 `apiBaseUrl: ''`을 사용합니다. 응답 규격이 다르면 `responseAdapter` 또는 `js/api.js`의 `normalizeBatch()`에서 변환합니다. UI와 CSS는 수정할 필요가 없습니다. API 모드에는 시연 처리내역이 나타나지 않습니다.

API 모드는 `file://` 대신 HTTP로 실행합니다. Python이 설치된 환경에서는 프로젝트 폴더에서 다음 명령을 실행합니다.

```powershell
python -m http.server 8080
```

브라우저에서 `http://localhost:8080`으로 접속합니다. 이 명령은 화면만 제공하며 검증 서버를 실행하지는 않습니다.

FastAPI가 정적 파일도 제공할 경우 기존 API 경로를 등록한 뒤 정적 경로를 마지막에 연결합니다.

```python
from pathlib import Path
from fastapi.staticfiles import StaticFiles

# app = FastAPI(), API 라우터 등록 이후 실행
frontend_dir = Path(__file__).parent / "travel-admin"
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
```

프론트엔드와 API의 출처가 다르면 서버에 CORS를 설정합니다. `http://localhost:8080` 등 실제 허용할 출처만 지정하고, 쿠키 인증 시 `credentials: 'include'`와 서버의 `allow_credentials=True`를 함께 사용합니다. 다운로드 파일명을 읽으려면 `Content-Disposition`을 노출 응답 헤더로 지정합니다. 자세한 응답 예시는 `API_CONTRACT.md`에 있습니다.

## 설정과 제한

| 항목 | 기본값 / 처리 |
|---|---|
| 동작 모드 | `demo`; `api`로 변경 후 새로고침 |
| PDF 수 / 파일 크기 | `maxFiles: 50`, 개당 `maxFileSizeBytes: 25 MiB` |
| 중복 파일 | 파일명·크기·최종수정시각이 동일한 항목은 중복 등록하지 않음 |
| 처리 상태 조회 | 1.5초 간격, 최대 10분 (`pollIntervalMs`, `maxPollDurationMs`) |
| 단일 HTTP 요청 제한 | 60초 (`requestTimeoutMs`) |
| 자료 보관 | 현재 페이지 메모리; 새로고침 시 초기화 |
| PDF 미리보기 | 브라우저 내장 PDF 뷰어; 지원하지 않는 브라우저에서는 `PDF 새 창 열기` 사용 |

클라이언트 파일 검사는 편의 기능입니다. 별도 서버에서도 크기·형식·권한을 재검사해야 합니다. 시연 모드의 헤더 관리자 정보는 시연용 표시입니다.

Upstage API 키와 다른 비밀값은 프론트엔드에 입력하지 않습니다. FastAPI의 환경변수 또는 서버 비밀 저장소에 보관하고 서버에서만 Upstage를 호출합니다. 서버 오류 응답에도 키나 내부 디버깅 정보를 포함하지 않아야 합니다.

## 파일 구성

```text
travel-admin/
├── index.html             화면 구조
├── css/style.css          공공기관 관리자 테마
├── js/config.js           모드·주소·경로·제한 설정
├── js/api.js              다중 업로드·상태조회·엑셀 응답 처리
├── js/demo.js             시연 전용 가상 처리내역
├── js/excel.js            시연 전용 XLSX 생성
├── js/app.js              파일목록·조회·결과 화면 제어
├── samples/               가상 PDF 2개 및 실제 다운로드한 시연 XLSX
├── API_CONTRACT.md        백엔드 협의용 연동 규격
├── VERIFICATION.md        확인 항목 및 검증 범위
└── README.md
```

원본 워크플로우를 프론트엔드에 배포할 필요는 없습니다. 제공된 워크플로우 JSON은 최종 결과 구조 확인에만 참고했으며 배포 소스에 API 키나 워크플로우 내부 프롬프트를 포함하지 않았습니다.

처리내역의 날짜·상태·판정·처리번호/파일명 조건은 `조회`로 적용됩니다. `오늘`, `1개월`(최근 30일), `전체`는 날짜 조건을 즉시 적용합니다. 새 검증 접수 시 검색 조건을 초기화하여 새 작업을 표시합니다. 처리내역을 1건 체크하면 `선택결과조회`를 사용할 수 있습니다.

접수 응답이 끊기면 자동 재전송하지 않습니다. 서버 접수 여부를 먼저 확인하십시오. 처리번호를 받은 이후 상태 조회가 실패하거나 10분을 넘기면 해당 번호를 유지하며 `상태재조회`로 다시 확인할 수 있습니다. 조회 중단은 서버 작업 취소를 뜻하지 않습니다. 새로고침하면 현재 페이지의 처리번호도 사라지므로 장시간 실행 중에는 페이지를 유지합니다.
