// CloudFront Function (cloudfront-js-2.0, viewer request) — 기본 동작(페이지·API) 앞 문지기 (이슈 #8)
// Lambda에 닿기 전에 가장자리에서 거절한다 → 스캐너 요청이 Lambda 호출·콜드 스타트·동시 실행을 쓰지 않는다.
// - 이 앱이 기본 동작으로 받는 경로는 / 와 /api/analyze 뿐이다(정적 파일·타일·안내 페이지는 다른 동작).
//   경로를 새로 만들면 ALLOWED에 넣어야 한다(CLAUDE.md).
// - 메서드는 GET·HEAD만.
// - BLOCKED: 자동 차단 IP → 차단 끝 시각(epoch 초). 차단 갱신 Lambda(pnu-web-guard)가 이 줄만 바꿔 다시 게시한다.
//   이 줄의 모양(한 줄, var BLOCKED = {...};)을 바꾸지 말 것.
// 모듈 문법(import/export)을 쓸 수 없는 런타임이다. 테스트는 이 파일을 그대로 읽어 handler를 꺼낸다.

var BLOCKED = {};

var ALLOWED = { '/': true, '/api/analyze': true };

function reject(status, text) {
  return {
    statusCode: status,
    statusDescription: text,
    headers: { 'cache-control': { value: 'no-store' } },
  };
}

function handler(event) {
  var request = event.request;
  var until = BLOCKED[event.viewer.ip];
  if (until && until > Date.now() / 1000) return reject(403, 'Forbidden');
  if (request.method !== 'GET' && request.method !== 'HEAD') return reject(405, 'Method Not Allowed');
  if (!ALLOWED[request.uri]) return reject(404, 'Not Found');
  return request;
}
