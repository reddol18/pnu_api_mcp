/**
 * IP별 요청 제한 (고정 창). 공개 웹에서 남이 우리 키의 일일 한도를 다 쓰지 않게 한다(설계 §6).
 * 메모리라 Lambda 인스턴스마다 따로 센다 — 대략적인 보호다.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** 허용하면 true. 거절이면 다시 시도할 수 있을 때까지 남은 초를 함께 준다. */
  check(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const t = this.now();
    const e = this.hits.get(ip);
    if (!e || t - e.windowStart >= this.windowMs) {
      this.hits.set(ip, { count: 1, windowStart: t });
      this.prune(t);
      return { ok: true };
    }
    if (e.count < this.limit) {
      e.count++;
      return { ok: true };
    }
    return { ok: false, retryAfterSec: Math.ceil((e.windowStart + this.windowMs - t) / 1000) };
  }

  private prune(t: number) {
    if (this.hits.size < 10_000) return;
    for (const [ip, e] of this.hits) if (t - e.windowStart >= this.windowMs) this.hits.delete(ip);
  }
}

/** 프록시 뒤의 클라이언트 IP. x-forwarded-for의 첫 값, 없으면 unknown */
export function clientIp(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  const first = xff?.split(',')[0]?.trim();
  return first || headers.get('x-real-ip') || 'unknown';
}
