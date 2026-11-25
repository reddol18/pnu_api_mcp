import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  BLD_HUB_BASE_URL,
  getTitles,
  ledgerParcel,
  lookupParcelLedger,
  normalizeAttachedJibun,
  normalizeRecapTitle,
  normalizeTitle,
  parseLedgerJson,
  parseLedgerPage,
} from '../src/index.js';

const CITYHALL = '1114010300100310000'; // 서울특별시 중구 태평로1가 31
const NAMSAN = '1117010200200010003'; // 서울특별시 용산구 용산동2가 산1-3
const NANGSEONG = '4311131025101200003'; // 충청북도 청주시 상당구 낭성면 이목리 120-3

function fixtureText(name: string): string {
  return readFileSync(new URL(`../fixtures/ledger/${name}.json`, import.meta.url), 'utf8');
}

/** fixture의 response 부분만 API 응답 원문처럼 꺼낸다 */
function responseText(name: string): string {
  const f = parseLedgerJson(fixtureText(name)) as { response: unknown };
  return JSON.stringify(f.response);
}

function page(name: string) {
  return parseLedgerPage(JSON.parse(responseText(name)));
}

describe('parseLedgerJson', () => {
  it('큰 정수 PK를 문자열로 보존한다', () => {
    const j = parseLedgerJson('{"mgmBldrgstPk": 12345678901234567890, "totArea": 1.5}') as Record<string, unknown>;
    expect(j.mgmBldrgstPk).toBe('12345678901234567890');
    expect(j.totArea).toBe(1.5);
  });
});

describe('표제부 (getBrTitleInfo)', () => {
  it('서울시청: 동 2개, 한 동은 외필지 1', () => {
    const titles = page('title-seoul-cityhall').items.map(normalizeTitle);
    expect(titles).toHaveLength(2);
    for (const t of titles) expect(t.parcel.pnu).toBe(CITYHALL);
    const sinkwan = titles.find((t) => t.dongName === '신관');
    expect(sinkwan).toMatchObject({
      pk: '10031100209993',
      buildingName: '서울특별시 청사',
      registerKind: '2',
      registerKindName: '일반건축물',
      mainOrAttached: 'main',
      mainPurpose: '업무시설',
      totalArea: 83625.55,
      otherParcelCount: 0,
      roadAddress: '서울특별시 중구 세종대로 110 (태평로1가)',
    });
    const other = titles.find((t) => t.pk === '100311530');
    expect(other?.buildingName).toBeNull(); // 빈 값은 " "로 온다
    expect(other?.otherParcelCount).toBe(1);
  });

  it('남산 산1-3: 대장 platGbCd 1 → PNU 필지구분 2, 주건축물 1 + 부속건축물 2', () => {
    const titles = page('title-namsan-mountain').items.map(normalizeTitle);
    expect(titles.map((t) => t.parcel.pnu)).toEqual([NAMSAN, NAMSAN, NAMSAN]);
    expect(titles.filter((t) => t.mainOrAttached === 'attached')).toHaveLength(2);
    expect(titles.find((t) => t.mainOrAttached === 'main')?.buildingName).toBe('서울타워');
  });

  it('집합건물(정원팰리스): 표제부 3동', () => {
    const titles = page('title-jungwon-palace').items.map(normalizeTitle);
    expect(titles.map((t) => t.dongName).sort()).toEqual(['101동', '102동', '103동']);
    expect(titles.every((t) => t.registerType === '2' && t.registerKind === '3')).toBe(true);
  });

  it.each(['title-sangbong-126-39-none', 'title-nangseong-office-none'])('0건: %s', (name) => {
    expect(page(name)).toMatchObject({ totalCount: 0, items: [] });
  });
});

describe('총괄표제부 (getBrRecapTitleInfo)', () => {
  it('정원팰리스: 집합, 주건축물 3', () => {
    const [r] = page('recap-jungwon-palace').items.map(normalizeRecapTitle);
    expect(r).toMatchObject({ registerType: '2', registerKind: '1', buildingName: '정원팰리스', mainBuildingCount: 3 });
  });

  it('낭성면 행정복지센터: 총괄표제부는 있는데 같은 지번 표제부는 0건', () => {
    const [r] = page('recap-nangseong-office').items.map(normalizeRecapTitle);
    expect(r).toMatchObject({ parcel: { pnu: NANGSEONG }, mainBuildingCount: 3, otherParcelCount: 2 });
    expect(page('title-nangseong-office-none').items).toEqual([]);
  });

  it('서울시청은 총괄표제부 없음', () => {
    expect(page('recap-seoul-cityhall-none').items).toEqual([]);
  });
});

describe('부속지번 (getBrAtchJibunInfo)', () => {
  it('서울시청: 31 → 부속지번 31-1 (건물 → 필지 N)', () => {
    const [a] = page('atch-seoul-cityhall').items.map(normalizeAttachedJibun);
    expect(a?.parcel.pnu).toBe(CITYHALL);
    expect(a?.attachedParcel.pnu).toBe('1114010300100310001');
    expect(a?.pk).toBe('100311530');
  });

  it('남산: 세 동 모두 부속지번 산1-11 (건물관리번호의 부번 0011과 같다)', () => {
    const rows = page('atch-namsan-mountain').items.map(normalizeAttachedJibun);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.attachedParcel.pnu))).toEqual(new Set(['1117010200200010011']));
  });

  it('낭성면: 총괄표제부에 부속지번 2개', () => {
    const rows = page('atch-nangseong-office').items.map(normalizeAttachedJibun);
    expect(rows.map((r) => r.registerKindName)).toEqual(['총괄표제부', '총괄표제부']);
    expect(rows.map((r) => r.attachedParcel.pnu).sort()).toEqual(['4311131025100340006', '4311131025102620003']);
  });
});

describe('ledgerParcel', () => {
  it('블록(platGbCd 2)은 PNU로 바꾸지 않고 원값을 둔다', () => {
    expect(ledgerParcel('11140', '10300', '2', '0031', '0000')).toMatchObject({ pnu: null, platGbCd: '2' });
  });
  it('빈 값(공백)', () => {
    expect(ledgerParcel(' ', ' ', ' ', ' ', ' ').pnu).toBeNull();
  });
});

describe('오류 응답', () => {
  it.each([
    ['error-service-timeout', '05'],
    ['error-key-not-registered', '30'],
  ])('%s → code %s', (name, code) => {
    expect(() => page(name)).toThrow(expect.objectContaining({ name: 'LedgerError', code }));
  });
});

describe('lookupParcelLedger', () => {
  type FetchArgs = [string, RequestInit?];

  function routeFetch(routes: Record<string, () => Response>) {
    return vi.fn(async (url: string) => {
      const op = new URL(url).pathname.split('/').at(-1) ?? '';
      const h = routes[op];
      if (!h) throw new Error(`no route ${op}`);
      return h();
    });
  }

  const ok = (name: string) => () => new Response(responseText(name), { status: 200 });

  it('세 오퍼레이션을 대장 키로 호출하고 소스별 상태를 돌려준다', async () => {
    const f = routeFetch({
      getBrTitleInfo: ok('title-seoul-cityhall'),
      getBrRecapTitleInfo: ok('recap-seoul-cityhall-none'),
      getBrAtchJibunInfo: ok('atch-seoul-cityhall'),
    });
    const r = await lookupParcelLedger(CITYHALL, { key: 'A%2BB', fetch: f as unknown as typeof fetch });
    expect(r.titles.status).toBe('ok');
    expect(r.titles.data).toHaveLength(2);
    expect(r.recapTitles.status).toBe('empty');
    expect(r.attachedJibuns.status).toBe('ok');

    const [url] = f.mock.calls[0] as FetchArgs;
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`.startsWith(BLD_HUB_BASE_URL)).toBe(true);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      serviceKey: 'A+B', // 인코딩 키는 한 번 풀어서 보낸다 (이중 인코딩 방지)
      sigunguCd: '11140',
      bjdongCd: '10300',
      platGbCd: '0',
      bun: '0031',
      ji: '0000',
      _type: 'json',
    });
  });

  it('산 번지는 platGbCd 1로 보낸다', async () => {
    const f = routeFetch({
      getBrTitleInfo: ok('title-namsan-mountain'),
      getBrRecapTitleInfo: ok('recap-seoul-cityhall-none'),
      getBrAtchJibunInfo: ok('atch-namsan-mountain'),
    });
    await lookupParcelLedger(NAMSAN, { key: 'K', fetch: f as unknown as typeof fetch });
    for (const [url] of f.mock.calls as FetchArgs[]) expect(new URL(url).searchParams.get('platGbCd')).toBe('1');
  });

  it('503(사유코드 05)은 재시도하고, 한 소스가 실패해도 나머지는 돌려준다', async () => {
    let titleCalls = 0;
    const f = routeFetch({
      getBrTitleInfo: () => {
        titleCalls++;
        return titleCalls === 1
          ? new Response(responseText('error-service-timeout'), { status: 503 })
          : new Response(responseText('title-seoul-cityhall'), { status: 200 });
      },
      getBrRecapTitleInfo: () => new Response(responseText('error-key-not-registered'), { status: 403 }),
      getBrAtchJibunInfo: ok('atch-seoul-cityhall'),
    });
    const r = await lookupParcelLedger(CITYHALL, {
      key: 'K',
      fetch: f as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(titleCalls).toBe(2);
    expect(r.titles.status).toBe('ok');
    expect(r.recapTitles).toMatchObject({ status: 'error', error: { code: '30' } });
    expect(r.attachedJibuns.status).toBe('ok');
  });

  it('503/05가 계속되면 0.5초·1초 간격으로 두 번 더 해 보고 포기한다', async () => {
    const f = vi.fn(async () => new Response(responseText('error-service-timeout'), { status: 503 }));
    const waits: number[] = [];
    const r = await lookupParcelLedger(CITYHALL, {
      key: 'K',
      fetch: f as unknown as typeof fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(r.titles).toMatchObject({ status: 'error', error: { code: '05' } });
    expect(f).toHaveBeenCalledTimes(9); // 3 오퍼레이션 × 3번
    expect(waits.sort((a, b) => a - b)).toEqual([500, 500, 500, 1000, 1000, 1000]);
  });

  it('시간 초과는 재시도한다', async () => {
    let calls = 0;
    const f = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new DOMException('timeout', 'TimeoutError');
      return new Response(responseText('title-seoul-cityhall'));
    });
    const titles = await getTitles(CITYHALL, { key: 'K', fetch: f as unknown as typeof fetch, sleep: async () => {} });
    expect(titles).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it('여러 페이지를 모은다', async () => {
    const item = (pk: number) => ({
      mgmBldrgstPk: pk,
      sigunguCd: '11140',
      bjdongCd: '10300',
      platGbCd: '0',
      bun: '0031',
      ji: '0000',
    });
    const body = (items: unknown[], pageNo: number) =>
      JSON.stringify({
        response: {
          header: { resultCode: '00', resultMsg: 'NORMAL SERVICE' },
          body: { items: { item: items }, totalCount: 3, pageNo, numOfRows: 2 },
        },
      });
    const f = vi.fn(async (url: string) => {
      const p = Number(new URL(url).searchParams.get('pageNo'));
      return new Response(p === 1 ? body([item(1), item(2)], 1) : body([item(3)], 2));
    });
    const titles = await getTitles(CITYHALL, { key: 'K', numOfRows: 2, fetch: f as unknown as typeof fetch });
    expect(titles.map((t) => t.pk)).toEqual(['1', '2', '3']);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('키가 없으면 소스별 error(NO_KEY)', async () => {
    const r = await lookupParcelLedger(CITYHALL, { key: '' });
    expect(r.titles).toMatchObject({ status: 'error', error: { code: 'NO_KEY' } });
  });

  it('네트워크 오류 메시지에 키가 섞이지 않는다', async () => {
    const f = vi.fn(async () => {
      throw new Error('fetch failed: serviceKey=SECRET');
    });
    const r = await lookupParcelLedger(CITYHALL, { key: 'SECRET', fetch: f as unknown as typeof fetch });
    expect(r.titles.status).toBe('error');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
});
