import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ServerDeps } from '../src/server.js';

const SANGBONG = '1126010200101260039';
const SQUARE_PNU = '1114010300100310000';

/**
 * 작은 가짜 공공 API: juso·대장은 0건, VWorld는 SQUARE_PNU에만 사각형 필지를 준다(건물 없음).
 * 응답 모양은 core fixtures의 실제 응답과 같다.
 */
const stubFetch = (async (input: string | URL) => {
  const u = new URL(String(input));
  const ok = (b: unknown) => new Response(JSON.stringify(b));
  if (u.host === 'business.juso.go.kr') {
    return ok({
      results: {
        common: { totalCount: '0', currentPage: '1', countPerPage: '20', errorCode: '0', errorMessage: '정상' },
        juso: [],
      },
    });
  }
  if (u.host === 'apis.data.go.kr') {
    return ok({
      response: {
        header: { resultCode: '00', resultMsg: 'NORMAL SERVICE' },
        body: { items: { item: [] }, totalCount: 0, pageNo: 1, numOfRows: 100 },
      },
    });
  }
  if (u.searchParams.get('attrFilter') === `pnu:=:${SQUARE_PNU}`) {
    return ok({
      response: {
        status: 'OK',
        record: { total: '1', current: '1' },
        page: { total: '1', current: '1', size: '1000' },
        result: {
          featureCollection: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: { pnu: SQUARE_PNU, addr: '서울특별시 중구 태평로1가 31', jibun: '31대' },
                geometry: {
                  type: 'Polygon',
                  coordinates: [
                    [
                      [126.977, 37.566],
                      [126.979, 37.566],
                      [126.979, 37.567],
                      [126.977, 37.567],
                      [126.977, 37.566],
                    ],
                  ],
                },
              },
            ],
          },
        },
      },
    });
  }
  return ok({ response: { status: 'NOT_FOUND', record: { total: '0', current: '0' } } });
}) as typeof fetch;

const KEYS = { jusoKey: 'J', dataGoKrKey: 'D', vworldKey: 'V', vworldDomain: 'https://pnu.reddol18.pe.kr' };

async function connect(deps: ServerDeps) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer(deps).connect(serverT), client.connect(clientT)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, string>) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]?.text ?? '';
  return { isError: Boolean(r.isError), text, body: text.startsWith('{') ? JSON.parse(text) : text };
}

describe('MCP 서버', () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect({ keys: KEYS, fetch: stubFetch, sleep: async () => {} });
  });
  afterAll(async () => {
    await client.close();
  });

  it('도구 5개', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'building_parcels',
      'classify_relation',
      'decode_pnu',
      'parcel_buildings',
      'resolve_address',
    ]);
  });

  it('decode_pnu: 상봉동 126-39', async () => {
    const { isError, body } = await call(client, 'decode_pnu', { pnu: SANGBONG });
    expect(isError).toBe(false);
    expect(body.jibunAddress).toBe('서울특별시 중랑구 상봉동 126-39');
    expect(body.ledgerKey).toEqual({ sigunguCd: '11260', bjdongCd: '10200', platGbCd: '0', bun: '0126', ji: '0039' });
  });

  it('decode_pnu: 형식 오류는 isError', async () => {
    expect((await call(client, 'decode_pnu', { pnu: '123' })).isError).toBe(true);
  });

  it('classify_relation: 요약·불일치·지번주소가 붙고, 도형 좌표는 빠진다', async () => {
    const { isError, text, body } = await call(client, 'classify_relation', { input: SANGBONG });
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      status: 'ok',
      inputKind: 'pnu',
      start: 'parcel',
      relationNotation: '건물 수 : 필지 수',
    });
    expect(body.summary).toContain('서울특별시 중랑구 상봉동 126-39');
    expect(body.discrepancies.map((d: { code: string }) => d.code)).toEqual(['parcel_not_in_cadastral']);
    expect(text).not.toContain('coordinates');
    expect(body.raw).toBeUndefined();
  });

  it('필지 경계를 받아도 결과에 좌표를 싣지 않는다', async () => {
    const { text, body } = await call(client, 'parcel_buildings', { input: SQUARE_PNU });
    expect(body.spatial.status).toBe('empty'); // 건물 없음
    expect(text).not.toContain('coordinates');
    expect(text).not.toContain('126.977');
  });

  it('지번주소는 법정동코드 표로 PNU를 만들어 조회한다 (juso 0건이어도)', async () => {
    const { body } = await call(client, 'parcel_buildings', { input: '중랑구 상봉동 126-39' });
    expect(body).toMatchObject({ status: 'ok', pnu: SANGBONG });
    expect(body.notes[0]).toContain('법정동코드 표');
  });

  it('parcel_buildings에 도로명주소를 넣으면 맞는 도구를 안내한다', async () => {
    const r = await call(client, 'parcel_buildings', { input: '세종대로 110' });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ status: 'wrong_tool', inputKind: 'road' });
    expect(r.body.message).toContain('building_parcels');
  });

  it('building_parcels에 PNU를 넣으면 맞는 도구를 안내한다', async () => {
    const r = await call(client, 'building_parcels', { input: SANGBONG });
    expect(r.body).toMatchObject({ status: 'wrong_tool', inputKind: 'pnu' });
    expect(r.body.message).toContain('parcel_buildings');
  });

  it('resolve_address: 지번주소면 법정동코드 표 필지 후보를 준다 (상봉동은 두 곳)', async () => {
    const { body } = await call(client, 'resolve_address', { query: '상봉동 126-39' });
    expect(body.inputKind).toBe('jibun');
    expect(body.candidates).toEqual([]);
    expect(body.parcels.map((p: { pnu: string }) => p.pnu)).toContain(SANGBONG);
    expect(body.parcels).toHaveLength(2);
  });
});

describe('키가 없을 때', () => {
  it('설정 문제라 다시 물어도 소용없다고 안내한다', async () => {
    const client = await connect({
      keys: { jusoKey: '', dataGoKrKey: '', vworldKey: '', vworldDomain: '' },
      fetch: stubFetch,
    });
    const { body } = await call(client, 'classify_relation', { input: SANGBONG });
    expect(body.incomplete.retryable).toBe(false);
    expect(body.incomplete.message).toContain('.env');
    expect(body.summary).toContain('설정 확인');
    await client.close();
  });
});
