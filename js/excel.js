/* 시연용 XLSX 작성기. 실제 정산서는 FastAPI가 생성한 파일을 내려받는다. */
(function (global) {
  'use strict';
  const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const headers = ['출장기간', '목적지', '직위', '성명', '금액', '영수인', '비고', '등록번호'];
  const encode = (s) => new TextEncoder().encode(s);
  const escapeXml = (value) => String(value == null ? '' : value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  function colName(index) {
    let result = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
    return result;
  }

  function worksheet(rows, widths) {
    const cols = widths.map((width, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + width + '" customWidth="1"/>').join('');
    const data = rows.map((row, ri) => '<row r="' + (ri + 1) + '" ht="' + (ri === 0 ? 26 : 23) + '" customHeight="1">' + row.map((value, ci) => {
      const ref = colName(ci) + (ri + 1);
      if (ri > 0 && typeof value === 'number' && Number.isFinite(value)) return '<c r="' + ref + '" s="2"><v>' + value + '</v></c>';
      return '<c r="' + ref + '" t="inlineStr" s="' + (ri === 0 ? '1' : '0') + '"><is><t xml:space="preserve">' + escapeXml(value) + '</t></is></c>';
    }).join('') + '</row>').join('');
    return XML + '<worksheet xmlns="' + NS + '"><dimension ref="A1:' + colName(widths.length - 1) + rows.length + '"/>'
      + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="23"/><cols>' + cols + '</cols><sheetData>' + data + '</sheetData>'
      + '<autoFilter ref="A1:' + colName(widths.length - 1) + rows.length + '"/>'
      + '<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>'
      + '<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>'
      + '</worksheet>';
  }

  function zip(files) {
    const local = [], central = [];
    let offset = 0;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let crc = i;
      for (let j = 0; j < 8; j++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
      table[i] = crc >>> 0;
    }
    const crc32 = (data) => {
      let crc = 0xffffffff;
      for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
      return (crc ^ 0xffffffff) >>> 0;
    };
    const u16 = (a, n) => a.push(n & 255, (n >>> 8) & 255);
    const u32 = (a, n) => a.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
    Object.keys(files).forEach((filename) => {
      const name = encode(filename), data = encode(files[filename]), crc = crc32(data), h = [];
      u32(h, 0x04034b50); u16(h, 20); u16(h, 0); u16(h, 0); u16(h, 0); u16(h, 33);
      u32(h, crc); u32(h, data.length); u32(h, data.length); u16(h, name.length); u16(h, 0);
      local.push(new Uint8Array(h), name, data);
      const c = [];
      u32(c, 0x02014b50); u16(c, 20); u16(c, 20); u16(c, 0); u16(c, 0); u16(c, 0); u16(c, 33);
      u32(c, crc); u32(c, data.length); u32(c, data.length); u16(c, name.length); u16(c, 0); u16(c, 0); u16(c, 0); u16(c, 0); u32(c, 0); u32(c, offset);
      central.push(new Uint8Array(c), name);
      offset += h.length + name.length + data.length;
    });
    const end = [], count = Object.keys(files).length, centralSize = central.reduce((sum, part) => sum + part.length, 0);
    u32(end, 0x06054b50); u16(end, 0); u16(end, 0); u16(end, count); u16(end, count); u32(end, centralSize); u32(end, offset); u16(end, 0);
    return new Blob([...local, ...central, new Uint8Array(end)], { type: MIME });
  }

  function create(batch) {
    if (!batch || batch.source !== 'demo') throw new Error('시연용 엑셀은 가상 처리내역에만 사용할 수 있습니다.');
    const settlement = [headers, ...(batch.settlementRows || []).map((row) => headers.map((key) => row[key] == null ? '' : row[key]))];
    if (settlement.length === 1) settlement.push(['정산내역 없음', '', '', '', '', '', '검토내역 시트 참조', '']);
    const reviews = [['구분', '성명 / 항목', '판정', '내용', '금액']];
    (batch.travelers || []).forEach((person) => reviews.push(['출장자', person.name, person.decision, person.reason, person.amount]));
    (batch.issues || []).forEach((issue) => reviews.push(['확인사항', issue.field, '검토 필요', issue.message, '']));
    if (reviews.length === 1) reviews.push(['처리결과', '', batch.decision || '', batch.reason || '', '']);
    const info = [['항목', '내용'], ['자료 구분', '시연용 가상 데이터 - 실제 PDF 분석 결과가 아닙니다.'], ['처리번호', batch.id], ['처리일시', batch.createdAt], ['검증결과', batch.decision || ''], ['판정사유', batch.reason || ''], ['정산금액', batch.totalAmount == null ? '' : batch.totalAmount], ['유의사항', '업로드 파일의 내용과 무관한 예시이며 실제 지급 근거로 사용할 수 없습니다.']];
    const names = ['정산서', '검토내역', '시연정보'];
    const files = {
      '[Content_Types].xml': XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + names.map((_, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>',
      '_rels/.rels': XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': XML + '<workbook xmlns="' + NS + '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + names.map((name, i) => '<sheet name="' + name + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels': XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + names.map((_, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      'xl/styles.xml': XML + '<styleSheet xmlns="' + NS + '"><fonts count="2"><font><sz val="10"/><name val="맑은 고딕"/></font><font><b/><sz val="10"/><name val="맑은 고딕"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDCE6EC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left style="thin"><color rgb="FFCCD3D8"/></left><right style="thin"><color rgb="FFCCD3D8"/></right><top style="thin"><color rgb="FFCCD3D8"/></top><bottom style="thin"><color rgb="FFCCD3D8"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
      'xl/worksheets/sheet1.xml': worksheet(settlement, [34, 22, 14, 14, 15, 14, 34, 24]),
      'xl/worksheets/sheet2.xml': worksheet(reviews, [16, 22, 16, 94, 15]),
      'xl/worksheets/sheet3.xml': worksheet(info, [18, 112])
    };
    return zip(files);
  }
  global.TravelExcel = Object.freeze({ create });
})(window);
