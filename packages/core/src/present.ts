/**
 * analyze 결과를 밖(MCP 응답, 웹 API)으로 내보낼 모양으로 바꾼다.
 * - 원 응답(raw)은 빼고, PNU마다 지번주소를 붙이고, 한 줄 요약을 단다.
 * - 웹 지도용 도형은 따로(mapFeatures) 만든다. MCP 응답에는 도형을 싣지 않는다(크기).
 */
import type { Feature, FeatureCollection } from 'geojson';
import type { AddressCandidate } from './address.js';
import type { AnalysisResult, BuildingAnalysis, ParcelAnalysis } from './analyze.js';
import { decodePnu } from './bjdong.js';
import type { RelationView } from './relation.js';
import { type AreaGeometry, getParcelShape, type ParcelShape, type VworldOptions } from './spatial.js';

export function jibunOf(pnu: string): string | null {
  try {
    return decodePnu(pnu).jibunAddress;
  } catch {
    return null;
  }
}

export const RELATION_TEXT: Record<string, string> = {
  '1:1': '건물 하나가 필지 하나 위에 있다',
  '1:N': '건물 하나가 여러 필지에 걸쳐 있다',
  'N:1': '한 필지에 건물이 여러 동 있고 모두 그 안에 있다',
  'N:M': '한 필지의 건물 중 일부가 다른 필지에도 걸쳐 있다',
};

const pct = (r: number | undefined) => (r === undefined ? undefined : Math.round(r * 1000) / 10);

export function presentView(v: RelationView) {
  return {
    status: v.status,
    ...(v.error && { error: v.error }),
    relation: v.relation,
    relationText: v.relation ? (RELATION_TEXT[v.relation] ?? null) : null,
    buildings: v.buildings,
    parcels: v.parcels.map((pnu) => ({ pnu, jibunAddress: jibunOf(pnu) })),
    edges: v.edges.map((e) => ({
      buildingId: e.buildingId,
      pnu: e.pnu,
      via: e.via,
      ...(e.ratioOfBuilding !== undefined && { overlapPercentOfBuilding: pct(e.ratioOfBuilding) }),
      ...(e.overlapAreaM2 !== undefined && { overlapAreaM2: Math.round(e.overlapAreaM2 * 10) / 10 }),
    })),
    ...(v.edgeContacts.length && {
      edgeContacts: v.edgeContacts.map((c) => ({
        buildingId: c.buildingId,
        pnu: c.pnu,
        percentOfBuilding: pct(c.ratioOfBuilding),
      })),
    }),
  };
}

export function presentCandidate(c: AddressCandidate) {
  return {
    roadAddress: c.roadAddress,
    jibunAddress: c.jibunAddress,
    buildingName: c.buildingName,
    detailBuildingNames: c.detailBuildingNames,
    pnu: c.pnu,
    buildingMgmtNo: c.buildingMgmtNo,
    apartment: c.apartment,
    relatedJibun: c.relatedJibunRaw,
  };
}

export function summaryLine(a: ParcelAnalysis | BuildingAnalysis): string {
  const where =
    a.start === 'parcel'
      ? `필지 ${jibunOf(a.pnu) ?? a.pnu}에서 출발`
      : `건물 ${a.candidate.roadAddress}${a.candidate.buildingName ? `(${a.candidate.buildingName})` : ''}에서 출발`;
  const rel = (v: RelationView) => (v.status === 'ok' ? (v.relation ?? '-') : v.status);
  const agree = a.agree === null ? '한쪽 근거가 없어 비교 못 함' : a.agree ? '두 근거 일치' : '두 근거 불일치';
  const parts = [`${where}: 대장 기준 ${rel(a.ledger)}, 공간 기준 ${rel(a.spatial)} (${agree})`];
  if (a.discrepancies.length) parts.push(`불일치·주의 ${a.discrepancies.length}건`);
  if (a.incomplete) {
    parts.push(
      a.incomplete.retryable ? '일부 자료 누락 — 잠시 후 다시 물어보면 된다' : '일부 자료 누락 — 설정 확인 필요',
    );
  }
  return parts.join('. ');
}

export function presentAnalysis(a: ParcelAnalysis | BuildingAnalysis) {
  return {
    summary: summaryLine(a),
    start: a.start,
    ...(a.start === 'parcel'
      ? { pnu: a.pnu, jibunAddress: jibunOf(a.pnu) }
      : { building: presentCandidate(a.candidate) }),
    ledger: presentView(a.ledger),
    spatial: presentView(a.spatial),
    agree: a.agree,
    discrepancies: a.discrepancies,
    notes: a.notes,
    incomplete: a.incomplete,
    relationNotation: '건물 수 : 필지 수',
  };
}

/** analyze 결과 전체 → 응답 본문 (도형 없음) */
export function presentResult(r: AnalysisResult) {
  switch (r.status) {
    case 'ok':
      return { status: 'ok' as const, input: r.input, inputKind: r.inputKind, ...presentAnalysis(r.analysis) };
    case 'ambiguous':
      return {
        status: 'ambiguous' as const,
        input: r.input,
        inputKind: r.inputKind,
        message: r.message,
        candidates: r.candidates.map(presentCandidate),
        parcels: r.parcels,
      };
    case 'not_found':
    case 'error':
      return r;
  }
}

export type PresentedResult = ReturnType<typeof presentResult>;

// ── 지도 ───────────────────────────────────────────────

/**
 * 지도에 그릴 도형의 역할.
 * - start-parcel: 출발 필지 / parcel: 공간상 건물이 걸친 다른 필지 / ledger-only-parcel: 대장에만 있는 필지(공간상 건물이 안 걸침)
 * - building: 도로명주소 건물 외곽선
 */
export type MapRole = 'start-parcel' | 'parcel' | 'ledger-only-parcel' | 'building';

export interface MapProps {
  role: MapRole;
  /** 필지면 PNU, 건물이면 건물관리번호 */
  id: string;
  label: string;
}

export type MapFeatures = FeatureCollection<AreaGeometry, MapProps>;

function feature(geometry: AreaGeometry, props: MapProps): Feature<AreaGeometry, MapProps> {
  return { type: 'Feature', geometry, properties: props };
}

/** 이미 받은 도형으로 지도용 GeoJSON을 만든다. 도형이 없는 대장 전용 필지는 missingParcels로 알려 준다. */
export function mapFeaturesOf(a: ParcelAnalysis | BuildingAnalysis): {
  features: MapFeatures;
  missingParcels: string[];
} {
  const parcels = new Map<string, ParcelShape>();
  const out: Feature<AreaGeometry, MapProps>[] = [];
  const startPnu = a.start === 'parcel' ? a.pnu : a.candidate.pnu;

  if (a.start === 'parcel') {
    const s = a.raw.spatial;
    if (s.parcel) parcels.set(s.parcel.pnu, s.parcel);
    for (const r of Object.values(a.raw.parcelsOfBuilding)) for (const p of r.data) parcels.set(p.parcel.pnu, p.parcel);
    for (const b of s.buildings.data) {
      if (b.edgeContact) continue;
      out.push(feature(b.building.geometry, buildingProps(b.building)));
    }
  } else {
    const s = a.raw.spatial;
    for (const p of s.parcels.data) parcels.set(p.parcel.pnu, p.parcel);
    if (s.building) out.push(feature(s.building.geometry, buildingProps(s.building)));
  }

  const spatialPnus = new Set(a.spatial.parcels);
  const ledgerOnly = a.ledger.parcels.filter((p) => !spatialPnus.has(p));
  const shown = new Set<string>([...spatialPnus, ...ledgerOnly, startPnu]);
  const parcelFeatures: Feature<AreaGeometry, MapProps>[] = [];
  for (const pnu of shown) {
    const p = parcels.get(pnu);
    if (!p) continue;
    parcelFeatures.push(feature(p.geometry, parcelProps(pnu, startPnu, ledgerOnly)));
  }
  const missingParcels = [...shown].filter((p) => !parcels.has(p));
  // 필지를 먼저(아래), 건물을 나중(위)에 그린다
  return { features: { type: 'FeatureCollection', features: [...parcelFeatures, ...out] }, missingParcels };
}

function parcelProps(pnu: string, startPnu: string, ledgerOnly: string[]): MapProps {
  const role: MapRole = pnu === startPnu ? 'start-parcel' : ledgerOnly.includes(pnu) ? 'ledger-only-parcel' : 'parcel';
  return { role, id: pnu, label: jibunOf(pnu) ?? pnu };
}

function buildingProps(b: { buildingMgmtNo: string; name: string | null; dongName: string | null }): MapProps {
  return {
    role: 'building',
    id: b.buildingMgmtNo,
    label: [b.name, b.dongName].filter(Boolean).join(' ') || b.buildingMgmtNo,
  };
}

/** 지도용 GeoJSON. 대장에만 있는 필지처럼 아직 도형이 없는 필지는 VWorld에서 경계를 더 받아 온다(최대 maxExtra개). */
export async function mapFeaturesWithMissing(
  a: ParcelAnalysis | BuildingAnalysis,
  opts: VworldOptions,
  maxExtra = 5,
): Promise<MapFeatures> {
  const { features, missingParcels } = mapFeaturesOf(a);
  const startPnu = a.start === 'parcel' ? a.pnu : a.candidate.pnu;
  const ledgerOnly = a.ledger.parcels.filter((p) => !a.spatial.parcels.includes(p));
  const extra = await Promise.all(
    missingParcels.slice(0, maxExtra).map((pnu) => getParcelShape(pnu, opts).catch(() => null)),
  );
  const add = extra
    .filter((p): p is ParcelShape => p !== null)
    .map((p) => feature(p.geometry, parcelProps(p.pnu, startPnu, ledgerOnly)));
  const parcelsFirst = [...add, ...features.features];
  parcelsFirst.sort((x, y) => Number(x.properties.role === 'building') - Number(y.properties.role === 'building'));
  return { type: 'FeatureCollection', features: parcelsFirst };
}
