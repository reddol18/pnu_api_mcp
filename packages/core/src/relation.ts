/**
 * 필지-건물 관계 분류와 불일치 판정. 외부 호출 없음 — 대장(ledger)·공간(spatial) 결과를 받아 계산만 한다.
 *
 * 관계 표기는 "건물 수 : 필지 수".
 *   1:1  건물 하나가 필지 하나 위에
 *   1:N  건물 하나가 여러 필지에 걸침
 *   N:1  한 필지에 건물 여러 동, 모두 그 필지 안
 *   N:M  한 필지의 건물들 중 일부가 다른 필지에도 걸침
 *
 * 대장 기준과 공간 기준을 따로 계산하고(§2-3), 둘이 다르면 불일치로 알려 준다.
 * 불일치는 오류가 아니라 정보다(§9: 두 데이터의 기준일이 다르다).
 */
import type { AddressCandidate } from './address.js';
import type { AttachedJibunRecord, ParcelLedger, RecapTitleRecord, TitleRecord } from './ledger.js';
import type { SourceResult } from './source.js';
import type { BuildingShape, ParcelUnderBuilding, SpatialBuildingParcels, SpatialParcelBuildings } from './spatial.js';

export type RelationKind = '1:1' | '1:N' | 'N:1' | 'N:M';

export interface GraphBuilding {
  /** 대장 PK 또는 건물관리번호 */
  id: string;
  /** 대장: title(표제부·일반건축물) / recap(총괄표제부). 공간: road-building(도로명주소 건물) */
  kind: 'title' | 'recap' | 'road-building';
  name: string | null;
  dongName: string | null;
}

export interface GraphEdge {
  buildingId: string;
  pnu: string;
  /** representative: 대장의 대지위치, attached: 대장의 부속지번, overlap: 공간상 겹침 */
  via: 'representative' | 'attached' | 'overlap';
  /** overlap일 때 겹친 면적 / 건물 면적 */
  ratioOfBuilding?: number;
}

export interface EdgeContact {
  buildingId: string;
  pnu: string;
  ratioOfBuilding: number;
}

export interface RelationView {
  /** skipped: 키가 없는 등으로 조회하지 않음 */
  status: 'ok' | 'empty' | 'error';
  error?: { code: string; message: string };
  /** 건물이 없으면 null */
  relation: RelationKind | null;
  buildings: GraphBuilding[];
  parcels: string[];
  edges: GraphEdge[];
  /** 공간 기준: 경계 접촉(측량 오차로 보고 관계에서 뺀 것) */
  edgeContacts: EdgeContact[];
}

export type DiscrepancyCode =
  | 'parcel_not_in_cadastral'
  | 'recap_without_titles'
  | 'ledger_parcel_not_spatial'
  | 'spatial_parcel_not_ledger'
  | 'building_count_differs'
  | 'representative_not_under_building'
  | 'ledger_unmatched';

export interface Discrepancy {
  code: DiscrepancyCode;
  message: string;
  pnu?: string;
  buildingId?: string;
}

export function classify(
  buildingCount: number,
  parcelCount: number,
  someBuildingSpansMany: boolean,
): RelationKind | null {
  if (buildingCount === 0 || parcelCount === 0) return null;
  if (buildingCount === 1) return parcelCount === 1 ? '1:1' : '1:N';
  return someBuildingSpansMany ? 'N:M' : 'N:1';
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function spansMany(edges: GraphEdge[]): boolean {
  const per = new Map<string, Set<string>>();
  for (const e of edges) {
    const s = per.get(e.buildingId) ?? new Set<string>();
    s.add(e.pnu);
    per.set(e.buildingId, s);
  }
  return [...per.values()].some((s) => s.size > 1);
}

function view(
  status: RelationView['status'],
  buildings: GraphBuilding[],
  edges: GraphEdge[],
  extra: Partial<RelationView> = {},
): RelationView {
  const parcels = uniq(edges.map((e) => e.pnu));
  return {
    status,
    relation: classify(buildings.length, parcels.length, spansMany(edges)),
    buildings,
    parcels,
    edges,
    edgeContacts: [],
    ...extra,
  };
}

function errorView(r: { status: 'error'; error: { code: string; message: string } }): RelationView {
  return { status: 'error', error: r.error, relation: null, buildings: [], parcels: [], edges: [], edgeContacts: [] };
}

const titleNode = (t: TitleRecord): GraphBuilding => ({
  id: t.pk,
  kind: 'title',
  name: t.buildingName,
  dongName: t.dongName,
});
const recapNode = (r: RecapTitleRecord): GraphBuilding => ({
  id: r.pk,
  kind: 'recap',
  name: r.buildingName,
  dongName: null,
});

/** 대장 노드와 간선: 각 노드 → 자기 대지위치, 부속지번 → 그 대장 노드(대장이 노드가 아니면 attachTo 노드들) */
function ledgerEdges(
  nodes: GraphBuilding[],
  ownParcels: Map<string, string | null>,
  attached: AttachedJibunRecord[],
  attachTo: (a: AttachedJibunRecord) => GraphBuilding[],
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (e: GraphEdge) => {
    const k = `${e.buildingId}|${e.pnu}`;
    if (!seen.has(k)) {
      seen.add(k);
      edges.push(e);
    }
  };
  for (const n of nodes) {
    const pnu = ownParcels.get(n.id);
    if (pnu) add({ buildingId: n.id, pnu, via: 'representative' });
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const a of attached) {
    const pnu = a.attachedParcel.pnu;
    if (!pnu) continue;
    const targets = ids.has(a.pk) ? nodes.filter((n) => n.id === a.pk) : attachTo(a);
    for (const n of targets) add({ buildingId: n.id, pnu, via: 'attached' });
  }
  return edges;
}

function ledgerStatus(l: ParcelLedger): {
  status: 'ok' | 'empty' | 'error';
  error?: { code: string; message: string };
} {
  const srcs = [l.titles, l.recapTitles];
  if (srcs.some((s) => s.status === 'ok')) return { status: 'ok' };
  const err = srcs.find((s) => s.status === 'error');
  if (err?.status === 'error') return { status: 'error', error: err.error };
  return { status: 'empty' };
}

/**
 * 필지에서 출발한 대장 기준 관계.
 * 건물 = 그 지번의 표제부 중 주건축물(없으면 표제부 전부, 표제부가 없으면 총괄표제부).
 * 부속지번은 그 대장 건물에, 노드가 아닌 대장(총괄표제부·부속건축물)의 부속지번은 대지 전체(모든 건물)에 붙인다.
 */
export function ledgerViewFromParcel(l: ParcelLedger): RelationView {
  const st = ledgerStatus(l);
  if (st.status === 'error' && st.error) return errorView({ status: 'error', error: st.error });
  const titles = l.titles.data;
  const mains = titles.filter((t) => t.mainOrAttached !== 'attached');
  const nodeTitles = mains.length ? mains : titles;
  const nodes = nodeTitles.length ? nodeTitles.map(titleNode) : l.recapTitles.data.map(recapNode);
  const own = new Map<string, string | null>([
    ...titles.map((t) => [t.pk, t.parcel.pnu] as const),
    ...l.recapTitles.data.map((r) => [r.pk, r.parcel.pnu] as const),
  ]);
  const edges = ledgerEdges(nodes, own, l.attachedJibuns.data, () => nodes);
  return view(st.status === 'ok' && nodes.length ? 'ok' : 'empty', nodes, edges);
}

function sameRoadKey(t: { roadKey: TitleRecord['roadKey'] }, c: AddressCandidate): boolean {
  return (
    t.roadKey !== null &&
    t.roadKey.roadCode === c.roadNameCode &&
    t.roadKey.mainNo === c.buildingMainNo &&
    t.roadKey.subNo === c.buildingSubNo
  );
}

/**
 * 건물(도로명주소)에서 출발한 대장 기준 관계.
 * 대표지번의 대장 중 도로명 키(도로코드·건물번호)가 같은 표제부를 이 건물로 본다.
 * 하나도 안 맞으면 총괄표제부를 쓰고, 그것도 없으면 empty + matched=false.
 */
export function ledgerViewFromBuilding(
  l: ParcelLedger,
  c: AddressCandidate,
): { view: RelationView; matched: 'road-key' | 'recap' | false } {
  const st = ledgerStatus(l);
  if (st.status === 'error' && st.error)
    return { view: errorView({ status: 'error', error: st.error }), matched: false };
  const matchedTitles = l.titles.data.filter((t) => sameRoadKey(t, c));
  let nodes: GraphBuilding[];
  let matched: 'road-key' | 'recap' | false;
  if (matchedTitles.length) {
    nodes = matchedTitles.map(titleNode);
    matched = 'road-key';
  } else if (l.recapTitles.data.length) {
    nodes = l.recapTitles.data.map(recapNode);
    matched = 'recap';
  } else {
    nodes = [];
    matched = false;
  }
  const own = new Map<string, string | null>([
    ...l.titles.data.map((t) => [t.pk, t.parcel.pnu] as const),
    ...l.recapTitles.data.map((r) => [r.pk, r.parcel.pnu] as const),
  ]);
  // 노드가 아닌 대장 중 총괄표제부(대지 전체)의 부속지번만 이 건물에 붙인다. 같은 대지의 다른 건물 것은 뺀다.
  const recapIds = new Set(l.recapTitles.data.map((r) => r.pk));
  const edges = ledgerEdges(nodes, own, l.attachedJibuns.data, (a) =>
    recapIds.has(a.pk) || a.registerKind === '1' ? nodes : [],
  );
  const v = view(nodes.length ? 'ok' : 'empty', nodes, edges);
  // 출발점이 건물 하나(도로명주소)이므로 건물 수는 1로 본다
  v.relation = classify(nodes.length ? 1 : 0, v.parcels.length, false);
  return { view: v, matched };
}

const roadNode = (b: BuildingShape): GraphBuilding => ({
  id: b.buildingMgmtNo,
  kind: 'road-building',
  name: b.name,
  dongName: b.dongName,
});

/**
 * 필지에서 출발한 공간 기준 관계.
 * 건물 = 필지와 겹치는 도로명주소 건물(경계 접촉 제외), 각 건물이 걸친 필지들까지 본다.
 */
export function spatialViewFromParcel(
  s: SpatialParcelBuildings,
  parcelsOf: Map<string, SourceResult<ParcelUnderBuilding>>,
): RelationView {
  if (s.buildings.status === 'error') return errorView(s.buildings);
  const onParcel = s.buildings.data;
  const kept = onParcel.filter((b) => !b.edgeContact);
  const edgeContacts: EdgeContact[] = onParcel
    .filter((b) => b.edgeContact)
    .map((b) => ({ buildingId: b.building.buildingMgmtNo, pnu: s.pnu, ratioOfBuilding: b.ratioOfBuilding }));
  const edges: GraphEdge[] = [];
  for (const b of kept) {
    const id = b.building.buildingMgmtNo;
    edges.push({ buildingId: id, pnu: s.pnu, via: 'overlap', ratioOfBuilding: b.ratioOfBuilding });
    const others = parcelsOf.get(id);
    for (const p of others?.data ?? []) {
      if (p.parcel.pnu === s.pnu) continue;
      if (p.edgeContact) edgeContacts.push({ buildingId: id, pnu: p.parcel.pnu, ratioOfBuilding: p.ratioOfBuilding });
      else edges.push({ buildingId: id, pnu: p.parcel.pnu, via: 'overlap', ratioOfBuilding: p.ratioOfBuilding });
    }
  }
  const nodes = kept.map((b) => roadNode(b.building));
  return view(nodes.length ? 'ok' : 'empty', nodes, edges, { edgeContacts });
}

/** 건물에서 출발한 공간 기준 관계 */
export function spatialViewFromBuilding(s: SpatialBuildingParcels): RelationView {
  if (s.parcels.status === 'error') return errorView(s.parcels);
  if (!s.building) return view('empty', [], []);
  const id = s.building.buildingMgmtNo;
  const edges: GraphEdge[] = [];
  const edgeContacts: EdgeContact[] = [];
  for (const p of s.parcels.data) {
    if (p.edgeContact) edgeContacts.push({ buildingId: id, pnu: p.parcel.pnu, ratioOfBuilding: p.ratioOfBuilding });
    else edges.push({ buildingId: id, pnu: p.parcel.pnu, via: 'overlap', ratioOfBuilding: p.ratioOfBuilding });
  }
  return view(edges.length ? 'ok' : 'empty', [roadNode(s.building)], edges, { edgeContacts });
}

function parcelSetDiff(ledger: RelationView, spatial: RelationView): Discrepancy[] {
  if (ledger.status !== 'ok' || spatial.status !== 'ok') return [];
  const out: Discrepancy[] = [];
  const sp = new Set(spatial.parcels);
  const lp = new Set(ledger.parcels);
  for (const pnu of ledger.parcels) {
    if (!sp.has(pnu)) {
      out.push({
        code: 'ledger_parcel_not_spatial',
        pnu,
        message: `대장에는 이 건물(들)의 지번으로 ${pnu}이 있는데 공간상으로는 건물이 이 필지에 걸치지 않는다`,
      });
    }
  }
  for (const pnu of spatial.parcels) {
    if (!lp.has(pnu)) {
      out.push({
        code: 'spatial_parcel_not_ledger',
        pnu,
        message: `공간상으로는 건물이 ${pnu}에도 걸치는데 대장(대지위치·부속지번)에는 없다`,
      });
    }
  }
  return out;
}

export interface ParcelStartContext {
  pnu: string;
  ledgerRaw: ParcelLedger;
  spatialRaw: SpatialParcelBuildings;
}

/** 필지에서 출발했을 때의 불일치 */
export function discrepanciesFromParcel(ctx: ParcelStartContext, ledger: RelationView, spatial: RelationView) {
  const out: Discrepancy[] = [];
  if (ctx.spatialRaw.buildings.status !== 'error' && ctx.spatialRaw.parcel === null) {
    out.push({
      code: 'parcel_not_in_cadastral',
      pnu: ctx.pnu,
      message: '연속지적도에 이 PNU의 필지가 없다(합필·분필 등으로 지금은 없는 지번일 수 있다)',
    });
  }
  if (
    ctx.ledgerRaw.recapTitles.data.length &&
    !ctx.ledgerRaw.titles.data.length &&
    ctx.ledgerRaw.titles.status !== 'error'
  ) {
    out.push({
      code: 'recap_without_titles',
      pnu: ctx.pnu,
      message: '총괄표제부는 있는데 같은 지번으로 조회되는 표제부(동)가 없다 — 동별 대장이 다른 지번에 있을 수 있다',
    });
  }
  out.push(...parcelSetDiff(ledger, spatial));
  if (ledger.status === 'ok' && spatial.status === 'ok' && ledger.buildings.length !== spatial.buildings.length) {
    out.push({
      code: 'building_count_differs',
      pnu: ctx.pnu,
      message: `건물 수가 다르다: 대장 ${ledger.buildings.length}동, 공간(도로명주소 건물) ${spatial.buildings.length}동 — 부속건축물은 도로명주소가 없어 공간에 안 잡히고, 이웃 건물이 걸치면 공간에만 잡힌다`,
    });
  }
  return out;
}

export interface BuildingStartContext {
  candidate: AddressCandidate;
  ledgerMatched: 'road-key' | 'recap' | false;
  ledgerRaw: ParcelLedger;
  spatialRaw: SpatialBuildingParcels;
}

/** 건물에서 출발했을 때의 불일치 */
export function discrepanciesFromBuilding(ctx: BuildingStartContext, ledger: RelationView, spatial: RelationView) {
  const out: Discrepancy[] = [];
  const rep = ctx.candidate.pnu;
  if (spatial.status === 'ok' && !spatial.parcels.includes(rep)) {
    out.push({
      code: 'representative_not_under_building',
      pnu: rep,
      buildingId: ctx.candidate.buildingMgmtNo,
      message: `주소의 대표지번 ${rep} 위에 이 건물 외곽선이 없다 — 실제로는 ${spatial.parcels.join(', ')} 위에 있다`,
    });
  }
  if (ctx.ledgerMatched === false && ctx.ledgerRaw.titles.status !== 'error') {
    out.push({
      code: 'ledger_unmatched',
      pnu: rep,
      buildingId: ctx.candidate.buildingMgmtNo,
      message: '대표지번의 대장에서 이 도로명주소(도로코드·건물번호)와 맞는 표제부를 찾지 못했다',
    });
  }
  if (ctx.ledgerMatched === 'recap') {
    out.push({
      code: 'recap_without_titles',
      pnu: rep,
      message: '도로명주소와 맞는 표제부가 없어 총괄표제부(대지 전체) 기준으로 봤다',
    });
  }
  out.push(...parcelSetDiff(ledger, spatial));
  return out;
}
