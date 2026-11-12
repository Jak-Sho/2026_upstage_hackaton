/* 브라우저 공개 설정. Upstage API 키나 비밀값을 넣지 마십시오. */
(function (global) {
  'use strict';
  global.TravelConfig = {
    mode: 'demo', // 'demo' 또는 'api'. 변경 후 페이지를 새로 여십시오.
    apiBaseUrl: '', // 같은 서버: ''. 별도 FastAPI: 'http://localhost:8000'
    // 아래 경로와 응답 형식은 협의용 예시입니다. 최종 서버 규격에 맞게 변경합니다.
    endpoints: {
      create: '/api/verification/batches',
      status: '/api/verification/batches/{id}',
      excel: '/api/verification/batches/{id}/excel'
    },
    fileField: 'files',
    credentials: 'same-origin', // 쿠키 인증/CORS 협의 후 필요한 경우 'include'
    requestTimeoutMs: 60000,
    pollIntervalMs: 1500,
    maxPollDurationMs: 600000,
    maxFiles: 50,
    maxFileSizeBytes: 25 * 1024 * 1024,
    responseAdapter: null // function (payload) { return 협의된_응답을_표준형으로_변환; }
  };
})(window);
