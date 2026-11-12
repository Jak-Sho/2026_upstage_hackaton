(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const config = window.TravelConfig;
  const api = window.TravelAPI;
  const demo = config.mode === 'demo';
  const local = config.localWorkflow === true;
  const usesFolder = () => local && $('sourceFolder').checked;
  let localFolder = null;
  let signedIn = false;
  let upstageConfigured = false;
  const fileExportSelection = new Map();
  let expandedBatchId = null;
  const state = { files: [], nextFile: 1, busy: false, adding: false, downloading: false, history: demo ? window.TravelDemo.seedBatches() : [], historySelection: new Set(), selectedId: null, page: 1, pageSize: 10, filter: {}, previewUrl: null, controller: null };
  const statusNames = { queued: '대기', processing: '처리중', completed: '완료', error: '오류' };
  const columns = ['출장기간', '목적지', '직위', '성명', '금액', '영수인', '비고', '등록번호'];
  const terminal = batch => ['completed', 'error'].includes(batch.status);
  const amount = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ko-KR') : '—';
  const size = value => value < 1048576 ? Math.max(1, Math.ceil(value / 1024)).toLocaleString('ko-KR') + ' KB' : (value / 1048576).toFixed(2) + ' MB';
  function dateKey(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }
  function dateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date).replaceAll('-', '.');
  }
  function message(text, success) {
    $('message').textContent = text;
    $('message').className = 'message' + (success ? ' success' : '');
    $('message').hidden = !text;
  }
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function cell(row, text, className) { const node = element('td', text, className); row.append(node); return node; }
  function emptyRow(body, text, count, small) {
    const row = element('tr'); const td = cell(row, text, small ? 'small-empty' : 'empty-cell'); td.colSpan = count; body.append(row);
  }
  function badge(text, kind) { return element('span', text, 'badge ' + (kind || '')); }
  function decisionBadge(decision) { return decision ? badge(decision, decision === '검토 필요' ? 'review' : 'completed') : element('span', '—', 'muted'); }
  function action(text, handler, className) { const button = element('button', text, className); button.type = 'button'; button.addEventListener('click', handler); return button; }
  function checkbox(label, checked, handler) { const input = element('input'); input.type = 'checkbox'; input.checked = checked; input.setAttribute('aria-label', label); input.addEventListener('change', handler); return input; }

  function syncControls() {
    const locked = state.busy || state.adding;
    const checkedCount = state.files.filter(file => file.selected).length;
    $('addFiles').disabled = locked;
    $('fileInput').disabled = locked;
    $('deleteSelected').disabled = locked || !checkedCount;
    $('deleteAll').disabled = locked || !state.files.length;
    $('selectAllFiles').disabled = locked || !state.files.length;
    $('selectAllFiles').checked = checkedCount > 0 && checkedCount === state.files.length;
    $('selectAllFiles').indeterminate = checkedCount > 0 && checkedCount < state.files.length;
    $('sourceFolder').disabled = $('sourceUpload').disabled = locked || !signedIn;
    const targetCount = usesFolder() ? localFolder?.files.length : local ? checkedCount : state.files.length;
    $('runVerification').disabled = locked || !targetCount || (local && (!signedIn || !upstageConfigured));
    $('openFolders').disabled = locked || !signedIn;
    $('localLogout').disabled = !local || !signedIn || locked || state.downloading;
    $('demoScenario').disabled = locked;
    $('selectedFileCount').textContent = checkedCount;
    if (!locked && local && !usesFolder() && $('executionStatus').textContent === '대기') {
      $('executionDetail').textContent = checkedCount ? '검증 대상 PDF ' + checkedCount + '건' : '검증할 PDF를 체크하세요.';
    }
    $('refreshBatch').disabled = state.busy;
    syncFileExport();
    $('fileBody').querySelectorAll('input,button[data-delete]').forEach(node => { node.disabled = locked; });
  }

  function renderFiles() {
    const body = $('fileBody'); body.replaceChildren();
    $('fileCount').textContent = state.files.length;
    const total = state.files.reduce((sum, item) => sum + item.file.size, 0);
    $('totalFileSize').textContent = total ? size(total) : '0 KB';
    if (!state.files.length) emptyRow(body, '등록된 첨부파일이 없습니다.   [파일등록] 또는 PDF 끌어놓기', 7);
    state.files.forEach(item => {
      const row = element('tr');
      cell(row).append(checkbox(item.file.name + ' 선택', item.selected, event => { item.selected = event.target.checked; syncControls(); }));
      cell(row, item.order);
      const nameCell = cell(row, null, 'file-name');
      const name = action(item.file.name, () => preview(item)); name.title = item.file.name; nameCell.append(name);
      cell(row, 'PDF'); cell(row, size(item.file.size), 'number'); cell(row, '등록완료');
      const actions = cell(row); const remove = action('삭제', () => removeFiles([item.id]), 'mini'); remove.dataset.delete = 'true'; remove.setAttribute('aria-label', item.file.name + ' 삭제');
      actions.append(action('미리보기', () => preview(item), 'mini'), remove); body.append(row);
    });
    if (!state.busy) setExecution('대기', state.files.length ? '등록 ' + state.files.length + '건 / 일괄검증 대상' : '등록파일 없음');
    syncControls();
  }

  async function addFiles(files) {
    if (state.busy || state.adding || (local && (!signedIn || usesFolder()))) return;
    state.adding = true; syncControls();
    let added = 0; const errors = [];
    try {
      for (const file of Array.from(files)) {
        if (!/\.pdf$/i.test(file.name) || (file.type && !['application/pdf', 'application/x-pdf', 'application/octet-stream'].includes(file.type))) { errors.push(file.name + ' : PDF 파일만 등록 가능합니다.'); continue; }
        if (!file.size) { errors.push(file.name + ' : 빈 파일입니다.'); continue; }
        if (file.size > config.maxFileSizeBytes) { errors.push(file.name + ' : 파일 크기 제한 초과 (' + size(config.maxFileSizeBytes) + ')'); continue; }
        if (state.files.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) { errors.push(file.name + ' : 중복 파일 제외'); continue; }
        if (state.files.length >= config.maxFiles) { errors.push(file.name + ' : 최대 ' + config.maxFiles + '건까지 등록 가능합니다.'); continue; }
        try {
          const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
          if (!new TextDecoder('ascii').decode(head).includes('%PDF-')) { errors.push(file.name + ' : PDF 형식이 아닙니다.'); continue; }
        } catch (_) { errors.push(file.name + ' : 파일을 읽을 수 없습니다.'); continue; }
        const order = state.nextFile++;
        state.files.push({ id: 'file-' + order, file, order, selected: false }); added++;
      }
      message([added ? added + '건 등록완료' : '', ...errors].filter(Boolean).join('\n'), !errors.length);
    } finally { state.adding = false; renderFiles(); }
  }
  function removeFiles(ids) {
    if (state.busy || state.adding) return;
    const removals = new Set(ids); const count = state.files.filter(item => removals.has(item.id)).length;
    state.files = state.files.filter(item => !removals.has(item.id));
    if (!state.files.length) state.nextFile = 1;
    renderFiles(); message(count + '건 삭제완료', true);
  }
  function closePreview() {
    $('pdfFrame').removeAttribute('src'); $('openPdf').removeAttribute('href');
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
  }
  function preview(item) {
    closePreview(); state.previewUrl = URL.createObjectURL(item.file);
    $('previewFilename').textContent = item.file.name;
    $('pdfFrame').src = state.previewUrl;
    $('openPdf').href = state.previewUrl;
    $('previewDialog').showModal();
  }
  function setExecution(status, detail, kind) {
    $('executionStatus').textContent = status;
    $('executionDetail').textContent = detail || '';
    $('statusLight').className = 'status-light ' + (kind || '');
    $('tinyProgress').hidden = !state.busy;
  }
  function matchingHistory() {
    const filter = state.filter;
    return state.history.filter(batch => {
      const day = batch.createdAt ? dateKey(batch.createdAt) : '';
      const searchable = [batch.id, ...(batch.files || []).map(file => file.name)].join(' ').toLowerCase();
      return (!filter.start || (day && day >= filter.start)) && (!filter.end || (day && day <= filter.end)) && (!filter.status || batch.status === filter.status) && (!filter.decision || batch.decision === filter.decision) && (!filter.keyword || searchable.includes(filter.keyword));
    });
  }
  function visibleHistory() { return matchingHistory().slice((state.page - 1) * state.pageSize, state.page * state.pageSize); }
  function syncHistorySelection() {
    const visible = visibleHistory(); const selected = visible.filter(batch => state.historySelection.has(batch.id)).length;
    $('selectAllHistory').disabled = !visible.length;
    $('selectAllHistory').checked = visible.length > 0 && selected === visible.length;
    $('selectAllHistory').indeterminate = selected > 0 && selected < visible.length;
    $('historySelection').textContent = '선택 ' + state.historySelection.size + ' 건';
    $('viewSelected').disabled = state.historySelection.size !== 1;
  }
  function syncFileExport() {
    $('fileExportCount').textContent = '선택 ' + fileExportSelection.size + '건';
    $('downloadFileExport').disabled = state.downloading || !fileExportSelection.size;
    $('clearFileExport').disabled = state.downloading || !fileExportSelection.size;
  }
  function renderFileExport(batches) {
    if (!local) return;
    const body = $('fileExportBody');
    body.replaceChildren();
    for (const batch of batches.filter(batch => batch.excelAvailable)) {
      batch.files.forEach((file, index) => {
        const key = batch.id + ':' + index;
        const row = element('tr');
        cell(row).append(checkbox(file.name + ' · ' + batch.id + ' · ' + (index + 1), fileExportSelection.has(key), event => {
          if (event.target.checked) fileExportSelection.set(key, { batch_id: batch.id, file_index: index });
          else fileExportSelection.delete(key);
          syncFileExport();
        }));
        cell(row, file.name, 'left');
        cell(row, batch.id);
        cell(row, dateTime(batch.createdAt));
        body.append(row);
      });
    }
    if (!body.childElementCount) emptyRow(body, '이 페이지에 엑셀로 내려받을 수 있는 PDF가 없습니다.', 4, true);
    syncFileExport();
  }
  function renderHistory() {
    const rows = matchingHistory(); const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    state.page = Math.max(1, Math.min(state.page, totalPages));
    $('historyCount').textContent = rows.length;
    $('filteredCount').textContent = rows.length !== state.history.length ? '/ 전체 ' + state.history.length + '건' : '';
    const body = $('historyBody'); body.replaceChildren();
    if (!rows.length) emptyRow(body, '조회된 처리내역이 없습니다.', 8);
    visibleHistory().forEach((batch, index) => {
      const row = element('tr'); if (batch.id === state.selectedId) row.className = 'selected';
      cell(row).append(checkbox(batch.id + ' 선택', state.historySelection.has(batch.id), event => { if (event.target.checked) state.historySelection.add(batch.id); else state.historySelection.delete(batch.id); syncHistorySelection(); }));
      const expanded = expandedBatchId === batch.id;
      const toggleId = 'history-settlement-toggle-' + index;
      const detailId = 'history-settlement-' + index;
      const toggle = action(batch.id, () => {
        expandedBatchId = expanded ? null : batch.id;
        renderHistory();
        $(toggleId).focus({ preventScroll: true });
      }, 'link-button');
      toggle.id = toggleId;
      toggle.setAttribute('aria-expanded', String(expanded));
      if (expanded) toggle.setAttribute('aria-controls', detailId);
      cell(row).append(toggle);
      cell(row, dateTime(batch.createdAt)); cell(row, batch.fileCount ?? '—'); cell(row).append(badge(statusNames[batch.status] || '미확인', batch.status));
      cell(row).append(decisionBadge(batch.decision)); cell(row, amount(batch.totalAmount), 'number');
      cell(row).append(action('조회', () => selectResult(batch.id, true), 'mini')); body.append(row);
      if (expanded) {
        const detailRow = element('tr', null, 'history-detail');
        detailRow.id = detailId;
        const detail = cell(detailRow);
        detail.colSpan = 8;
        const panel = element('div', null, 'history-settlement-panel');
        const heading = element('h3', '출장여비 정산서', 'history-settlement-title');
        const scroll = element('div', null, 'history-settlement-scroll');
        const table = $('settlementBody').closest('table').cloneNode(true);
        table.className = 'data-table history-settlement';
        table.querySelector('colgroup').remove();
        const detailBody = table.tBodies[0];
        detailBody.removeAttribute('id');
        renderSettlement(detailBody, batch);
        scroll.append(table);
        panel.append(heading, scroll);
        detail.append(panel);
        body.append(detailRow);
      }
    });
    const pages = $('pagination'); pages.replaceChildren();
    const pageButton = (text, page, disabled) => { const node = action(text, () => { state.page = page; state.historySelection.clear(); renderHistory(); }); node.disabled = disabled; pages.append(node); return node; };
    pageButton('‹', state.page - 1, state.page === 1).setAttribute('aria-label', '이전 페이지');
    const start = Math.max(1, Math.min(state.page - 2, totalPages - 4));
    for (let page = start; page <= Math.min(totalPages, start + 4); page++) {
      const node = pageButton(String(page), page, false); if (page === state.page) { node.className = 'active'; node.setAttribute('aria-current', 'page'); }
    }
    pageButton('›', state.page + 1, state.page === totalPages).setAttribute('aria-label', '다음 페이지');
    syncHistorySelection();
    renderFileExport(visibleHistory());
  }
  function selectResult(id, scroll) {
    state.selectedId = id; renderHistory(); renderResult();
    if (scroll) { $('results').scrollIntoView({ block: 'start' }); markNavigation('results'); }
  }
  function renderSettlement(body, batch) {
    body.replaceChildren();
    const settlement = batch.settlementRows || [];
    if (!settlement.length) {
      const emptyMessage = !terminal(batch) ? '정산 결과를 기다리는 중입니다.'
        : batch.decision === '검토 필요' ? '검토 필요 — 반환된 정산서 내역 없음' : '반환된 정산서 내역이 없습니다.';
      emptyRow(body, emptyMessage, 8, true);
    }
    settlement.forEach(data => {
      const row = element('tr');
      columns.forEach(key => cell(row, key === '금액' && typeof data[key] === 'number' ? amount(data[key]) : data[key] ?? '', key === '금액' ? 'number' : ''));
      body.append(row);
    });
  }
  function renderResult() {
    const batch = state.history.find(item => item.id === state.selectedId);
    $('noResult').hidden = !!batch; $('resultContent').hidden = !batch;
    if (!batch) { $('resultSource').textContent = '선택된 처리내역 없음'; syncControls(); return; }
    $('resultSource').textContent = batch.source === 'demo' ? '[시연] 가상 처리결과 · 업로드 PDF와 무관' : '[API] 서버 처리결과';
    $('resultId').textContent = batch.id;
    $('resultStatus').replaceChildren(badge(statusNames[batch.status] || '미확인', batch.status));
    $('resultDecision').replaceChildren(decisionBadge(batch.decision));
    $('resultAmount').textContent = amount(batch.totalAmount) + (batch.totalAmount != null ? ' 원' : '');
    $('resultReason').textContent = batch.reason || (terminal(batch) ? '반환된 판정사유 없음' : '서버 처리 결과 대기');
    $('monitorWarning').hidden = !batch.monitorError; $('monitorWarning').textContent = batch.monitorError || '';
    const issues = batch.issues || []; $('issueBlock').hidden = !issues.length;
    $('issueBody').replaceChildren(); issues.forEach(issue => { const row = element('tr'); cell(row, issue.field || '검토사항'); cell(row, issue.message || ''); $('issueBody').append(row); });
    const travelers = batch.travelers || []; $('travelerBlock').hidden = !travelers.length;
    $('travelerBody').replaceChildren(); travelers.forEach(person => { const row = element('tr'); cell(row, person.name || '—'); cell(row).append(decisionBadge(person.decision)); cell(row, person.reason || '—', 'left'); cell(row, amount(person.amount), 'number'); $('travelerBody').append(row); });
    renderSettlement($('settlementBody'), batch);
    $('resultFileNames').textContent = '첨부파일 : ' + ((batch.files || []).map(file => file.name).join(', ') || '반환 정보 없음');
    $('refreshBatch').hidden = terminal(batch) || batch.localOnly === true;
    syncControls();
  }
  function upsert(batch, previousId) {
    const index = state.history.findIndex(item => item.id === (previousId || batch.id));
    const previous = index >= 0 ? state.history[index] : {};
    const next = { ...previous, ...batch, createdAt: batch.createdAt || previous.createdAt || new Date().toISOString(), fileCount: batch.fileCount ?? previous.fileCount ?? null, files: batch.files?.length ? batch.files : previous.files || [], monitorError: null };
    if (index >= 0) state.history[index] = next; else state.history.unshift(next);
    if (previousId && previousId !== next.id && state.historySelection.delete(previousId)) state.historySelection.add(next.id);
    if (previousId && expandedBatchId === previousId) expandedBatchId = next.id;
    if (state.selectedId === previousId || !state.selectedId) state.selectedId = next.id;
    renderHistory(); renderResult(); return next;
  }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      function abort() { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async function poll(batch, signal) {
    const start = Date.now();
    while (!terminal(batch)) {
      if (Date.now() - start >= config.maxPollDurationMs) throw new Error('상태조회 대기시간이 초과되었습니다. 처리번호를 유지합니다. 상태재조회로 확인하십시오.');
      setExecution(statusNames[batch.status] || '처리중', batch.id + ' / ' + (demo ? '가상 처리' : '서버 처리'), 'running');
      await sleep(config.pollIntervalMs, signal);
      batch = upsert(await api.getBatch(batch.id, { signal }));
    }
    return batch;
  }
  function finishExecution(batch) {
    if (batch.status === 'error') { setExecution('오류', batch.reason || '처리 오류', 'error'); message(batch.reason || '처리 중 오류가 발생했습니다.'); }
    else { setExecution('완료', batch.id + ' / ' + batch.decision, 'completed'); message((demo ? '[시연] ' : '') + batch.decision + ' · 처리번호 ' + batch.id, true); }
  }
  async function runVerification() {
    if ($('runVerification').disabled) return;
    state.busy = true; state.controller = new AbortController();
    const useFolder = usesFolder();
    const snapshot = useFolder ? localFolder.files : state.files.filter(item => !local || item.selected).map(item => item.file);
    const tempId = '요청-' + Date.now(); let acceptedId = null;
    const pending = { id: tempId, createdAt: new Date().toISOString(), fileCount: snapshot.length, files: snapshot.map(file => ({ name: file.name, size: file.size })), status: 'queued', decision: null, reason: '검증 접수 요청 중', totalAmount: null, travelers: [], settlementRows: [], issues: [], excelAvailable: false, source: demo ? 'demo' : 'api', localOnly: true };
    state.selectedId = tempId; state.page = 1; state.filter = {}; $('searchForm').reset(); state.historySelection.clear();
    upsert(pending); syncControls(); message(''); setExecution('대기', '등록 ' + snapshot.length + '건 접수 중', 'running');
    try {
      const result = await api.createBatch(snapshot, { useFolder, scenario: $('demoScenario').value, signal: state.controller.signal });
      acceptedId = result.id; const batch = upsert({ ...result, localOnly: false }, tempId);
      finishExecution(await poll(batch, state.controller.signal));
    } catch (error) {
      const text = error.name === 'AbortError' ? '요청이 중단되었습니다.' : error.message || '처리 중 오류가 발생했습니다.';
      if (acceptedId) {
        const batch = state.history.find(item => item.id === acceptedId); batch.monitorError = text + ' 서버 작업은 계속될 수 있습니다. 상태재조회를 이용하십시오.';
        setExecution('조회중단', acceptedId, 'error');
      } else {
        const batch = state.history.find(item => item.id === tempId); batch.status = 'error'; batch.reason = text + (demo ? '' : ' 접수 여부는 서버에서 확인하십시오. 자동 재전송하지 않습니다.');
        setExecution('오류', '접수 응답 미확인', 'error');
      }
      message(text); renderHistory(); renderResult();
    } finally { state.busy = false; state.controller = null; $('tinyProgress').hidden = true; syncControls(); }
  }
  async function refreshSelected() {
    const batch = state.history.find(item => item.id === state.selectedId);
    if (!batch || state.busy || batch.localOnly || terminal(batch)) return;
    state.busy = true; state.controller = new AbortController(); syncControls(); message('');
    try { finishExecution(await poll(upsert(await api.getBatch(batch.id, { signal: state.controller.signal })), state.controller.signal)); }
    catch (error) { const current = state.history.find(item => item.id === batch.id); current.monitorError = error.message; message(error.message); renderResult(); setExecution('조회중단', batch.id, 'error'); }
    finally { state.busy = false; state.controller = null; $('tinyProgress').hidden = true; syncControls(); }
  }
  async function saveDownload(fetchFile) {
    if (state.downloading) return;
    state.downloading = true; syncControls();
    try {
      const file = await fetchFile();
      const url = URL.createObjectURL(file.blob); const link = element('a'); link.href = url; link.download = file.filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      message((demo ? '[시연] ' : '') + file.filename + ' 다운로드 요청완료', true);
    } catch (error) { message(error.message || '다운로드 중 오류가 발생했습니다.'); }
    finally { state.downloading = false; syncControls(); }
  }
  function search(event) {
    if (event) event.preventDefault();
    if ($('startDate').value && $('endDate').value && $('startDate').value > $('endDate').value) { message('처리 시작일은 종료일 이후일 수 없습니다.'); return; }
    state.filter = { start: $('startDate').value, end: $('endDate').value, status: $('statusFilter').value, decision: $('decisionFilter').value, keyword: $('keyword').value.trim().toLowerCase() };
    state.page = 1; state.historySelection.clear(); renderHistory(); message('');
  }
  function markNavigation(section) {
    const names = { upload: '출장서류 등록', verification: '출장서류 검증', history: '검증 처리내역', results: '정산결과 조회' };
    document.querySelectorAll('.sidebar [data-nav]').forEach(link => { const selected = link.dataset.nav === section; link.classList.toggle('active', selected); if (selected) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); });
    document.querySelectorAll('.work-tabs a').forEach(link => link.classList.toggle('active', link.hash === '#' + (section === 'verification' ? 'upload' : section)));
    const topSection = section === 'history' || section === 'results' ? section : 'upload';
    document.querySelectorAll('.global-nav a').forEach(link => link.classList.toggle('current', link.dataset.nav === topSection));
    $('breadcrumbCurrent').textContent = names[section] || names.upload;
  }
  function showLocalFolder(folder) {
    localFolder = folder;
    const files = folder?.files || [];
    $('savedFolder').textContent = folder ? folder.display_path + ' · PDF ' + files.length + '건' : '선택된 폴더 없음';
    $('folderFiles').replaceChildren(...files.map(file => element('li', file.name + ' · ' + size(file.size))));
    $('folderFiles').hidden = !files.length;
    if (usesFolder()) setExecution('대기', files.length ? '폴더 PDF ' + files.length + '건 / 일괄검증 대상' : '폴더에서 PDF를 선택하세요.');
    syncControls();
  }

  function showLocalError(id, error) {
    $(id).textContent = error?.message || '';
    $(id).hidden = !error;
  }

  async function initLocal() {
    const settings = '/api/settings/pdf-folder';
    const dialog = $('folderDialog');
    let current;
    let changing = false;

    async function updateSession() {
      const [data, batches] = await Promise.all([
        api.localRequest(settings),
        api.localRequest('/api/verification/batches')
      ]);
      state.history = batches.map(api.normalizeBatch);
      signedIn = true;
      upstageConfigured = data.upstage_configured;
      showLocalFolder(data.folder);
      renderHistory();
      $('modeNotice').textContent = upstageConfigured
        ? '검증실행 시 처리 대상 PDF가 Upstage로 전송됩니다.'
        : 'Upstage API 키를 설정하면 검증실행을 사용할 수 있습니다.';
      if ($('localLogin').open) $('localLogin').close();
    }

    async function browse(path) {
      if (changing) return;
      changing = true;
      current = null;
      $('folderUp').disabled = $('useFolder').disabled = true;
      $('folderChildren').replaceChildren();
      showLocalError('folderError');
      try {
        current = await api.localRequest(settings + 's?path=' + encodeURIComponent(path));
        $('folderLocation').textContent = current.display_path;
        $('folderUp').disabled = current.parent === null;
        $('useFolder').disabled = false;
        $('folderChildren').replaceChildren(...current.children.map(folder => action(folder.name, () => browse(folder.path))));
      } catch (error) { showLocalError('folderError', error); }
      finally { changing = false; }
    }

    function showSource() {
      $('uploadFiles').hidden = usesFolder();
      $('localFolderPanel').hidden = !usesFolder();
      if (usesFolder()) showLocalFolder(localFolder);
      else renderFiles();
    }

    $('localSourcePanel').hidden = false;
    $('fileExportPanel').hidden = false;
    $('downloadFileExport').addEventListener('click', () => {
      const files = [...fileExportSelection.values()];
      if (files.length) saveDownload(() => api.downloadSelectedExcel(files));
    });
    $('clearFileExport').addEventListener('click', () => {
      fileExportSelection.clear();
      renderFileExport(visibleHistory());
    });
    $('sourceFolder').addEventListener('change', showSource);
    $('sourceUpload').addEventListener('change', showSource);
    showSource();
    $('localLogin').addEventListener('cancel', event => event.preventDefault());
    $('localLoginForm').addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      showLocalError('loginError');
      const password = $('localPassword').value;
      $('localPassword').value = '';
      try {
        await api.localRequest('/api/auth/login', 'POST', { password });
        await updateSession();
      } catch (error) { showLocalError('loginError', error); $('localPassword').focus(); }
      finally { button.disabled = false; }
    });
    $('localLogout').addEventListener('click', async () => {
      try { await api.localRequest('/api/auth/logout', 'POST'); location.reload(); }
      catch (error) { message(error.message); }
    });
    $('openFolders').addEventListener('click', () => {
      dialog.showModal();
      $('folderLocation').textContent = '';
      browse('.');
    });
    $('folderUp').addEventListener('click', () => browse(current.parent));
    $('useFolder').addEventListener('click', async () => {
      if (changing || !current) return;
      changing = true;
      $('useFolder').disabled = true;
      showLocalError('folderError');
      try {
        showLocalFolder(await api.localRequest(settings, 'PUT', { path: current.path }));
        dialog.close();
      } catch (error) { showLocalError('folderError', error); }
      finally { changing = false; $('useFolder').disabled = false; }
    });
    try { await updateSession(); }
    catch (_) { $('localLogin').showModal(); }
  }
  function init() {
    $('systemDate').textContent = dateKey().replaceAll('-', '.') + '  |  업무담당자 접속';
    $('modeLabel').textContent = demo ? '시연 모드' : 'API 연동 모드';
    $('sideMode').textContent = demo ? '시연 (가상)' : 'API 연동';
    $('accountName').textContent = demo ? '관리자 (시연)' : '업무담당자';
    $('footerMode').textContent = demo ? '시연용 · 가상 데이터' : 'API 연동';
    $('scenarioLabel').hidden = !demo;
    if (!demo) { $('modeNotice').textContent = '[API] 서버 처리결과 · 현재 화면에서 접수한 처리내역'; $('modeNotice').classList.add('live'); $('historyScope').textContent = '조회범위 : 현재 접속 중 접수한 작업'; }
    $('fileLimit').textContent = 'PDF 전용 · 최대 ' + config.maxFiles + '건 · 파일당 ' + size(config.maxFileSizeBytes) + ' · 파일 끌어놓기 가능' + (local ? ' · 체크한 PDF만 검증' : '');
    $('addFiles').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
    $('selectAllFiles').addEventListener('change', event => { state.files.forEach(file => { file.selected = event.target.checked; }); renderFiles(); });
    $('deleteSelected').addEventListener('click', () => removeFiles(state.files.filter(file => file.selected).map(file => file.id)));
    $('deleteAll').addEventListener('click', () => removeFiles(state.files.map(file => file.id)));
    $('runVerification').addEventListener('click', runVerification);
    $('closePreview').addEventListener('click', () => $('previewDialog').close()); $('previewDialog').addEventListener('close', closePreview);
    $('dropZone').addEventListener('dragover', event => { event.preventDefault(); if (!state.busy && !state.adding) $('dropZone').classList.add('dragging'); });
    $('dropZone').addEventListener('dragleave', event => { if (!$('dropZone').contains(event.relatedTarget)) $('dropZone').classList.remove('dragging'); });
    $('dropZone').addEventListener('drop', event => { event.preventDefault(); $('dropZone').classList.remove('dragging'); addFiles(event.dataTransfer.files); });
    window.addEventListener('dragover', event => event.preventDefault()); window.addEventListener('drop', event => event.preventDefault());
    $('searchForm').addEventListener('submit', search);
    $('resetSearch').addEventListener('click', () => { $('searchForm').reset(); search(); });
    $('todayFilter').addEventListener('click', () => { $('startDate').value = dateKey(); $('endDate').value = dateKey(); search(); });
    $('monthFilter').addEventListener('click', () => { const end = dateKey(); const date = new Date(end + 'T12:00:00+09:00'); date.setUTCDate(date.getUTCDate() - 30); $('startDate').value = dateKey(date); $('endDate').value = end; search(); });
    $('allDates').addEventListener('click', () => { $('startDate').value = ''; $('endDate').value = ''; search(); });
    $('pageSize').addEventListener('change', event => { state.pageSize = Number(event.target.value); state.page = 1; state.historySelection.clear(); renderHistory(); });
    $('selectAllHistory').addEventListener('change', event => { visibleHistory().forEach(batch => { if (event.target.checked) state.historySelection.add(batch.id); else state.historySelection.delete(batch.id); }); renderHistory(); });
    $('viewSelected').addEventListener('click', () => { if (state.historySelection.size === 1) selectResult([...state.historySelection][0], true); });
    $('refreshBatch').addEventListener('click', refreshSelected);
    document.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener('click', () => markNavigation(link.hash.slice(1))));
    window.addEventListener('hashchange', () => markNavigation(location.hash.slice(1)));
    window.addEventListener('beforeunload', event => { if (state.busy) { event.preventDefault(); event.returnValue = ''; } });
    renderFiles(); renderHistory();
    if (state.history.length) selectResult(state.history.find(batch => batch.status === 'completed')?.id || state.history[0].id, false);
    else renderResult();
    markNavigation(location.hash.slice(1) || 'upload');
    if (local) initLocal();
  }
  init();
})();
