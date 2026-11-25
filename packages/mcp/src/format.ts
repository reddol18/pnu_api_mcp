/**
 * core 결과를 MCP 응답용으로 줄인다: 도형(좌표)·원 응답은 빼고, PNU마다 지번주소를 붙이고, 한 줄 요약을 단다.
 */
import {
  type AddressCandidate,
  type AnalysisResult,
  type BuildingAnalysis,
  decodePnu,
  type ParcelAnalysis,
  type RelationView,
} from '@pnu/core';

function jibunOf(pnu: string): string | null {
  try {
    return decodePnu(pnu).jibunAddress;
  } catch {
    return null;
  }
}

const RELATION_TEXT: Record<string, string> = {
  '1:1': '건물 하나가 필지 하나 위에 있다',
  '1:N': '건물 하나가 여러 필지에 걸쳐 있다',
  'N:1': '한 필지에 건물이 여러 동 있고 모두 그 안에 있다',
  'N:M': '한 필지의 건물 중 일부가 다른 필지에도 걸쳐 있다',
};

const pct = (r: number | undefined) => (r === undefined ? undefined : Math.round(r * 1000) / 10);

function view(v: RelationView) {
  return {
    status: v.status,
    ...(v.error && { error: v.error }),
    relation: v.relation,
    relationText: v.relation ? RELATION_TEXT[v.relation] : null,
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

export function candidate(c: AddressCandidate) {
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

function summaryLine(a: ParcelAnalysis | BuildingAnalysis): string {
  const where =
    a.start === 'parcel'
      ? `필지 ${jibunOf(a.pnu) ?? a.pnu}에서 출발`
      : `건물 ${a.candidate.roadAddress}${a.candidate.buildingName ? `(${a.candidate.buildingName})` : ''}에서 출발`;
  const rel = (v: RelationView) => (v.status === 'ok' ? (v.relation ?? '-') : v.status);
  const agree = a.agree === null ? '한쪽 근거가 없어 비교 못 함' : a.agree ? '두 근거 일치' : '두 근거 불일치';
  const parts = [`${where}: 대장 기준 ${rel(a.ledger)}, 공간 기준 ${rel(a.spatial)} (${agree})`];
  if (a.discrepancies.length) parts.push(`불일치·주의 ${a.discrepancies.length}건`);
  if (a.incomplete)
    parts.push(
      a.incomplete.retryable ? '일부 자료 누락 — 잠시 후 다시 물어보면 된다' : '일부 자료 누락 — 설정 확인 필요',
    );
  return parts.join('. ');
}

export function analysis(a: ParcelAnalysis | BuildingAnalysis) {
  return {
    summary: summaryLine(a),
    start: a.start,
    ...(a.start === 'parcel' ? { pnu: a.pnu, jibunAddress: jibunOf(a.pnu) } : { building: candidate(a.candidate) }),
    ledger: view(a.ledger),
    spatial: view(a.spatial),
    agree: a.agree,
    discrepancies: a.discrepancies,
    notes: a.notes,
    incomplete: a.incomplete,
    relationNotation: '건물 수 : 필지 수',
  };
}

/** analyze 결과 전체 → MCP 응답 본문 */
export function result(r: AnalysisResult) {
  switch (r.status) {
    case 'ok':
      return { status: 'ok', input: r.input, inputKind: r.inputKind, ...analysis(r.analysis) };
    case 'ambiguous':
      return {
        status: 'ambiguous',
        input: r.input,
        inputKind: r.inputKind,
        message: r.message,
        candidates: r.candidates.map(candidate),
        parcels: r.parcels,
      };
    case 'not_found':
      return r;
    case 'error':
      return r;
  }
}
