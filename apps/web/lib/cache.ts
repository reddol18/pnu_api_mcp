/**
 * 메모리 결과 캐시 (TTL + 최대 개수, 오래된 것부터 버림).
 * Lambda 인스턴스마다 따로라 완전한 캐시는 아니다 — 설계 §6의 DB 캐시 전까지의 1단계.
 * 일부 소스가 실패한 결과(incomplete)는 넣지 않는다 → 다시 물으면 다시 조회한다.
 */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // 최근 사용으로 갱신 (Map은 넣은 순서를 지킨다)
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/** 캐시 키: 공백·대소문자 차이를 없앤 입력 */
export function cacheKey(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}
