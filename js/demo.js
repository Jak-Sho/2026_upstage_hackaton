/* 업로드 PDF를 분석하지 않는 고정 가상 자료. 실제 API 모드에서는 사용하지 않음. */
(function (global) {
  'use strict';
  const records = new Map();
  let serial = 8;
  const clone = value => JSON.parse(JSON.stringify(value));
  const clock = value => new Date(value).toISOString();
  function resultFor(scenario, date) {
    if (scenario === 'error') return {
      status: 'error', decision: null, reason: '시연용 오류: 문서 처리 중 오류가 발생했습니다.',
      totalAmount: null, travelers: [], settlementRows: [], issues: [], excelAvailable: false
    };
    if (scenario === 'review') return {
      status: 'completed', decision: '검토 필요',
      reason: '출장신청서와 출장복명서의 출장기간이 일치하지 않습니다. (가상 자료)',
      totalAmount: null,
      travelers: [
        { name: '김하늘', decision: '검토 필요', reason: '신청서 09:00~18:00 / 복명서 10:00~18:00', amount: null },
        { name: '이도윤', decision: '정산 완료', reason: '출장자 및 출장 정보 일치', amount: 20000 }
      ],
      settlementRows: [],
      issues: [{ field: '김하늘 / 출장기간', message: '신청서 09:00~18:00, 복명서 10:00~18:00. 실제 출장기간 확인 필요.' }],
      excelAvailable: true
    };
    return {
      status: 'completed', decision: '정산 완료',
      reason: '출장자 명단 및 출장 정보 일치. 정산금액 산출 완료. (가상 자료)',
      totalAmount: 40000,
      travelers: [
        { name: '김하늘', decision: '정산 완료', reason: '명단·출장 정보 일치', amount: 20000 },
        { name: '이도윤', decision: '정산 완료', reason: '명단·출장 정보 일치', amount: 20000 }
      ],
      settlementRows: ['김하늘', '이도윤'].map(name => ({
        '출장기간': date + ' 09:00 ~ 18:00', '목적지': '대구광역시', '직위': '주무관',
        '성명': name, '금액': 20000, '영수인': '', '비고': '기관 간 업무협의 (가상)', '등록번호': '시연-2026-001'
      })),
      issues: [], excelAvailable: true
    };
  }
  function seedBatches() {
    return ['completed', 'review', 'completed', 'completed', 'error', 'review', 'completed'].map((scenario, index) => {
      const day = 12 - index;
      const date = '2026-11-' + String(day).padStart(2, '0');
      const batch = {
        id: 'DEMO-202611-' + String(7 - index).padStart(4, '0'),
        createdAt: clock(date + 'T' + (index % 2 ? '10:20' : '09:35') + ':00+09:00'),
        fileCount: index % 3 + 1,
        files: Array.from({ length: index % 3 + 1 }, (_, i) => ({ name: '가상_출장서류_' + (i + 1) + '.pdf', size: 186000 + i * 1000 })),
        source: 'demo', ...resultFor(scenario, date)
      };
      records.set(batch.id, { batch, scenario, seeded: true });
      return clone(batch);
    });
  }
  function assertNotAborted(signal) {
    if (signal && signal.aborted) throw new DOMException('요청이 중단되었습니다.', 'AbortError');
  }
  async function createBatch(files, options = {}) {
    assertNotAborted(options.signal);
    const scenario = ['review', 'error'].includes(options.scenario) ? options.scenario : 'completed';
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    const batch = {
      id: 'DEMO-' + date.replace(/-/g, '') + '-' + String(serial++).padStart(4, '0'),
      createdAt: new Date().toISOString(), fileCount: files.length,
      files: files.map(file => ({ name: file.name, size: file.size })),
      status: 'queued', decision: null, reason: '시연용 검증 대기', totalAmount: null,
      travelers: [], settlementRows: [], issues: [], excelAvailable: false, source: 'demo'
    };
    records.set(batch.id, { batch, scenario, date, polls: 0 });
    return clone(batch);
  }
  async function getBatch(id, options = {}) {
    assertNotAborted(options.signal);
    const record = records.get(id);
    if (!record) throw new Error('시연 처리내역을 찾을 수 없습니다.');
    if (!record.seeded && !['completed', 'error'].includes(record.batch.status)) {
      record.polls += 1;
      if (record.polls < 3) {
        record.batch.status = 'processing';
        record.batch.reason = '시연용 가상 검증 처리중';
      } else Object.assign(record.batch, resultFor(record.scenario, record.date));
    }
    return clone(record.batch);
  }
  async function downloadExcel(batch, options = {}) {
    assertNotAborted(options.signal);
    if (batch.source !== 'demo' || !batch.excelAvailable) throw new Error('다운로드할 시연 결과가 없습니다.');
    return { blob: global.TravelExcel.create(batch), filename: '시연용_가상_출장정산결과_' + batch.id + '.xlsx' };
  }
  global.TravelDemo = { seedBatches, createBatch, getBatch, downloadExcel };
})(window);
