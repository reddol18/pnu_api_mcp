// CloudFront Function (cloudfront-js-2.0, viewer request) — /tiles/{z}/{y}/{x}.png
// 브이월드 배경지도(WMTS Base)를 CloudFront가 직접 받아 오게 주소를 바꾼다. 키는 CloudFront 원본 경로에 있다
// (/req/wmts/1.0.0/{key}/Base). 이 함수는 키를 모른다.
// - 레벨 6~19만(Base 레벨, 명세). 브이월드는 범위 밖 요청에도 200 + XML 오류를 주므로 여기서 막는다.
// - 한국 범위 밖 타일은 거절 → 우리 키로 다른 지역 타일을 긁어 가지 못하게.
// 모듈 문법(import/export)을 쓸 수 없는 런타임이다. 테스트는 이 파일을 그대로 읽어 handler를 꺼낸다.

var MIN_Z = 6;
var MAX_Z = 19;
// 대략적인 한국 범위(제주·마라도·독도 포함, 여유 있게)
var LON_MIN = 124;
var LON_MAX = 132;
var LAT_MIN = 32.9;
var LAT_MAX = 39;

function lonToX(lon, n) {
  return Math.floor(((lon + 180) / 360) * n);
}

function latToY(lat, n) {
  var r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
}

function reject(status, text) {
  return {
    statusCode: status,
    statusDescription: text,
    headers: { 'cache-control': { value: 'public, max-age=86400' } },
  };
}

function handler(event) {
  var request = event.request;
  var m = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/.exec(request.uri);
  if (!m) return reject(404, 'Not Found');
  var z = Number(m[1]);
  var y = Number(m[2]);
  var x = Number(m[3]);
  if (z < MIN_Z || z > MAX_Z) return reject(404, 'Not Found');
  var n = Math.pow(2, z);
  if (x >= n || y >= n) return reject(404, 'Not Found');
  // 위도가 클수록 y가 작다
  if (x < lonToX(LON_MIN, n) || x > lonToX(LON_MAX, n) || y < latToY(LAT_MAX, n) || y > latToY(LAT_MIN, n)) {
    return reject(403, 'Forbidden');
  }
  // 원본 경로(/req/wmts/1.0.0/{key}/Base) 뒤에 붙을 부분만 남긴다. 쿼리는 버린다.
  request.uri = '/' + z + '/' + y + '/' + x + '.png';
  request.querystring = {};
  return request;
}
