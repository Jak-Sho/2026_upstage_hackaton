/* FastAPI 연동 경계. UI에서는 이 객체만 사용하며 Upstage를 직접 호출하지 않습니다. */
(function (global) {
  'use strict';
  const config = global.TravelConfig;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const string = value => typeof value === 'string' ? value : '';
  const amount = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const array = value => Array.isArray(value) ? value : [];
  const firstDefined = (...values) => values.find(value => value !== undefined);
  const decision = value => ['정산 완료', '검토 필요'].includes(value) ? value : null;
  const statuses = { queued: 'queued', pending: 'queued', processing: 'processing', running: 'processing', completed: 'completed', done: 'completed', error: 'error', failed: 'error', '대기': 'queued', '처리중': 'processing', '완료': 'completed', '오류': 'error' };

  function normalizeBatch(payload) {
    const source = typeof config.responseAdapter === 'function' ? config.responseAdapter(payload) : payload;
    if (!object(source)) throw new Error('서버 응답 형식을 확인하십시오. JSON 객체가 필요합니다.');
    const raw = object(source.batch) ? source.batch : source;
    const result = object(raw.result) ? raw.result : raw;
    const idValue = firstDefined(raw.id, raw.batch_id);
    const id = typeof idValue === 'number' ? String(idValue) : string(idValue);
    const status = Object.prototype.hasOwnProperty.call(statuses, raw.status) ? statuses[raw.status] : null;
    if (!id || !status) throw new Error('서버 응답의 처리번호 또는 처리상태가 올바르지 않습니다.');
    const finalDecision = decision(result.decision);
    if (status === 'completed' && !finalDecision) throw new Error('서버의 최종 판정이 누락되었거나 올바르지 않습니다.');
    const rawCreatedAt = firstDefined(raw.createdAt, raw.created_at);
    const createdAt = typeof rawCreatedAt === 'string' && !Number.isNaN(Date.parse(rawCreatedAt)) ? new Date(rawCreatedAt).toISOString() : null;
    const files = array(raw.files).map(file => ({ name: string(file && file.name), size: amount(file && file.size) }));
    const fileCountValue = firstDefined(raw.fileCount, raw.file_count);
    const fileCount = Number.isInteger(fileCountValue) && fileCountValue >= 0 ? fileCountValue : (files.length || null);
    const travelers = array(result.travelers).filter(object).map(person => ({
      name: string(firstDefined(person.name, person.traveler, person['성명'])),
      decision: decision(person.decision), reason: string(person.reason),
      amount: amount(firstDefined(person.amount, person.estimated_amount, person['예상정산금액']))
    }));
    const settlementRows = array(firstDefined(result.settlementRows, result.settlement_rows, raw.settlementRows, raw.settlement_rows)).filter(object).map(row => {
      const clean = {};
      ['출장기간', '목적지', '직위', '성명', '금액', '영수인', '비고', '등록번호'].forEach(key => {
        clean[key] = typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] : string(row[key]);
      });
      return clean;
    });
    const issues = array(result.issues).filter(object).map(issue => ({ field: string(issue.field), message: string(firstDefined(issue.message, issue.reason)) }));
    array(result.required_field_errors).filter(object).forEach(issue => issues.push({
      field: [issue.document, issue.field, issue.traveler].filter(value => typeof value === 'string' && value).join(' / '),
      message: string(firstDefined(issue.reason, issue.message)) || '필수 항목 확인 필요'
    }));
    return {
      id, createdAt, fileCount, files, status,
      decision: finalDecision,
      reason: status === 'error' ? '서버에서 문서 처리를 완료하지 못했습니다. 처리번호로 서버 기록을 확인하십시오.' : string(result.reason),
      totalAmount: amount(firstDefined(result.totalAmount, result.total_amount, result.confirmed_settlement_total)),
      travelers, settlementRows, issues,
      excelAvailable: status === 'completed' && firstDefined(raw.excelAvailable, raw.excel_available, result.excelAvailable, result.excel_available) === true,
      source: 'api'
    };
  }

  function endpoint(type, id) {
    if (global.location && global.location.protocol === 'file:') throw new Error('API 모드는 HTTP 서버로 실행하십시오.');
    const template = config.endpoints[type];
    if (typeof template !== 'string' || !template) throw new Error('API 경로 설정을 확인하십시오.');
    const path = template.replace('{id}', encodeURIComponent(id || ''));
    const origin = (global.location && global.location.origin) || 'http://localhost';
    const base = config.apiBaseUrl || origin;
    let baseUrl;
    let url;
    try {
      baseUrl = new URL(base, origin);
      url = new URL(baseUrl.href.replace(/\/$/, '') + '/' + path.replace(/^\//, ''));
    } catch (_) { throw new Error('API 서버 주소 설정을 확인하십시오.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('API 서버는 HTTP 또는 HTTPS 주소로 설정하십시오.');
    return url.href;
  }

  async function request(url, options, readResponse, externalSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (externalSignal && externalSignal.aborted) throw new DOMException('요청이 중단되었습니다.', 'AbortError');
    if (externalSignal) externalSignal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.requestTimeoutMs);
    try {
      const response = await fetch(url, {
        ...options, credentials: config.credentials, signal: controller.signal,
        cache: 'no-store', redirect: 'error'
      });
      if (!response.ok) {
        if (config.localWorkflow && /json/i.test(response.headers.get('content-type') || '')) {
          const error = await response.json();
          if (typeof error.detail === 'string') throw new Error(error.detail);
        }
        if (response.status === 401 || response.status === 403) throw new Error('서버 접근 권한을 확인하십시오. (HTTP ' + response.status + ')');
        if (response.status === 413) throw new Error('서버의 첨부파일 용량 제한을 초과했습니다. (HTTP 413)');
        if (response.status === 404) throw new Error('처리내역 또는 API 경로를 찾을 수 없습니다. (HTTP 404)');
        throw new Error('서버 요청에 실패했습니다. (HTTP ' + response.status + ')');
      }
      return await readResponse(response);
    } catch (error) {
      if (timedOut) throw new Error('서버 응답 대기시간을 초과했습니다. 접수 여부를 확인한 후 다시 시도하십시오.');
      if (externalSignal && externalSignal.aborted) throw new DOMException('요청이 중단되었습니다.', 'AbortError');
      if (error instanceof TypeError) throw new Error('서버 연결에 실패했습니다. 서버 주소, 네트워크 및 CORS 설정을 확인하십시오.');
      throw error;
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', abort);
    }
  }
  async function readJSON(response) {
    if (!/json/i.test(response.headers.get('content-type') || '')) throw new Error('서버가 JSON 형식의 처리 결과를 반환하지 않았습니다.');
    let payload;
    try { payload = await response.json(); }
    catch (_) { throw new Error('서버 JSON 응답을 읽을 수 없습니다.'); }
    return normalizeBatch(payload);
  }
  function mode() {
    if (!['demo', 'api'].includes(config.mode)) throw new Error('실행 모드 설정을 확인하십시오.');
    return config.mode;
  }
  async function createBatch(files, options = {}) {
    if (mode() === 'demo') return global.TravelDemo.createBatch(files, options);
    if (options.useFolder) return request(endpoint('create'), { method: 'POST' }, readJSON, options.signal);
    if (!files.length) throw new Error('검증할 PDF 파일이 없습니다.');
    const form = new FormData();
    files.forEach(file => form.append(config.fileField, file, file.name));
    return request(endpoint('create'), { method: 'POST', body: form }, readJSON, options.signal);
  }
  async function getBatch(id, options = {}) {
    if (mode() === 'demo') return global.TravelDemo.getBatch(id, options);
    if (!id) throw new Error('처리번호가 없습니다.');
    const result = await request(endpoint('status', id), { method: 'GET' }, readJSON, options.signal);
    if (result.id !== String(id)) throw new Error('조회한 처리번호와 서버 응답의 처리번호가 일치하지 않습니다.');
    return result;
  }
  function downloadName(disposition, id) {
    let candidate = '';
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const basic = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition);
    try { candidate = utf8 ? decodeURIComponent(utf8[1]) : basic ? (basic[1] || basic[2]).trim() : ''; } catch (_) { /* 기본 파일명 사용 */ }
    candidate = candidate.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0,160);
    return /\.xlsx$/i.test(candidate) ? candidate : '출장정산결과_' + String(id).replace(/[^a-zA-Z0-9_-]/g, '_') + '.xlsx';
  }
  async function downloadExcel(batch, options = {}) {
    if (mode() === 'demo') return global.TravelDemo.downloadExcel(batch, options);
    if (batch.source !== 'api' || !batch.excelAvailable) throw new Error('서버에서 다운로드 가능한 정산서가 없습니다.');
    return request(endpoint('excel', batch.id), { method: 'GET' }, response => readExcel(response, batch.id), options.signal);
  }
  async function readExcel(response, id) {
    const contentType = response.headers.get('content-type') || '';
    if (/text\/|json/i.test(contentType)) throw new Error('서버가 XLSX 대신 오류 문서 또는 텍스트를 반환했습니다.');
    const blob = await response.blob();
    const signature = new Uint8Array(await blob.slice(0,4).arrayBuffer());
    if (blob.size < 4 || signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 0x03 || signature[3] !== 0x04) throw new Error('서버의 XLSX 파일 형식을 확인하십시오.');
    return { blob, filename: downloadName(response.headers.get('content-disposition') || '', id) };
  }
  function downloadSelectedExcel(files) {
    return request('/api/verification/selected-excel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files })
    }, response => readExcel(response, 'selected'));
  }
  function localRequest(path, method = 'GET', body) {
    const options = { method };
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify(body);
    }
    return request(path, options, response => response.status === 204 ? null : response.json());
  }
  global.TravelAPI = { createBatch, getBatch, downloadExcel, downloadSelectedExcel, normalizeBatch, localRequest };
})(window);
