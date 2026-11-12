# FastAPI 연동 명세 (협의용)

## 로컬 폴더 방식

`local_server.py`는 `http://127.0.0.1:8000`에서 관리자 화면과 API를 함께 제공합니다. 변경 요청은 해당 출처의 `Origin` 헤더를 사용합니다.

| API | 역할 |
|---|---|
| `POST /api/auth/login` | JSON `{"password":"..."}`로 로그인하고 세션 쿠키 발급 |
| `POST /api/auth/logout` | 세션 종료 |
| `GET /api/settings/pdf-folders?path=.` | 바탕화면에서 폴더 탐색. `path`는 바탕화면 기준 상대 경로 |
| `PUT /api/settings/pdf-folder` | JSON `{"path":"hacka"}`로 세션에 폴더 선택을 저장하고 PDF 목록 반환 |
| `GET /api/settings/pdf-folder` | 세션의 선택 폴더와 Upstage 키 설정 상태 조회 |
| `POST /api/verification/batches` | 본문 없이 호출하면 세션에 저장된 폴더의 PDF를 접수. `multipart/form-data`의 `files` 필드로 PDF 직접 등록 가능 |
| `GET /api/verification/batches` | 현재 세션의 처리내역 조회 |
| `GET /api/verification/batches/{id}` | 현재 세션의 처리 상태와 결과 조회 |
| `GET /api/verification/batches/{id}/excel` | 생성된 XLSX 다운로드 |
| `POST /api/verification/selected-excel` | JSON `{"files":[{"batch_id":"…","file_index":0}]}`로 여러 실행의 PDF 결과를 XLSX 한 파일로 다운로드. `file_index`는 접수 응답의 `files` 목록에서 0부터 시작하는 위치 |

아래는 별도 서버에 파일을 직접 업로드하는 방식의 명세입니다. 로컬 폴더 방식에서도 처리 상태와 다운로드 응답은 아래 형식을 따릅니다.

아래 경로와 JSON은 확정된 서버 규격이 아니라 프론트엔드의 기본 어댑터가 지원하는 제안 규격입니다. 경로·파일 필드·서버 주소는 `js/config.js`, 응답 변환은 `responseAdapter` 또는 `js/api.js`의 `normalizeBatch()`에서 변경합니다.

## 역할

프론트엔드는 PDF 선택·목록·전송·상태조회·결과표·다운로드를 담당합니다. FastAPI는 인증·검증·문서 분류와 매칭·Upstage 호출·여비 산정·엑셀 생성·자료 보관을 담당합니다. 프론트엔드는 파일 순서로 신청서와 복명서를 짝짓거나 여비 규칙을 계산하지 않습니다.

첨부 워크플로우의 최종 판정 JSON에는 `decision`, `reason`, `travelers`, `confirmed_settlement_total`, `required_field_errors`가 있습니다. 마지막 출력 노드는 완료 시 8열 정산표, 검토 시 목록 형식의 Markdown을 만듭니다. 서버는 최종 판정 JSON과 상위 단계의 정산 행을 구조화해 아래 응답에 넣어야 합니다. 프론트엔드는 Markdown에서 금액을 추측하거나 정산 규칙을 재현하지 않습니다.

## 1. 여러 PDF 일괄 접수

`POST /api/verification/batches`

본문은 `multipart/form-data`입니다. `files` 필드에 PDF 파일을 반복해서 넣습니다. 브라우저가 경계값을 생성하므로 `Content-Type`을 수동 지정하지 않습니다. `fileField` 설정으로 필드명을 변경할 수 있습니다.

```python
from fastapi import File, UploadFile

# 실제 검증 작업을 작업큐에 등록하는 서버 구현은 별도로 필요합니다.
@app.post("/api/verification/batches", status_code=202)
async def create_batch(files: list[UploadFile] = File(...)):
    # 파일 검증·보관·작업큐 등록 후 아래 형식 반환
    ...
```

빠르게 처리번호를 반환한 뒤 조회 요청에서 작업 상태를 제공하는 방식을 권장합니다.

```json
{
  "id": "BATCH-20261112-0001",
  "created_at": "2026-11-12T09:00:00+09:00",
  "file_count": 2,
  "files": [
    { "name": "출장신청서.pdf", "size": 62636 },
    { "name": "출장복명서.pdf", "size": 63731 }
  ],
  "status": "queued",
  "excel_available": false
}
```

## 2. 처리 상태 및 결과

`GET /api/verification/batches/{id}`

`queued`(대기), `processing`(처리중), `completed`(완료), `error`(오류)를 사용합니다. `completed`는 작업 수행 완료를 뜻하며 판정인 `정산 완료` 또는 `검토 필요`와 구분됩니다. 접수 응답에서 이미 `completed`를 반환하는 동기 처리도 지원합니다.

```json
{
  "id": "BATCH-20261112-0001",
  "created_at": "2026-11-12T09:00:00+09:00",
  "file_count": 2,
  "status": "completed",
  "result": {
    "decision": "정산 완료",
    "reason": "필수 항목 및 출장 정보 일치",
    "confirmed_settlement_total": 40000,
    "travelers": [
      { "traveler": "김하늘", "decision": "정산 완료", "reason": "출장 정보 일치", "amount": 20000 },
      { "traveler": "이도윤", "decision": "정산 완료", "reason": "출장 정보 일치", "amount": 20000 }
    ],
    "required_field_errors": [],
    "settlement_rows": [
      { "출장기간": "2026.11.05 09:00 ~ 18:00", "목적지": "대구광역시", "직위": "주무관", "성명": "김하늘", "금액": 20000, "영수인": "", "비고": "", "등록번호": "시연-2026-001" },
      { "출장기간": "2026.11.05 09:00 ~ 18:00", "목적지": "대구광역시", "직위": "주무관", "성명": "이도윤", "금액": 20000, "영수인": "", "비고": "", "등록번호": "시연-2026-001" }
    ]
  },
  "excel_available": true
}
```

위 예시의 성명·출장·금액은 명세 설명용 가상 값입니다. 실제 서버는 실제 처리 결과를 반환해야 합니다. 금액을 제공하지 못하면 `null`을 반환합니다. 숫자 `0`은 유효한 확정 금액이며 `null`과 다르게 표시합니다. 시각은 시간대가 포함된 ISO 8601 문자열을 사용합니다.

검토 결과 예시:

```json
{
  "id": "BATCH-20261112-0002",
  "status": "completed",
  "result": {
    "decision": "검토 필요",
    "reason": "신청서와 복명서의 출장기간 불일치",
    "confirmed_settlement_total": null,
    "travelers": [
      { "traveler": "김하늘", "decision": "검토 필요", "reason": "출장기간 확인 필요", "amount": null }
    ],
    "required_field_errors": [
      { "field": "출장기간", "message": "신청서 09:00~18:00 / 복명서 10:00~18:00" }
    ],
    "settlement_rows": []
  },
  "excel_available": false
}
```

오류 상태는 `status: "error"`를 반환합니다. 현재 어댑터는 기술 오류의 원문 대신 일반 오류 문구와 처리번호를 표시합니다. 사용자에게 보여줄 안전한 오류 사유를 별도로 합의한 경우 어댑터를 수정하여 연결할 수 있습니다. `검토 필요`의 판정사유와 확인필요사항은 서버 응답 그대로 표시합니다. HTTP 오류와 네트워크 오류도 별도로 표시하며, 알 수 없는 상태값이나 잘못된 응답을 완료로 간주하지 않습니다.

상태 조회 간격은 `pollIntervalMs`, 전체 조회 제한은 `maxPollDurationMs`, HTTP 요청 제한은 `requestTimeoutMs`로 조절합니다. 조회 중단 또는 통신 오류가 실제 서버 작업 취소를 의미하지는 않습니다. 작업 조회와 취소 정책은 운영 서버와 별도로 협의해야 합니다.

## 3. XLSX 다운로드

`GET /api/verification/batches/{id}/excel`

완료 결과에 `excel_available: true`를 반환했을 때 다운로드를 활성화합니다. 서버는 XLSX 바이너리를 반환합니다.

```text
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="settlement.xlsx"; filename*=UTF-8''%EC%A0%95%EC%82%B0%EC%84%9C.xlsx
```

프론트엔드는 Blob으로 받아 저장하고 빈 파일, 텍스트 오류 응답, ZIP 서명이 없는 파일을 거부합니다. XLSX 내부 데이터의 정확성은 서버 책임입니다. 임의의 외부 다운로드 URL을 따라가지 않고 설정된 API 경로로 요청합니다.

## 4. 화면 내부 모델

`normalizeBatch()`는 API 응답을 다음 형태로 바꿉니다. 서버가 다른 구조를 사용하면 `TravelConfig.responseAdapter`에서 변환할 수 있습니다.

```js
{
  id, createdAt, fileCount, files: [{ name, size }],
  status: 'queued' | 'processing' | 'completed' | 'error',
  decision: '정산 완료' | '검토 필요' | null,
  reason, totalAmount: number | null,
  travelers: [{ name, decision, reason, amount }],
  settlementRows: [{ '출장기간', '목적지', '직위', '성명', '금액', '영수인', '비고', '등록번호' }],
  issues: [{ field, message }],
  excelAvailable: boolean,
  source: 'api'
}
```

`source`는 프론트엔드의 실제 실행 경로에서 결정되며 서버가 시연 데이터로 위장하거나 반대로 표시하도록 선택하는 항목이 아닙니다. `demo` 모드는 별도의 가상 저장소와 XLSX 작성기를 사용합니다.

## 5. CORS·인증·보관

가능하면 같은 출처에서 화면과 API를 제공합니다. 별도 출처라면 다음과 같이 실제 프론트엔드 주소를 허용합니다.

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8080"],
    allow_credentials=False,  # 쿠키 인증 도입 시 서버·프론트 설정 동시 변경
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    expose_headers=["Content-Disposition"],
)
```

쿠키 인증 사용 시 `credentials: 'include'`, `allow_credentials=True`, 정확한 허용 출처 및 적절한 CSRF 정책을 적용합니다. Upstage 키는 서버에만 보관합니다. 키·내부 프롬프트·원본 디버그 로그를 응답에 넣지 않습니다.

현재 프론트엔드는 로그인, 전체 서버 내역 목록 API, 서버 작업 취소, 영구 저장을 구현하지 않습니다. API 모드 처리내역은 현재 페이지에서 실행한 작업만 표시합니다. 새로고침 후 내역 복원이 필요하면 목록 API와 인증·보관 정책을 추가 협의합니다.
