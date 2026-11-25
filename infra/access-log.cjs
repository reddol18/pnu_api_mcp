// 요청 로그(이슈 #7): Next 서버보다 먼저 불러와(node --require) 모든 HTTP 응답을 JSON 한 줄로 남긴다.
// Lambda는 표준 출력을 CloudWatch 로그(/aws/lambda/pnu-web, 7일 보관)로 보낸다.
// - 쿼리 문자열은 남기지 않는다(조회 주소는 개인정보일 수 있다). 쿠키·본문도 남기지 않는다.
// - IP는 CloudFront가 넘기는 방문자 주소(CloudFront-Viewer-Address, 없으면 X-Forwarded-For 첫 값).
const http = require('node:http');

/** "203.0.113.5:443" · "2001:db8::1:443" → 포트를 뗀 주소 */
function viewerIp(headers) {
  const v = headers['cloudfront-viewer-address'];
  if (typeof v === 'string' && v.includes(':')) return v.slice(0, v.lastIndexOf(':'));
  const xff = headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return null;
}

function accessLine(req, res, ms) {
  const url = req.url ?? '';
  const q = url.indexOf('?');
  const ua = req.headers['user-agent'];
  return JSON.stringify({
    log: 'access',
    m: req.method,
    p: (q >= 0 ? url.slice(0, q) : url).slice(0, 200),
    s: res.statusCode,
    ms: Math.round(ms),
    ip: viewerIp(req.headers),
    ua: typeof ua === 'string' ? ua.slice(0, 120) : null,
  });
}

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function patchedEmit(event, req, res) {
  if (event === 'request' && req && res) {
    const t0 = process.hrtime.bigint();
    // 처리 시간은 응답을 끝내는 순간(res.end 호출)으로 잰다. finish는 Lambda가 실행 환경을 얼린 뒤
    // 다음 호출 때야 올 수 있어 얼어 있던 시간까지 더해진다(이슈 #9). 줄은 응답 코드가 확정된 finish에서 쓴다.
    let t1;
    const end = res.end;
    res.end = function patchedEnd() {
      t1 ??= process.hrtime.bigint();
      // biome-ignore lint/complexity/noArguments: 원래 end에 받은 인자를 그대로 넘긴다
      return end.apply(this, arguments);
    };
    res.once('finish', () => {
      try {
        const ms = Number((t1 ?? process.hrtime.bigint()) - t0) / 1e6;
        process.stdout.write(`${accessLine(req, res, ms)}\n`);
      } catch {
        // 로그 때문에 응답이 깨지면 안 된다
      }
    });
  }
  // biome-ignore lint/complexity/noArguments: 원래 emit에 받은 인자를 그대로 넘긴다
  return emit.apply(this, arguments);
};

module.exports = { viewerIp, accessLine };
