import { describe, expect, it } from 'vitest';
import {
  type AnalysisResult,
  analyze,
  type BuildingAnalysis,
  mapFeaturesOf,
  mapFeaturesWithMissing,
  type ParcelAnalysis,
  presentResult,
} from '../src/index.js';
import { fakeApis, KEYS, PNU } from './fake-apis.js';

async function ok(input: string): Promise<{ a: ParcelAnalysis | BuildingAnalysis; fetch: typeof fetch }> {
  const apis = fakeApis();
  const r: AnalysisResult = await analyze(input, { ...KEYS, fetch: apis.fetch, sleep: async () => {} });
  if (r.status !== 'ok') throw new Error(r.status);
  return { a: r.analysis, fetch: apis.fetch };
}

const roles = (fc: { features: { properties: { role: string; id: string } }[] }) =>
  fc.features.map((f) => [f.properties.role, f.properties.id]);

describe('presentResult', () => {
  it('원 응답·도형을 싣지 않는다', async () => {
    const apis = fakeApis();
    const r = await analyze(PNU.cityhall, { ...KEYS, fetch: apis.fetch, sleep: async () => {} });
    const text = JSON.stringify(presentResult(r));
    expect(text).not.toContain('coordinates');
    expect(text).not.toContain('"raw"');
    expect(text).toContain('서울특별시 중구 태평로1가 31-1'); // PNU마다 지번주소
  });
});

describe('지도용 GeoJSON', () => {
  it('필지 출발(서울시청): 출발 필지 + 건물 2동, 대장에만 있는 31-1은 도형이 없어 missing', async () => {
    const { a } = await ok(PNU.cityhall);
    const { features, missingParcels } = mapFeaturesOf(a);
    expect(roles(features)).toEqual([
      ['start-parcel', PNU.cityhall],
      ['building', '1114010300100310000019224'],
      ['building', '1114010300100310000019225'],
    ]);
    expect(missingParcels).toEqual(['1114010300100310001']);
  });

  it('건물 출발(YTN서울타워): 대장에만 있는 대표지번 산1-3 경계를 VWorld에서 더 받아 온다', async () => {
    const { a, fetch } = await ok('남산공원길 105');
    expect(mapFeaturesOf(a).missingParcels).toEqual([PNU.namsan]);
    const fc = await mapFeaturesWithMissing(a, { key: 'V', domain: 'd', fetch });
    expect(roles(fc)).toEqual([
      ['start-parcel', PNU.namsan], // 대표지번(주소의 지번)
      ['parcel', '1117010200200010011'], // 실제로 건물이 서 있는 필지
      ['building', '1117010200200010011026010'],
    ]);
    expect(fc.features.at(-1)?.properties.label).toBe('YTN서울타워');
  });
});
