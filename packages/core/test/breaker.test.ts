import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CIRCUIT_OPEN_CODE,
  CircuitBreaker,
  describeIncomplete,
  failureKind,
  lookupParcelLedger,
  parseLedgerJson,
} from '../src/index.js';

const CITYHALL = '1114010300100310000'; // 서울특별시 중구 태평로1가 31

function responseText(name: string): string {
  const f = parseLedgerJson(readFileSync(new URL(`../fixtures/ledger/${name}.json`, import.meta.url), 'utf8')) as {
    response: unknown;
  };
  return JSON.stringify(f.response);
}

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('CircuitBreaker', () => {
  it('연속 실패가 기준에 닿으면 열리고, 열린 동안은 막는다', () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 3, openMs: 30_000, now: c.now });
    for (let i = 0; i < 2; i++) {
      expect(b.allow()).toBe(true);
      b.failure();
    }
    expect(b.current).toBe('closed');
    expect(b.allow()).toBe(true);
    b.failure();
    expect(b.current).toBe('open');
    expect(b.allow()).toBe(false);
    c.advance(10_000);
    expect(b.allow()).toBe(false);
    expect(b.remainingMs()).toBe(20_000);
  });

  it('성공하면 연속 실패 수가 0으로 돌아간다', () => {
    const b = new CircuitBreaker({ failureThreshold: 3 });
    b.failure();
    b.failure();
    b.success();
    b.failure();
    b.failure();
    expect(b.current).toBe('closed');
  });

  it('열림 시간이 지나면 반열림: 시험 호출 하나만 허용하고, 성공하면 닫힌다', () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 1, openMs: 30_000, now: c.now });
    b.failure();
    c.advance(30_000);
    expect(b.current).toBe('half_open');
    expect(b.allow()).toBe(true); // 시험 호출
    expect(b.allow()).toBe(false); // 시험 중에는 나머지를 막는다
    b.success();
    expect(b.current).toBe('closed');
    expect(b.allow()).toBe(true);
  });

  it('반열림 시험이 실패하면 다시 열린다', () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 1, openMs: 30_000, now: c.now });
    b.failure();
    c.advance(30_000);
    expect(b.allow()).toBe(true);
    b.failure();
    expect(b.current).toBe('open');
    expect(b.remainingMs()).toBe(30_000);
  });

  it('반열림 시험이 성공·실패 어느 쪽도 아니면(release) 다음 시험을 허용한다', () => {
    const c = clock();
    const b = new CircuitBreaker({ failureThreshold: 1, openMs: 1000, now: c.now });
    b.failure();
    c.advance(1000);
    expect(b.allow()).toBe(true);
    b.release();
    expect(b.allow()).toBe(true);
  });
});

describe('대장 조회 + 회로 차단기', () => {
  it('건축HUB가 계속 503이면 차단기가 열리고, 그 뒤 요청은 호출 없이 바로 CIRCUIT_OPEN', async () => {
    const f = vi.fn(async () => new Response(responseText('error-service-timeout'), { status: 503 }));
    const breaker = new CircuitBreaker({ failureThreshold: 5, openMs: 30_000 });
    const opts = { key: 'K', fetch: f as unknown as typeof fetch, sleep: async () => {}, breaker };

    const first = await lookupParcelLedger(CITYHALL, opts);
    expect(breaker.current).toBe('open');
    // 3 오퍼레이션이 동시에 돌며 5번째 실패에서 열린다 → 열린 뒤에는 기다렸다 다시 하지 않는다
    expect(f.mock.calls.length).toBeLessThan(9);
    const codes = [first.titles, first.recapTitles, first.attachedJibuns].map((r) =>
      r.status === 'error' ? r.error.code : r.status,
    );
    expect(codes.every((c) => c === '05' || c === CIRCUIT_OPEN_CODE)).toBe(true);

    f.mockClear();
    const second = await lookupParcelLedger(CITYHALL, opts);
    expect(f).not.toHaveBeenCalled();
    expect(second.titles).toMatchObject({ status: 'error', error: { code: CIRCUIT_OPEN_CODE } });
  });

  it('키 오류(30) 같은 설정 문제는 장애로 세지 않는다', async () => {
    const f = vi.fn(async () => new Response(responseText('error-key-not-registered'), { status: 403 }));
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    for (let i = 0; i < 3; i++) {
      await lookupParcelLedger(CITYHALL, { key: 'K', fetch: f as unknown as typeof fetch, breaker });
    }
    expect(breaker.current).toBe('closed');
  });

  it('건너뛴 소스는 재시도 안내와 함께 "건너뛰었다"고 알려 준다', () => {
    expect(failureKind(CIRCUIT_OPEN_CODE)).toBe('skipped');
    const inc = describeIncomplete([
      { source: '대장 표제부', code: CIRCUIT_OPEN_CODE, message: '', kind: failureKind(CIRCUIT_OPEN_CODE) },
    ]);
    expect(inc?.retryable).toBe(true);
    expect(inc?.message).toContain('건너뛰었다');
    expect(inc?.message).toContain('다시');
  });
});
