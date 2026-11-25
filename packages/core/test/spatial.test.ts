import { readFileSync } from 'node:fs';
import type { Polygon } from 'geojson';
import { describe, expect, it, vi } from 'vitest';
import {
  areaM2,
  type BuildingShape,
  getParcelShape,
  linkBuildingsToParcel,
  linkParcelsToBuilding,
  normalizeBuildingShape,
  normalizeParcelShape,
  overlap,
  type ParcelShape,
  parseVworldPage,
  spatialBuildingParcels,
  spatialParcelBuildings,
  toBox,
  toWkt,
  VWORLD_DATA_URL,
} from '../src/index.js';

function responseOf(name: string): unknown {
  const f = JSON.parse(readFileSync(new URL(`../fixtures/spatial/${name}.json`, import.meta.url), 'utf8')) as {
    response: unknown;
  };
  return f.response;
}

const features = (name: string) => parseVworldPage(responseOf(name)).features;

function parcels(name: string): ParcelShape[] {
  return features(name)
    .map(normalizeParcelShape)
    .filter((x): x is ParcelShape => x !== null);
}

function buildings(name: string): BuildingShape[] {
  return features(name)
    .map(normalizeBuildingShape)
    .filter((x): x is BuildingShape => x !== null);
}

function building(name: string, no: string): BuildingShape {
  const b = buildings(name).find((x) => x.buildingMgmtNo === no);
  if (!b) throw new Error(`건물 없음 ${no}`);
  return b;
}

const pct = (x: number | undefined) => Math.round((x ?? Number.NaN) * 1000) / 10;

function first<T>(xs: readonly T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error('빈 목록');
  return x;
}

describe('parseVworldPage', () => {
  it('필지 경계: 서울시청 31', () => {
    const [p] = parcels('seoul-cityhall.parcel');
    expect(p).toMatchObject({ pnu: '1114010300100310000', address: '서울특별시 중구 태평로1가 31', jibunRaw: '31대' });
    expect(p?.geometry.type).toBe('MultiPolygon');
  });

  it('NOT_FOUND는 빈 목록: 블로그 예시 상봉동 126-39는 연속지적도에 없다', () => {
    expect(features('sangbong-126-39.parcel')).toEqual([]);
  });

  it('ERROR는 VworldError(code)', () => {
    const body = {
      response: {
        status: 'ERROR',
        error: { level: '2', code: 'INCORRECT_KEY', text: '인증키 정보가 올바르지 않습니다.' },
      },
    };
    expect(() => parseVworldPage(body)).toThrow(
      expect.objectContaining({ name: 'VworldError', code: 'INCORRECT_KEY' }),
    );
  });

  it('도로명주소 건물: 서울시청 본관동·신관이 건물관리번호와 함께', () => {
    const bs = buildings('seoul-cityhall.spbd-in-parcel');
    expect(bs.map((b) => [b.buildingMgmtNo, b.dongName]).sort()).toEqual([
      ['1114010300100310000019224', '본관동'],
      ['1114010300100310000019225', '신관'],
    ]);
  });
});

describe('도형 도구', () => {
  const square: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [127, 37],
        [127.001, 37],
        [127.001, 37.001],
        [127, 37.001],
        [127, 37],
      ],
    ],
  };
  const shifted: Polygon = {
    type: 'Polygon',
    coordinates: [first(square.coordinates).map(([x, y]) => [(x ?? 0) + 0.0005, y ?? 0])],
  };

  it('WKT·BOX', () => {
    expect(toWkt(square)).toBe('POLYGON((127 37,127.001 37,127.001 37.001,127 37.001,127 37))');
    expect(toBox(shifted)).toBe('BOX(127.0005,37,127.0015,37.001)');
  });

  it('반쯤 겹친 사각형은 50%', () => {
    const o = overlap(square, shifted);
    expect(o.ratioOfA).toBeCloseTo(0.5, 3);
    expect(o.areaM2).toBeCloseTo(areaM2(square) / 2, 0);
  });
});

describe('공간 관계 (실제 도형)', () => {
  it('서울시청: 두 동 모두 31번지 안에만 있다 → 대장 부속지번 31-1(도로)과 불일치', () => {
    const parcel = first(parcels('seoul-cityhall.parcel'));
    const links = linkBuildingsToParcel(parcel, buildings('seoul-cityhall.spbd-in-parcel'));
    expect(links).toHaveLength(2);
    for (const l of links) expect(pct(l.ratioOfBuilding)).toBe(100);
    for (const no of ['1114010300100310000019224', '1114010300100310000019225']) {
      const ps = linkParcelsToBuilding(
        building('seoul-cityhall.spbd-in-parcel', no),
        parcels(`seoul-cityhall.parcels-of-${no}`),
      );
      expect(ps.map((p) => p.parcel.pnu)).toEqual(['1114010300100310000']);
    }
  });

  it('YTN서울타워: 주소·대장은 산1-3인데 외곽선은 통째로 산1-11 위에 있다', () => {
    const ytn = first(buildings('namsan.spbd-ytn'));
    expect(ytn.buildingMgmtNo).toBe('1117010200200010011026010');
    const ps = linkParcelsToBuilding(ytn, parcels('namsan.parcels-of-ytn'));
    expect(ps.map((p) => p.parcel.pnu)).toEqual(['1117010200200010011']);
    expect(pct(ps[0]?.ratioOfBuilding)).toBe(100);
    // 산1-3 필지 안에서 찾은 건물 목록에도 YTN서울타워는 없다
    expect(buildings('namsan.spbd-in-parcel').map((b) => b.buildingMgmtNo)).not.toContain(ytn.buildingMgmtNo);
  });

  it('남산공원길 126: 산1-3과 산1-1에 걸친다 (건물 → 필지 2)', () => {
    const no = '1117010200200010003026009';
    const ps = linkParcelsToBuilding(building('namsan.spbd-in-parcel', no), parcels(`namsan.parcels-of-${no}`));
    expect(ps.map((p) => [p.parcel.pnu, pct(p.ratioOfBuilding), p.edgeContact])).toEqual([
      ['1117010200200010003', 82.8, false],
      ['1117010200200010001', 17.2, false],
    ]);
  });

  it('낭성면 행정복지센터: 공간상 걸친 필지 = 대장 부속지번 (120-3 + 34-6 + 262-3)', () => {
    const no = '4371031026001200003056414';
    const ps = linkParcelsToBuilding(
      building('nangseong-office.spbd-in-parcel', no),
      parcels(`nangseong-office.parcels-of-${no}`),
    );
    expect(ps.map((p) => [p.parcel.pnu, pct(p.ratioOfBuilding)])).toEqual([
      ['4311131025101200003', 78.7],
      ['4311131025100340006', 17],
      ['4311131025102620003', 4.3],
    ]);
  });

  it('정원팰리스 126-52: 3동은 필지 안, 옆 건물(126-50)은 3.5%만 걸침 → 경계 접촉 기준값 근처', () => {
    const parcel = first(parcels('jungwon-palace.parcel'));
    const links = linkBuildingsToParcel(parcel, buildings('jungwon-palace.spbd-in-parcel'));
    expect(links.map((l) => [l.building.dongName, pct(l.ratioOfBuilding)])).toEqual([
      ['101동', 100],
      ['102동', 100],
      ['103동', 100],
      [null, 3.5],
    ]);
    expect(links.at(-1)?.edgeContact).toBe(false); // 기준값 1%보다 크다
    expect(linkBuildingsToParcel(parcel, buildings('jungwon-palace.spbd-in-parcel'), 0.05).at(-1)?.edgeContact).toBe(
      true,
    );
  });

  it('겹침이 0인 것(BOX로 받은 것)은 뺀다', () => {
    const parcel = first(parcels('seoul-cityhall.parcel'));
    const far = first(buildings('namsan.spbd-ytn'));
    expect(linkBuildingsToParcel(parcel, [far])).toEqual([]);
  });
});

describe('호출', () => {
  type Route = (u: URL) => unknown;
  function fakeFetch(route: Route) {
    return vi.fn(async (url: string) => new Response(JSON.stringify(route(new URL(url)))));
  }
  const opts = (f: ReturnType<typeof fakeFetch>) => ({
    key: 'K',
    domain: 'https://pnu.reddol18.pe.kr',
    fetch: f as unknown as typeof fetch,
    sleep: async () => {},
  });

  it('필지 경계 요청 파라미터 (domain 필수)', async () => {
    const f = fakeFetch(() => responseOf('seoul-cityhall.parcel'));
    const p = await getParcelShape('1114010300100310000', opts(f));
    expect(p?.pnu).toBe('1114010300100310000');
    const [url] = f.mock.calls[0] as [string];
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(VWORLD_DATA_URL);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      service: 'data',
      request: 'GetFeature',
      data: 'LP_PA_CBND_BUBUN',
      attrFilter: 'pnu:=:1114010300100310000',
      key: 'K',
      domain: 'https://pnu.reddol18.pe.kr',
      format: 'json',
    });
  });

  it('domain이 없으면 호출하지 않는다', async () => {
    const f = fakeFetch(() => ({}));
    const r = await spatialParcelBuildings('1114010300100310000', { ...opts(f), domain: '' });
    expect(r.buildings).toMatchObject({ status: 'error', error: { code: 'NO_DOMAIN' } });
    expect(f).not.toHaveBeenCalled();
  });

  it('필지 → 건물: 필지 외곽선 그대로 geomFilter', async () => {
    const f = fakeFetch((u) =>
      u.searchParams.get('data') === 'LP_PA_CBND_BUBUN'
        ? responseOf('seoul-cityhall.parcel')
        : responseOf('seoul-cityhall.spbd-in-parcel'),
    );
    const r = await spatialParcelBuildings('1114010300100310000', opts(f));
    expect(r.buildings.status).toBe('ok');
    expect(r.buildings.data).toHaveLength(2);
    const [second] = f.mock.calls[1] as [string];
    expect(new URL(second).searchParams.get('geomFilter')).toMatch(/^MULTIPOLYGON\(/);
  });

  it('외곽선이 너무 길면 BOX로 받고 겹침으로 거른다', async () => {
    const f = fakeFetch((u) =>
      u.searchParams.get('data') === 'LP_PA_CBND_BUBUN'
        ? responseOf('seoul-cityhall.parcel')
        : responseOf('seoul-cityhall.spbd-in-parcel'),
    );
    await spatialParcelBuildings('1114010300100310000', { ...opts(f), maxWktLength: 10 });
    const [second] = f.mock.calls[1] as [string];
    expect(new URL(second).searchParams.get('geomFilter')).toMatch(/^BOX\(/);
  });

  it('연속지적도에 없는 필지는 empty, parcel null', async () => {
    const f = fakeFetch(() => responseOf('sangbong-126-39.parcel'));
    const r = await spatialParcelBuildings('1126010200101260039', opts(f));
    expect(r).toMatchObject({ parcel: null, buildings: { status: 'empty' } });
  });

  it('건물 → 필지', async () => {
    const f = fakeFetch((u) =>
      u.searchParams.get('data') === 'LT_C_SPBD' ? responseOf('namsan.spbd-ytn') : responseOf('namsan.parcels-of-ytn'),
    );
    const r = await spatialBuildingParcels('1117010200200010011026010', opts(f));
    expect(r.building?.name).toBe('YTN서울타워');
    expect(r.parcels.data.map((p) => p.parcel.pnu)).toEqual(['1117010200200010011']);
  });

  it('키 오류는 소스 error로, 메시지에 키가 없다', async () => {
    const f = fakeFetch(() => ({
      response: {
        status: 'ERROR',
        error: { level: '2', code: 'INCORRECT_KEY', text: '인증키 정보가 올바르지 않습니다.' },
      },
    }));
    const r = await spatialBuildingParcels('1117010200200010011026010', { ...opts(f), key: 'SECRET' });
    expect(r.parcels).toMatchObject({ status: 'error', error: { code: 'INCORRECT_KEY' } });
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });

  it('시간 초과는 재시도한다', async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n === 1) throw new DOMException('timeout', 'TimeoutError');
      return new Response(JSON.stringify(responseOf('seoul-cityhall.parcel')));
    });
    const p = await getParcelShape('1114010300100310000', {
      key: 'K',
      domain: 'd',
      fetch: f as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(p?.pnu).toBe('1114010300100310000');
    expect(n).toBe(2);
  });
});
