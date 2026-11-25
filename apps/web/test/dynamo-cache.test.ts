import { randomBytes } from 'node:crypto';
import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { DynamoCache, type DynamoSender, dynamoCacheFromEnv, hashKey, MAX_ITEM_BYTES } from '../lib/dynamo-cache';

/** 메모리에 저장하는 가짜 DynamoDB (GetItem·PutItem만) */
function fakeDynamo() {
  const items = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const client: DynamoSender = {
    async send(cmd) {
      if (cmd instanceof PutItemCommand) {
        calls.push('put');
        const item = cmd.input.Item as Record<string, { S?: string }>;
        items.set(item.k?.S ?? '', item);
        return {};
      }
      if (cmd instanceof GetItemCommand) {
        calls.push('get');
        const k = (cmd.input.Key as Record<string, { S?: string }>).k?.S ?? '';
        return { Item: items.get(k) };
      }
      throw new Error('unexpected command');
    },
  };
  return { client, items, calls };
}

describe('DynamoCache', () => {
  it('저장한 값을 다시 읽는다(키는 해시, 값은 gzip)', async () => {
    const d = fakeDynamo();
    const c = new DynamoCache<{ a: number }>('t', 60_000, d.client);
    await c.set('세종대로 110', { a: 1 });
    expect(await c.get('세종대로 110')).toEqual({ a: 1 });
    // 테이블 키에 주소 원문이 없다
    expect([...d.items.keys()]).toEqual([hashKey('세종대로 110')]);
    expect([...d.items.keys()][0]).not.toContain('세종대로');
  });

  it('TTL이 지난 항목은 DynamoDB가 아직 안 지웠어도 버린다', async () => {
    const d = fakeDynamo();
    let t = 0;
    const c = new DynamoCache<number>('t', 10_000, d.client, () => t);
    await c.set('k', 1);
    t = 9_000;
    expect(await c.get('k')).toBe(1);
    t = 10_000;
    expect(await c.get('k')).toBeUndefined();
  });

  it('없으면 undefined', async () => {
    const c = new DynamoCache<number>('t', 10_000, fakeDynamo().client);
    expect(await c.get('없음')).toBeUndefined();
  });

  it('DynamoDB 오류는 삼키고(캐시 없이 처리) 오류 이름만 알린다', async () => {
    const errors: string[] = [];
    const broken: DynamoSender = {
      async send() {
        throw Object.assign(new Error('boom'), { name: 'ProvisionedThroughputExceededException' });
      },
    };
    const c = new DynamoCache<number>('t', 10_000, broken, Date.now, (op) => errors.push(op));
    await expect(c.set('k', 1)).resolves.toBeUndefined();
    await expect(c.get('k')).resolves.toBeUndefined();
    expect(errors).toEqual(['set', 'get']);
  });

  it('압축해도 항목 한도에 가까우면 저장하지 않는다', async () => {
    const d = fakeDynamo();
    const c = new DynamoCache<string>('t', 10_000, d.client);
    // 압축이 잘 안 되는 큰 값(난수)
    await c.set('k', randomBytes(MAX_ITEM_BYTES * 2).toString('base64'));
    expect(d.calls).toEqual([]);
  });

  it('CACHE_TABLE이 없으면(로컬·테스트) 만들지 않는다', () => {
    expect(dynamoCacheFromEnv(1000, {})).toBeNull();
    expect(dynamoCacheFromEnv(1000, { CACHE_TABLE: 'pnu-web-cache' })).toBeInstanceOf(DynamoCache);
  });
});
