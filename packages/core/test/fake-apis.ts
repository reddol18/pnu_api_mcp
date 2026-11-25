/**
 * 실제 응답 fixture로 juso·건축HUB·VWorld를 흉내 내는 fetch.
 * 요청 URL을 보고 맞는 fixture를 돌려준다. 공간 필터(geomFilter)는 fixture 도형의 WKT와 맞춰 찾는다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { parseLedgerJson, toWkt } from '../src/index.js';

const FIX = new URL('../fixtures/', import.meta.url);

function read(path: string): { request: Record<string, string>; response: unknown } {
  return parseLedgerJson(readFileSync(new URL(path, FIX), 'utf8')) as {
    request: Record<string, string>;
    response: unknown;
  };
}

function exists(dir: string, name: string): boolean {
  return readdirSync(new URL(`${dir}/`, FIX)).includes(`${name}.json`);
}

// ── juso ─────────────────────────────────────────────
const JUSO: Record<string, string> = {
  '세종대로 110': 'road-seoul-cityhall',
  서울시청: 'road-seoul-cityhall',
  '남산공원길 105': 'road-namsan-mountain',
  '서울특별시 용산구 남산공원길 105': 'road-namsan-mountain',
  '용산동2가 산1-3': 'jibun-mountain-two-buildings',
  '낭성면 행정복지센터': 'ri-nangseong-office',
  '상봉동 126-39': 'jibun-sangbong-126-39-none',
};

// ── PNU → 사례 이름 ──────────────────────────────────
export const PNU = {
  cityhall: '1114010300100310000',
  namsan: '1117010200200010003',
  nangseong: '4311131025101200003',
  jungwon: '1126010200101260052',
  sangbong12639: '1126010200101260039',
} as const;

const LEDGER_CASE: Record<string, string> = {
  [PNU.cityhall]: 'seoul-cityhall',
  [PNU.namsan]: 'namsan-mountain',
  [PNU.nangseong]: 'nangseong-office',
  [PNU.jungwon]: 'jungwon-palace',
  [PNU.sangbong12639]: 'sangbong-126-39',
};

const SPATIAL_CASE: Record<string, string> = {
  [PNU.cityhall]: 'seoul-cityhall',
  [PNU.namsan]: 'namsan',
  [PNU.nangseong]: 'nangseong-office',
  [PNU.jungwon]: 'jungwon-palace',
  [PNU.sangbong12639]: 'sangbong-126-39',
};

const OP_PREFIX: Record<string, string> = {
  getBrTitleInfo: 'title',
  getBrRecapTitleInfo: 'recap',
  getBrAtchJibunInfo: 'atch',
};

const EMPTY_LEDGER = {
  response: {
    header: { resultCode: '00', resultMsg: 'NORMAL SERVICE' },
    body: { items: { item: [] }, totalCount: 0, pageNo: 1, numOfRows: 100 },
  },
};

const NOT_FOUND = {
  response: { status: 'NOT_FOUND', record: { total: '0', current: '0' }, page: { total: '1', current: '1' } },
};

interface Feat {
  geometry: Parameters<typeof toWkt>[0];
  properties: Record<string, string>;
}

function featuresOf(resp: unknown): Feat[] {
  const r = (resp as { response?: { result?: { featureCollection?: { features?: Feat[] } } } }).response;
  return r?.result?.featureCollection?.features ?? [];
}

function withFeatures(features: Feat[]) {
  if (!features.length) return NOT_FOUND;
  return {
    response: {
      status: 'OK',
      record: { total: String(features.length), current: String(features.length) },
      page: { total: '1', current: '1', size: '1000' },
      result: { featureCollection: { type: 'FeatureCollection', features } },
    },
  };
}

/** geomFilter WKT → 응답 fixture */
function buildGeomIndex() {
  const files = readdirSync(new URL('spatial/', FIX)).map((f) => f.replace(/\.json$/, ''));
  const spbdByParcelWkt = new Map<string, string>();
  const parcelsByBuildingWkt = new Map<string, string>();
  const buildingsById = new Map<string, Feat>();
  for (const f of files) {
    const [caseName, kind] = [f.split('.')[0] ?? '', f.slice(f.indexOf('.') + 1)];
    if (kind === 'parcel') {
      const p = featuresOf(read(`spatial/${f}.json`).response)[0];
      const target = `${caseName}.spbd-in-parcel`;
      if (p && files.includes(target)) spbdByParcelWkt.set(toWkt(p.geometry), target);
    }
    if (kind.startsWith('spbd-')) {
      for (const b of featuresOf(read(`spatial/${f}.json`).response)) {
        const id = b.properties.bd_mgt_sn ?? '';
        buildingsById.set(id, b);
        const target = kind === 'spbd-ytn' ? `${caseName}.parcels-of-ytn` : `${caseName}.parcels-of-${id}`;
        if (files.includes(target)) parcelsByBuildingWkt.set(toWkt(b.geometry), target);
      }
    }
  }
  return { spbdByParcelWkt, parcelsByBuildingWkt, buildingsById };
}

export interface FakeApis {
  fetch: typeof fetch;
  calls: URL[];
}

export function fakeApis(): FakeApis {
  const idx = buildGeomIndex();
  const calls: URL[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  const impl = async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(u);

    if (u.host === 'business.juso.go.kr') {
      const keyword = new URLSearchParams(String(init?.body ?? '')).get('keyword') ?? '';
      const name = JUSO[keyword];
      if (!name) throw new Error(`juso fixture 없음: ${keyword}`);
      return json(read(`juso/${name}.json`).response);
    }

    if (u.host === 'apis.data.go.kr') {
      const op = u.pathname.split('/').at(-1) ?? '';
      const q = u.searchParams;
      const pnu = `${q.get('sigunguCd')}${q.get('bjdongCd')}${q.get('platGbCd') === '1' ? '2' : '1'}${q.get('bun')}${q.get('ji')}`;
      const c = LEDGER_CASE[pnu];
      const base = `${OP_PREFIX[op]}-${c}`;
      for (const name of [base, `${base}-none`]) {
        if (c && exists('ledger', name)) return json(read(`ledger/${name}.json`).response);
      }
      return json(EMPTY_LEDGER);
    }

    if (u.host === 'api.vworld.kr') {
      const q = u.searchParams;
      const attr = q.get('attrFilter') ?? '';
      const geom = q.get('geomFilter') ?? '';
      if (attr.startsWith('pnu:=:')) {
        const c = SPATIAL_CASE[attr.slice(6)];
        return json(c ? read(`spatial/${c}.parcel.json`).response : NOT_FOUND);
      }
      if (attr.startsWith('bd_mgt_sn:=:')) {
        const b = idx.buildingsById.get(attr.slice(12));
        return json(withFeatures(b ? [b] : []));
      }
      const map = q.get('data') === 'LT_C_SPBD' ? idx.spbdByParcelWkt : idx.parcelsByBuildingWkt;
      const name = map.get(geom);
      return json(name ? read(`spatial/${name}.json`).response : NOT_FOUND);
    }

    throw new Error(`알 수 없는 호스트: ${u.host}`);
  };
  return { fetch: vi.fn(impl) as unknown as typeof fetch, calls };
}

export const KEYS = {
  jusoKey: 'J',
  dataGoKrKey: 'D',
  vworldKey: 'V',
  vworldDomain: 'https://pnu.reddol18.pe.kr',
};
