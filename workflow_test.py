"""Run the Upstage Studio workflow for PDF files and export the results."""

import argparse
from getpass import GetPassWarning, getpass
import http.client
import json
from pathlib import Path
import re
import sys
import time
from urllib.parse import quote
from uuid import uuid4
import warnings

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils.exceptions import IllegalCharacterError


HOST = "api.upstage.ai"
PROJECT_ID = "proj_MuRanrt7exQdn8suZnweLH"
AGENT_ID = "agt_27tFAtLdokqTUNbsM6oCq3"
CONFIG_ID = "41"
DEFAULT_PDF_FOLDER = Path.home() / "Desktop" / "hacka"
DEFAULT_SETS = (1, 2, 3, 4, 6)
TERMINAL = {"completed", "failed", "cancelled"}
TRIP_COLUMNS = ("출장기간", "목적지", "직위", "성명", "금액", "영수인", "비고", "등록번호")
CITATION = re.compile(r"【†\d+】")
REVIEW_HEADING = re.compile(r"^(?:#{1,6}\s+)?(?:\*\*)?검토\s*필요(?:\*\*)?\s*[:：]?\s*$")
REVIEW_BULLET = re.compile(r"^(?:[-+*•]|\d+[.)])\s+(.+)$")


def request(api_key, method, endpoint, body=None, headers=None):
    request_headers = {
        "Authorization": f"Bearer {api_key}",
        "x-project-id": PROJECT_ID,
        **(headers or {}),
    }
    connection = http.client.HTTPSConnection(HOST, timeout=120)
    try:
        connection.request(method, "/v2" + endpoint, body, request_headers)
        response = connection.getresponse()
        if not 200 <= response.status < 300:
            hints = {
                401: "API 키를 확인하세요.",
                403: "API 키의 프로젝트 접근 권한을 확인하세요.",
                404: "프로젝트, 워크플로우, 버전 또는 Job ID를 확인하세요.",
                429: "호출 한도에 도달했습니다. 잠시 후 다시 시도하세요.",
            }
            hint = hints.get(response.status, response.reason)
            raise ValueError(f"{method} {endpoint}: HTTP {response.status}. {hint}")
        return json.loads(response.read())
    finally:
        connection.close()


def upload_pdf(api_key, pdf_path):
    boundary = uuid4().hex
    filename = pdf_path.name.replace('"', "_")
    prefix = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n'
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        "Content-Type: application/pdf\r\n\r\n"
    ).encode("utf-8")
    suffix = f"\r\n--{boundary}--\r\n".encode("ascii")

    with pdf_path.open("rb") as pdf:
        def chunks():
            yield prefix
            yield from iter(lambda: pdf.read(64 * 1024), b"")
            yield suffix

        response = request(
            api_key, "POST", "/files", chunks(),
            {
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(prefix) + pdf_path.stat().st_size + len(suffix)),
            },
        )
    return response["id"]


def run_workflow(api_key, pdf_path):
    file_id = upload_pdf(api_key, pdf_path)
    payload = {
        "model": AGENT_ID,
        "config_id": CONFIG_ID,
        "include": ["last"],
        "input": [{"role": "user", "content": [{"type": "input_file", "file_id": file_id}]}],
    }
    job = request(
        api_key, "POST", "/responses", json.dumps(payload).encode("utf-8"),
        {"Content-Type": "application/json"},
    )
    job_id = job["id"]
    print(f"Job ID: {job_id}", flush=True)
    poll_endpoint = f"/responses/{quote(job_id, safe='')}?include%5B%5D=last"
    deadline = time.monotonic() + 15 * 60

    while job.get("status") not in TERMINAL:
        if time.monotonic() >= deadline:
            raise ValueError(f"Job {job_id}의 결과 조회 시간이 초과되었습니다.")
        time.sleep(2.5)
        job = request(api_key, "GET", poll_endpoint)

    if job["status"] != "completed":
        error = job.get("error") or {}
        details = [job["status"], error.get("step"), error.get("code"), error.get("message")]
        raise ValueError(" / ".join(filter(None, details)))

    result = job.get("output_text") or "".join(
        part.get("text", "")
        for item in job.get("output", [])
        for part in item.get("content", [])
        if part.get("type") == "output_text"
    )
    if not result:
        raise ValueError("완료된 Job에 결과 텍스트가 없습니다.")
    return result


def table_cells(line):
    line = CITATION.sub("", line).strip().removeprefix("|")
    line = re.sub(r"(?<!\\)\|$", "", line)
    return [
        cell.strip().replace(r"\|", "|")
        for cell in re.split(r"(?<!\\)\|", line)
    ]


def trip_rows(result):
    rows, reviews = [], []
    if not isinstance(result, str):
        return rows, [(None, "응답에서 출장 내역 Markdown 표를 찾지 못했습니다.")]

    lines = result.splitlines()
    for index, line in enumerate(lines[:-1]):
        headers = table_cells(line)
        separator = table_cells(lines[index + 1])
        if set(headers) != set(TRIP_COLUMNS) or len(headers) != len(TRIP_COLUMNS):
            continue
        if len(separator) != len(headers) or not all(
            re.fullmatch(r":?-{3,}:?", cell) for cell in separator
        ):
            continue

        for line in lines[index + 2:]:
            if not line.lstrip().startswith("|"):
                break
            number = len(rows) + 1
            values = table_cells(line)
            if len(values) != len(headers):
                rows.append([number, *([None] * len(TRIP_COLUMNS))])
                reviews.append((number, f"응답 행의 열 개수가 다릅니다. 원본: {line.strip()}"))
                continue

            trip = dict(zip(headers, values))
            trip["영수인"] = None
            missing = [
                column for column in TRIP_COLUMNS
                if column != "영수인"
                and trip[column] in ("", "-", "—", "미기재", "미확인", "N/A", "null")
            ]
            reasons = [f"누락: {', '.join(missing)}"] if missing else []
            if "금액" not in missing:
                amount = re.sub(r"^(?:₩\s*)|(?:\s*원)$", "", trip["금액"])
                if re.fullmatch(r"(?:\d+|\d{1,3}(?:,\d{3})+)", amount):
                    digits = amount.replace(",", "")
                    trip["금액"] = int(digits) if len(digits) <= 15 else digits
                else:
                    reasons.append(f"금액 형식 확인: {trip['금액']}")
            rows.append([number, *(trip[column] for column in TRIP_COLUMNS)])
            if reasons:
                reviews.append((number, "\n".join(reasons)))

    review_start = next((i for i, line in enumerate(lines) if REVIEW_HEADING.fullmatch(line.strip())), None)
    if review_start is not None or not rows:
        review_lines = lines[review_start + 1:] if review_start is not None else lines
        reasons = []
        for line in review_lines:
            if re.match(r"^\s*#{1,6}\s", line) and review_start is not None:
                break
            bullet = REVIEW_BULLET.fullmatch(line.strip())
            if bullet:
                reason = re.sub(r"\*\*(.+?)\*\*", r"\1", bullet[1]).strip()
                reasons.append((None, reason))
        reviews.extend(reasons)
        if not reasons and review_start is not None:
            reviews.append((None, "워크플로우가 검토 필요로 판정했습니다."))
        elif not reasons and not rows:
            reviews.append((None, "응답에서 지정한 열의 출장 내역 행을 찾지 못했습니다. 원본 JSON을 확인하세요."))
    return rows, reviews


def write_sheet(sheet, headers, rows, widths):
    sheet.freeze_panes = "A3"
    alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    for column, (header, width) in enumerate(zip(headers, widths), start=2):
        cell = sheet.cell(row=2, column=column, value=header)
        sheet.column_dimensions[cell.column_letter].width = width
        cell.fill = PatternFill("solid", fgColor="17365D")
        cell.font = Font(color="FFFFFF", bold=True)
        cell.alignment = alignment

    for row_number, row in enumerate(rows, start=3):
        if row_number > 1_048_576:
            raise ValueError("응답이 엑셀의 최대 행 수를 초과했습니다. JSON 파일을 확인하세요.")

        for column, value in enumerate(row, start=2):
            if isinstance(value, str) and len(value.encode("utf-16-le")) // 2 > 32_767:
                raise ValueError("응답 값이 엑셀의 셀 길이 제한을 초과했습니다. JSON 파일을 확인하세요.")

            cell = sheet.cell(row=row_number, column=column, value=value)
            cell.alignment = alignment
            if isinstance(value, str):
                cell.data_type = "s"

    sheet.auto_filter.ref = sheet.dimensions


def save_excel(records, output_path):
    rows, review_rows = [], []

    for file_number, record in enumerate(records, start=1):
        filename = record["file"]
        offset = len(rows)
        result = record.get("result")
        result_text = result if isinstance(result, str) else (
            json.dumps(result, ensure_ascii=False, indent=2) if "result" in record else None
        )

        if "error" in record:
            file_rows, reviews = [], [(None, record["error"])]
        else:
            file_rows, reviews = trip_rows(result)

        rows.extend(
            [number + offset, *values]
            for number, *values in file_rows
        )

        for number, reason in reviews:
            trip_number = number + offset if number is not None else None
            review_rows.append((file_number, filename, "예", reason, result_text, trip_number))

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "출장 내역"
    write_sheet(
        sheet, ("순번", *TRIP_COLUMNS),
        rows, (8, 29, 33, 12, 12, 15, 12, 46, 23),
    )

    amount_column = TRIP_COLUMNS.index("금액") + 3
    for (cell,) in sheet.iter_rows(min_row=3, min_col=amount_column, max_col=amount_column):
        if isinstance(cell.value, int):
            cell.number_format = "#,##0"

    review_sheet = workbook.create_sheet("검토")
    if review_rows:
        write_sheet(
            review_sheet, ("순번", "원본 파일", "검토 필요", "이유", "원본 응답", "출장 순번"),
            review_rows, (8, 36, 13, 45, 100, 12),
        )

    for row_number, (_, _, _, reason, response, _) in enumerate(review_rows, start=3):
        text = response or reason
        lines = sum(max(1, (len(line) + 49) // 50) for line in text.splitlines())
        review_sheet.row_dimensions[row_number].height = min(409, max(30, 17 * lines))

    workbook.save(output_path)


def parse_result(text):
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pdf", nargs="?", type=Path, help="입력 PDF 경로")
    parser.add_argument("-o", "--output", type=Path)
    parser.add_argument("--from-json", type=Path, help="저장된 응답으로 엑셀 다시 생성")
    parser.add_argument("--folder", type=Path, help="PDF를 파일명 순으로 처리할 폴더")
    parser.add_argument("--files", nargs="+", type=Path, help="지정한 순서대로 처리할 PDF 경로")
    parser.add_argument("--limit", type=int, help="폴더에서 처리할 최대 파일 수")
    args = parser.parse_args()

    use_default_files = not any((args.pdf, args.folder, args.from_json, args.files))
    if use_default_files:
        args.files = [
            DEFAULT_PDF_FOLDER / f"팀~원_최종제출_set{number:02}.pdf"
            for number in DEFAULT_SETS
        ]
    if args.output is None:
        args.output = (
            Path(__file__).resolve().with_name("workflow-set.xlsx")
            if use_default_files else Path("workflow-result.xlsx")
        )

    if args.limit is not None and (args.limit < 1 or args.folder is None):
        parser.error("--limit은 --folder와 함께 1 이상의 값으로 지정하세요.")
    if sum(option is not None for option in (args.folder, args.from_json, args.files)) > 1:
        parser.error("--folder, --from-json, --files 중 하나를 지정하세요.")
    if args.folder and not args.folder.is_dir():
        parser.error(f"입력 폴더를 확인하세요: {args.folder}")
    if not (args.from_json or args.folder):
        for path in args.files or [args.pdf]:
            if not path.is_file() or path.suffix.lower() != ".pdf":
                parser.error(f"입력 PDF를 확인하세요: {path}")
    if args.output.suffix.lower() != ".xlsx" or not args.output.parent.is_dir():
        parser.error("기존 폴더 아래에 .xlsx 출력 경로를 지정하세요.")

    api_key = ""
    try:
        if args.from_json:
            json_path = args.from_json
            result = parse_result(json_path.read_text(encoding="utf-8-sig"))
            batch = isinstance(result, dict) and isinstance(result.get("files"), list)
            records = result["files"] if batch else [{"file": json_path.name, "result": result}]
        else:
            batch = args.folder is not None or args.files is not None
            inputs = args.files or [args.pdf]
            if args.folder:
                inputs = sorted(
                    (
                        path for path in args.folder.iterdir()
                        if path.is_file() and path.suffix.lower() == ".pdf"
                    ),
                    key=lambda path: path.name.casefold(),
                )[:args.limit]
                if not inputs:
                    raise ValueError("지정한 폴더에 PDF가 없습니다.")

            if batch:
                print("처리할 PDF:")
                for path in inputs:
                    print(f"  {path.name}")

            with warnings.catch_warnings():
                warnings.simplefilter("error", GetPassWarning)
                api_key = getpass("Upstage API key: ").strip()
            if not api_key:
                raise ValueError("API 키를 입력하세요.")

            records = []
            json_path = args.output.with_suffix(".json")
            for number, path in enumerate(inputs, 1):
                if batch:
                    print(f"[{number}/{len(inputs)}] {path.name}", flush=True)
                record = {"file": path.name}
                try:
                    record["result"] = parse_result(run_workflow(api_key, path))
                except (OSError, http.client.HTTPException, ValueError, KeyError) as error:
                    if not batch:
                        raise
                    record["error"] = str(error).replace(api_key, "[REDACTED]")
                    print(f"  처리 실패: {record['error']}", file=sys.stderr)

                records.append(record)
                saved = {"files": records} if batch else record["result"]
                json_path.write_text(
                    json.dumps(saved, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )

        save_excel(records, args.output)
        print(f"Excel: {args.output.resolve()}")
        print(f"JSON:  {json_path.resolve()}")
        return 0
    except GetPassWarning:
        print("키 입력을 숨길 수 있는 VS Code 터미널에서 실행하세요.", file=sys.stderr)
    except (KeyboardInterrupt, EOFError):
        print("\n실행을 취소했습니다.", file=sys.stderr)
    except IllegalCharacterError:
        print("엑셀에 저장할 수 없는 문자가 있습니다. JSON 파일에서 원본 값을 확인하세요.", file=sys.stderr)
    except (OSError, http.client.HTTPException, ValueError, KeyError) as error:
        message = str(error).replace(api_key, "[REDACTED]") if api_key else str(error)
        print(f"실행 실패: {message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
