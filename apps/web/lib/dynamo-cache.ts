/**
 * 판정 결과 공유 캐시 (DynamoDB 온디맨드, 이슈 #3).
 *
 * 메모리 캐시(cache.ts)는 Lambda 인스턴스마다 따로라 트래픽이 늘어 인스턴스가 많아질수록 적중이 떨어진다.
 * DynamoDB에 두면 모든 인스턴스가 같이 쓴다 → 같은 주소를 다시 물어도 공공 API를 부르지 않는다.
 *
 * - 키: 정규화한 입력(cacheKey)의 SHA-256. 테이블 키에 주소 원문을 두지 않는다.
 * - 값: 응답 본문 JSON을 gzip으로 줄여 바이너리로. 쓰기 요금이 1KB 단위라 압축이 곧 비용이다.
 * - 만료: TTL 속성(ttl, 초). DynamoDB의 TTL 삭제는 늦을 수 있어 읽을 때도 만료를 확인한다.
 * - DynamoDB가 느리거나 안 되면 캐시 없이 그대로 처리한다(캐시 장애가 서비스 장애가 되지 않게).
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

/** DynamoDB 항목 한도 400KB. 여유를 두고 넘으면 저장하지 않는다 */
export const MAX_ITEM_BYTES = 350 * 1024;
/** 캐시 호출 하나의 제한 시간. 같은 리전 DynamoDB는 보통 수 ms */
const TIMEOUT_MS = 300;

export interface SharedCache<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
}

/** SDK 클라이언트 중 쓰는 부분만 (테스트에서 바꿔 끼운다) */
export interface DynamoSender {
  send(command: GetItemCommand | PutItemCommand, opts?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export class DynamoCache<V> implements SharedCache<V> {
  constructor(
    private readonly table: string,
    private readonly ttlMs: number,
    private readonly client: DynamoSender,
    private readonly now: () => number = Date.now,
    private readonly onError: (op: 'get' | 'set', e: unknown) => void = logError,
  ) {}

  async get(key: string): Promise<V | undefined> {
    try {
      const out = (await this.client.send(
        new GetItemCommand({ TableName: this.table, Key: { k: { S: hashKey(key) } } }),
        { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
      )) as { Item?: { v?: { B?: Uint8Array }; ttl?: { N?: string } } };
      const item = out.Item;
      const bytes = item?.v?.B;
      if (!bytes) return undefined;
      if (Number(item?.ttl?.N ?? 0) * 1000 <= this.now()) return undefined;
      return JSON.parse(gunzipSync(bytes).toString('utf8')) as V;
    } catch (e) {
      this.onError('get', e);
      return undefined;
    }
  }

  async set(key: string, value: V): Promise<void> {
    try {
      const bytes = gzipSync(JSON.stringify(value));
      if (bytes.length > MAX_ITEM_BYTES) return;
      await this.client.send(
        new PutItemCommand({
          TableName: this.table,
          Item: {
            k: { S: hashKey(key) },
            v: { B: bytes },
            ttl: { N: String(Math.floor((this.now() + this.ttlMs) / 1000)) },
          },
        }),
        { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
      );
    } catch (e) {
      this.onError('set', e);
    }
  }
}

function logError(op: 'get' | 'set', e: unknown): void {
  // 입력 주소는 남기지 않는다(설계 §9). 오류 이름만
  console.warn(JSON.stringify({ cacheError: op, name: e instanceof Error ? e.name : 'unknown' }));
}

/** CACHE_TABLE이 있을 때만(배포 환경) DynamoDB 캐시를 만든다. 로컬·테스트는 null */
export function dynamoCacheFromEnv<V>(
  ttlMs: number,
  env: Record<string, string | undefined> = process.env,
): DynamoCache<V> | null {
  const table = env.CACHE_TABLE;
  if (!table) return null;
  return new DynamoCache<V>(table, ttlMs, new DynamoDBClient({ maxAttempts: 2 }));
}
