import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// CloudFront Function 파일을 배포되는 그대로 읽어 handler를 꺼낸다(모듈 문법이 없는 런타임이라)
const source = readFileSync(new URL('../cloudfront/guard.js', import.meta.url), 'utf8');
type Req = { method: string; uri: string; headers: Record<string, { value: string }> };
type Res = { statusCode: number; body?: { data: string } };
const load = (code: string) =>
  new Function(`${code}; return handler;`)() as (e: { request: Req; viewer: { ip: string } }) => Req | Res;

const updater = createRequire(import.meta.url)('../cloudfront/guard-updater.cjs') as {
  parseBlocked(code: string): Record<string, number>;
  writeBlocked(code: string, map: Record<string, number>): string;
  nextBlocked(
    current: Record<string, number>,
    offenders: string[],
    now: number,
    blockSec: number,
    max: number,
  ): Record<string, number>;
  offenderQuery(maxRequests: number, maxErrors: number): string;
};

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const run = (method: string, uri: string, ip = '198.51.100.1', code = source, ua = CHROME) =>
  load(code)({ request: { method, uri, headers: { 'user-agent': { value: ua } } }, viewer: { ip } });
const passed = (r: Req | Res) => 'uri' in r;

describe('문지기 CloudFront Function', () => {
  it.each([
    ['GET', '/'],
    ['HEAD', '/'],
    ['GET', '/api/analyze'],
  ])('통과: %s %s', (m, uri) => {
    expect(run(m, uri)).toMatchObject({ method: m, uri });
  });

  it.each(['/.env', '/wp-login.php', '/.git/config', '/api/analyze/', '/admin', '/index.html', '/favicon.ico'])(
    '없는 경로는 404: %s',
    (uri) => {
      expect(run('GET', uri)).toMatchObject({ statusCode: 404 });
    },
  );

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])('허용하지 않는 메서드는 405: %s', (m) => {
    expect(run(m, '/api/analyze')).toMatchObject({ statusCode: 405 });
  });

  it('차단 목록의 IP는 기한 전까지 403, 기한 뒤에는 통과', () => {
    const now = Math.floor(Date.now() / 1000);
    const code = updater.writeBlocked(source, { '203.0.113.9': now + 3600, '203.0.113.10': now - 1 });
    expect(run('GET', '/', '203.0.113.9', code)).toMatchObject({ statusCode: 403 });
    expect(passed(run('GET', '/', '203.0.113.10', code))).toBe(true);
    expect(passed(run('GET', '/', '198.51.100.1', code))).toBe(true);
  });
});

describe('크롤러 정책 (#10)', () => {
  const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  const GPTBOT =
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)';
  const YETI = 'Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)';
  const get = (uri: string, ua: string) => run('GET', uri, '198.51.100.1', source, ua);

  it('robots.txt를 바로 돌려준다: 주요 크롤러는 / 허용·/api/ 거절, 나머지는 전부 거절', () => {
    const r = get('/robots.txt', CHROME) as Res;
    expect(r.statusCode).toBe(200);
    const txt = r.body?.data ?? '';
    for (const t of ['Googlebot', 'Google-Extended', 'Applebot-Extended', 'GPTBot', 'ClaudeBot', 'Yeti', 'bingbot']) {
      expect(txt).toContain(`User-agent: ${t}\n`);
    }
    expect(txt).toContain('Allow: /\nDisallow: /api/\n');
    expect(txt.endsWith('User-agent: *\nDisallow: /\n')).toBe(true);
  });

  it.each([GOOGLEBOT, GPTBOT, YETI])('주요 크롤러는 페이지 통과, 조회는 403: %s', (ua) => {
    expect(passed(get('/', ua))).toBe(true);
    expect(get('/api/analyze', ua)).toMatchObject({ statusCode: 403 });
  });

  it.each([
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
    'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
    'Mozilla/5.0 (compatible; Some-crawler/1.0)',
  ])('목록 밖 자칭 크롤러는 페이지도 403: %s', (ua) => {
    expect(get('/', ua)).toMatchObject({ statusCode: 403 });
  });

  it.each([
    CHROME,
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 11; CUBOT_X30 Build/RP1A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    '',
  ])('일반 브라우저(휴대폰 제조사 CUBOT 포함)는 그대로: %s', (ua) => {
    expect(passed(get('/', ua))).toBe(true);
    expect(passed(get('/api/analyze', ua))).toBe(true);
  });
});

describe('차단 갱신 Lambda 로직', () => {
  it('원본의 BLOCKED 줄은 빈 목록이고, 바꿔 쓴 뒤 다시 읽힌다', () => {
    expect(updater.parseBlocked(source)).toEqual({});
    const code = updater.writeBlocked(source, { b: 2, a: 1 });
    expect(updater.parseBlocked(code)).toEqual({ a: 1, b: 2 });
    expect(code).toContain('var BLOCKED = {"a":1,"b":2};');
    // 다른 줄은 그대로
    expect(code.replace(/^var BLOCKED = .*$/m, '')).toBe(source.replace(/^var BLOCKED = .*$/m, ''));
  });

  it('기한 지난 IP는 빼고, 새로 걸린 IP는 넣고, 다시 걸리면 늘린다', () => {
    const next = updater.nextBlocked({ old: 100, keep: 5000, again: 2000 }, ['new', 'again'], 1000, 3600, 10);
    expect(next).toEqual({ keep: 5000, again: 4600, new: 4600 });
  });

  it('상한을 넘으면 늦게 풀리는 것부터 남긴다', () => {
    const next = updater.nextBlocked({ a: 2000, b: 3000, c: 4000 }, [], 1000, 3600, 2);
    expect(Object.keys(next).sort()).toEqual(['b', 'c']);
  });

  it('질의: 시작 확인 요청(127.0.0.1)을 빼고 기준값을 숫자로만 넣는다', () => {
    const q = updater.offenderQuery(300, 50);
    expect(q).toContain('ip != "127.0.0.1"');
    expect(q).toContain('filter n >= 300 or err >= 50');
    expect(() => updater.offenderQuery('1; drop' as unknown as number, 2)).toThrow();
    expect(() => updater.offenderQuery(0, 2)).toThrow();
  });
});
