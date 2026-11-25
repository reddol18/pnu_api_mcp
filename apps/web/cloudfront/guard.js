// CloudFront Function (cloudfront-js-2.0, viewer request) — 기본 동작(페이지·API) 앞 문지기 (이슈 #8, #10)
// Lambda에 닿기 전에 가장자리에서 거절한다 → 스캐너 요청이 Lambda 호출·콜드 스타트·동시 실행을 쓰지 않는다.
// - 이 앱이 기본 동작으로 받는 경로는 / 와 /api/analyze 뿐이다(정적 파일·타일·안내 페이지는 다른 동작).
//   경로를 새로 만들면 ALLOWED에 넣어야 한다(CLAUDE.md).
// - 메서드는 GET·HEAD만.
// - 크롤러(#10): 주요 회사의 검색·AI 크롤러만 / 허용, 조회(/api/)는 어떤 크롤러도 안 된다.
//   /robots.txt는 여기서 바로 돌려준다. robots.txt를 안 지키는 크롤러는 User-Agent로도 막는다.
//   bingbot·Yeti·Daumoa는 공식 문서로 확인하지 못한 이름이다(이슈 #10, 방문 로그로 확인할 것).
// - BLOCKED: 자동 차단 IP → 차단 끝 시각(epoch 초). 차단 갱신 Lambda(pnu-web-guard)가 이 줄만 바꿔 다시 게시한다.
//   이 줄의 모양(한 줄, var BLOCKED = {...};)을 바꾸지 말 것.
// 모듈 문법(import/export)을 쓸 수 없는 런타임이다. 테스트는 이 파일을 그대로 읽어 handler를 꺼낸다.

var BLOCKED = {};

var ALLOWED = { '/': true, '/api/analyze': true };

// robots.txt 토큰. -Extended 두 개는 AI 학습 허용 여부만 정하는 토큰(실제 요청은 오지 않음)
var CRAWLER_TOKENS = [
  'Googlebot',
  'Google-Extended',
  'bingbot',
  'Yeti',
  'Daumoa',
  'Applebot',
  'Applebot-Extended',
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
];

// 실제 User-Agent 헤더에서 찾는 이름(대소문자 무시)
var MAJOR_CRAWLER =
  /googlebot|bingbot|yeti|daumoa|applebot|gptbot|oai-searchbot|chatgpt-user|claudebot|claude-user|claude-searchbot/i;
// 스스로 크롤러라고 밝힌 User-Agent: "XxxBot/1.0", "XxxBot;", "(compatible; ...; +https://...)" 꼴.
// 그냥 "bot"을 찾으면 휴대폰 제조사 이름(CUBOT 등)까지 걸린다
var SELF_DECLARED_BOT = /bot\/|bot;|bot\)|crawler|spider|slurp|\+https?:\/\//i;

var ROBOTS_TXT =
  'User-agent: ' +
  CRAWLER_TOKENS.join('\nUser-agent: ') +
  '\nAllow: /\nDisallow: /api/\n\nUser-agent: *\nDisallow: /\n';

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
  if (request.uri === '/robots.txt') {
    return {
      statusCode: 200,
      statusDescription: 'OK',
      headers: {
        'content-type': { value: 'text/plain; charset=utf-8' },
        'cache-control': { value: 'public, max-age=86400' },
      },
      body: { encoding: 'text', data: ROBOTS_TXT },
    };
  }
  if (!ALLOWED[request.uri]) return reject(404, 'Not Found');
  var ua = request.headers['user-agent'] ? request.headers['user-agent'].value : '';
  var major = MAJOR_CRAWLER.test(ua);
  if (!major && SELF_DECLARED_BOT.test(ua)) return reject(403, 'Forbidden');
  if (major && request.uri !== '/') return reject(403, 'Forbidden');
  return request;
}
