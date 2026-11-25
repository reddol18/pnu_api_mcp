import { describe, expect, it } from 'vitest';
import { type AnalysisResult, analyze, type BuildingAnalysis, classify, type ParcelAnalysis } from '../src/index.js';
import { fakeApis, KEYS, PNU } from './fake-apis.js';

const NAMSAN_1_11 = '1117010200200010011';
const NAMSAN_1_1 = '1117010200200010001';
const CITYHALL_31_1 = '1114010300100310001';

async function run(input: string, extra = {}) {
  const apis = fakeApis();
  const r = await analyze(input, { ...KEYS, fetch: apis.fetch, sleep: async () => {}, ...extra });
  return { r, apis };
}

function parcelOf(r: AnalysisResult): ParcelAnalysis {
  if (r.status !== 'ok' || r.analysis.start !== 'parcel') throw new Error(`parcel 분석이 아님: ${r.status}`);
  return r.analysis;
}

function buildingOf(r: AnalysisResult): BuildingAnalysis {
  if (r.status !== 'ok' || r.analysis.start !== 'building') throw new Error(`building 분석이 아님: ${r.status}`);
  return r.analysis;
}

const codes = (a: { discrepancies: { code: string; pnu?: string }[] }) => a.discrepancies.map((d) => [d.code, d.pnu]);

describe('classify (건물 수 : 필지 수)', () => {
  it.each([
    [1, 1, false, '1:1'],
    [1, 3, true, '1:N'],
    [3, 1, false, 'N:1'],
    [3, 2, true, 'N:M'],
    [0, 1, false, null],
  ] as const)('건물 %i, 필지 %i → %s', (b, p, spans, expected) => {
    expect(classify(b, p, spans)).toBe(expected);
  });
});

describe('필지에서 출발', () => {
  it('서울시청 31: 대장은 부속지번 31-1까지 N:M, 공간은 두 동 모두 31 안 N:1 → 불일치 31-1', async () => {
    const a = parcelOf((await run(PNU.cityhall)).r);
    expect(a.ledger).toMatchObject({ status: 'ok', relation: 'N:M' });
    expect(a.ledger.parcels.sort()).toEqual([PNU.cityhall, CITYHALL_31_1]);
    expect(a.spatial).toMatchObject({ status: 'ok', relation: 'N:1', parcels: [PNU.cityhall] });
    expect(a.spatial.buildings.map((b) => b.dongName).sort()).toEqual(['본관동', '신관']);
    expect(a.agree).toBe(false);
    expect(codes(a)).toEqual([['ledger_parcel_not_spatial', CITYHALL_31_1]]);
  });

  it('용산동2가 산1-3 (지번 입력): 대장은 서울타워 → 산1-11, 공간은 남산공원길 126 → 산1-1. 종류는 같아도 필지가 달라 불일치', async () => {
    const { r } = await run('용산동2가 산1-3');
    expect(r.inputKind).toBe('jibun');
    const a = parcelOf(r);
    expect(a.pnu).toBe(PNU.namsan);
    expect(a.ledger.relation).toBe('1:N');
    expect(a.ledger.buildings.map((b) => b.name)).toEqual(['서울타워']); // 부속건축물 2동은 빠진다
    expect(a.spatial.relation).toBe('1:N');
    expect(a.agree).toBe(false);
    expect(codes(a)).toEqual([
      ['ledger_parcel_not_spatial', NAMSAN_1_11],
      ['spatial_parcel_not_ledger', NAMSAN_1_1],
    ]);
  });

  it('정원팰리스 126-52: 대장 3동 N:1, 공간은 옆 건물이 3.5% 걸쳐 4동 N:M', async () => {
    const a = parcelOf((await run(PNU.jungwon)).r);
    expect(a.ledger).toMatchObject({ relation: 'N:1', parcels: [PNU.jungwon] });
    expect(a.ledger.buildings.map((b) => b.dongName).sort()).toEqual(['101동', '102동', '103동']);
    expect(a.spatial.relation).toBe('N:M');
    expect(a.spatial.buildings).toHaveLength(4);
    expect(codes(a)).toEqual([
      ['spatial_parcel_not_ledger', '1126010200101260050'],
      ['building_count_differs', PNU.jungwon],
    ]);
  });

  it('옆 건물의 겹침 비율(3.5%)이 결과에 그대로 나온다 (경계 접촉 기준값 판단용)', async () => {
    const a = parcelOf((await run(PNU.jungwon)).r);
    const neighbor = a.spatial.edges.find((e) => e.pnu === PNU.jungwon && (e.ratioOfBuilding ?? 1) < 0.05);
    expect(neighbor?.ratioOfBuilding).toBeCloseTo(0.0354, 3);
  });

  it('블로그 예시 상봉동 126-39 (PNU): 연속지적도에도 없고 대장도 없다', async () => {
    const a = parcelOf((await run(PNU.sangbong12639)).r);
    expect(a.ledger.status).toBe('empty');
    expect(a.spatial.status).toBe('empty');
    expect(a.agree).toBeNull();
    expect(codes(a)).toEqual([['parcel_not_in_cadastral', PNU.sangbong12639]]);
  });

  it('필지 출발에는 역방향 조회 불가 안내가 붙는다', async () => {
    const a = parcelOf((await run(PNU.cityhall)).r);
    expect(a.notes.some((n) => n.includes('역방향'))).toBe(true);
  });
});

describe('건물에서 출발', () => {
  it('세종대로 110 (도로명): 대장 1:N(31, 31-1), 공간 1:1(31)', async () => {
    const { r } = await run('세종대로 110');
    expect(r.inputKind).toBe('road');
    const a = buildingOf(r);
    expect(a.candidate.buildingName).toBe('서울특별시청'); // 세종대로14길 20-2는 걸러진다
    expect(a.ledger.relation).toBe('1:N');
    expect(a.ledger.buildings).toHaveLength(2); // 도로명주소 하나에 대장 2동
    expect(a.spatial.relation).toBe('1:1');
    expect(codes(a)).toEqual([['ledger_parcel_not_spatial', CITYHALL_31_1]]);
    expect(a.notes.some((n) => n.includes('표제부가 2동'))).toBe(true);
  });

  it('남산공원길 105 (YTN서울타워): 대표지번 산1-3 위에 건물이 없다', async () => {
    const a = buildingOf((await run('남산공원길 105')).r);
    expect(a.candidate.pnu).toBe(PNU.namsan);
    expect(a.ledger).toMatchObject({ relation: '1:N' });
    expect(a.ledger.parcels.sort()).toEqual([PNU.namsan, NAMSAN_1_11]);
    expect(a.spatial).toMatchObject({ relation: '1:1', parcels: [NAMSAN_1_11] });
    expect(codes(a)).toEqual([
      ['representative_not_under_building', PNU.namsan],
      ['ledger_parcel_not_spatial', PNU.namsan],
    ]);
  });

  it('건물관리번호 입력도 같은 결과 (공간 → 주소 검색으로 후보를 다시 찾는다)', async () => {
    const { r } = await run('1117010200200010011026010');
    expect(r.inputKind).toBe('buildingMgmtNo');
    expect(buildingOf(r).candidate.roadAddress).toBe('서울특별시 용산구 남산공원길 105');
  });

  it('낭성면 행정복지센터 (건물명): 총괄표제부 부속지번 = 공간 걸침 → 일치', async () => {
    const { r } = await run('낭성면 행정복지센터');
    expect(r.inputKind).toBe('unknown');
    const a = buildingOf(r);
    expect(a.ledger.buildings.map((b) => b.kind)).toEqual(['recap']);
    expect(a.ledger.relation).toBe('1:N');
    expect(a.spatial.relation).toBe('1:N');
    expect(a.ledger.parcels.sort()).toEqual(a.spatial.parcels.sort());
    expect(a.agree).toBe(true);
    expect(codes(a)).toEqual([['recap_without_titles', PNU.nangseong]]);
  });
});

describe('입력 처리', () => {
  it('후보가 여럿이면 판정하지 않고 후보를 돌려준다', async () => {
    const { r } = await run('서울시청');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') expect(r.candidates).toHaveLength(2);
  });

  it('지번 주소로 건물을 못 찾으면 PNU로 물어보라고 안내한다', async () => {
    const { r } = await run('상봉동 126-39');
    expect(r).toMatchObject({ status: 'not_found', inputKind: 'jibun' });
    if (r.status === 'not_found') expect(r.message).toContain('PNU');
  });

  it('키가 없으면 소스별 error로 나오고 전체는 실패하지 않는다', async () => {
    const { r } = await run(PNU.cityhall, { dataGoKrKey: '' });
    const a = parcelOf(r);
    expect(a.ledger).toMatchObject({ status: 'error', error: { code: 'NO_KEY' } });
    expect(a.spatial.status).toBe('ok');
    expect(a.agree).toBeNull();
  });

  it('juso 키가 없으면 주소 입력은 error', async () => {
    const { r } = await run('세종대로 110', { jusoKey: '' });
    expect(r).toMatchObject({ status: 'error', error: { code: 'NO_KEY' } });
  });
});
