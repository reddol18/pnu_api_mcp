import { describe, expect, it } from 'vitest';
import { cacheKey, TtlCache } from '../lib/cache';
import { clientIp, RateLimiter } from '../lib/rate-limit';

describe('TtlCache', () => {
  it('TTL이 지나면 사라진다', () => {
    let t = 0;
    const c = new TtlCache<number>(1000, 10, () => t);
    c.set('a', 1);
    expect(c.get('a')).toBe(1);
    t = 1000;
    expect(c.get('a')).toBeUndefined();
  });

  it('최대 개수를 넘으면 가장 오래 안 쓴 것부터 버린다', () => {
    const c = new TtlCache<number>(60_000, 2);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a'); // a를 최근 사용으로
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.get('c')).toBe(3);
  });

  it('캐시 키는 공백·대소문자 차이를 무시한다', () => {
    expect(cacheKey('  세종대로   110 ')).toBe(cacheKey('세종대로 110'));
  });
});

describe('RateLimiter', () => {
  it('창 안에서 한도를 넘으면 거절하고, 창이 지나면 다시 허용한다', () => {
    let t = 0;
    const r = new RateLimiter(2, 10_000, () => t);
    expect(r.check('1.1.1.1').ok).toBe(true);
    expect(r.check('1.1.1.1').ok).toBe(true);
    const third = r.check('1.1.1.1');
    expect(third).toEqual({ ok: false, retryAfterSec: 10 });
    expect(r.check('2.2.2.2').ok).toBe(true); // 다른 IP는 따로
    t = 10_000;
    expect(r.check('1.1.1.1').ok).toBe(true);
  });

  it('x-forwarded-for의 첫 IP', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }))).toBe('203.0.113.5');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});
