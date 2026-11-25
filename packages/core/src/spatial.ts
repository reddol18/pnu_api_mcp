/**
 * VWorld 2D데이터 API 2.0 — 필지 경계와 건물 외곽선, 겹침 계산(Turf.js).
 *
 * GET https://api.vworld.kr/req/data
 *   service=data, version=2.0, request=GetFeature, format=json, key, domain, data(레이어), size(≤1000), page,
 *   attrFilter(속성명:연산자:값) 또는 geomFilter(POINT·POLYGON·MULTIPOLYGON·BOX, 면적 2km² 이하)
 *
 * 실제 응답으로 확인한 것 (fixtures/spatial, 2026-11-25):
 * - 서버 호출에는 domain 파라미터가 반드시 필요하다. 없거나 키에 등록하지 않은 URL이면 INCORRECT_KEY.
 * - LP_PA_CBND_BUBUN(연속지적도): attrFilter=pnu:=:… 로 바로 조회. 속성 pnu, addr, jibun("31대"처럼 지목 글자 포함),
 *   bonbun·bubun(지목 글자가 섞여 나옴 → 쓰지 않는다), jiga, gosi_year, gosi_month. 도형은 MultiPolygon.
 * - LT_C_SPBD(도로명주소 건물): attrFilter=bd_mgt_sn:=:… 로 바로 조회. 속성 bd_mgt_sn, buld_nm, buld_nm_dc(동),
 *   rd_nm, buld_no, gro_flo_co, sido, sigungu, gu. 도로명주소가 없는 부속건축물은 없다.
 * - BOX 필터는 사각 범위에 닿는 것을 모두 준다(큰 지하상가 하나로 필지 121개). 그래서 외곽선 그대로(POLYGON)
 *   필터를 걸고, 너무 길면 BOX로 받은 뒤 여기서 겹침으로 거른다.
 * - status: OK / NOT_FOUND(결과 없음) / ERROR(error.code). 숫자도 문자열로 온다.
 */
import area from '@turf/area';
import { featureCollection, feature as turfFeature } from '@turf/helpers';
import intersect from '@turf/intersect';
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';
import { parsePnu } from './pnu.js';
import { defaultSleep, isTimeoutError, type SourceResult, settle } from './source.js';

export const VWORLD_DATA_URL = 'https://api.vworld.kr/req/data';
export const LAYER_PARCEL = 'LP_PA_CBND_BUBUN';
export const LAYER_ROAD_BUILDING = 'LT_C_SPBD';

export type AreaGeometry = Polygon | MultiPolygon;

/**
 * 겹친 면적이 건물 면적의 이 비율보다 작으면 "경계 접촉"으로 본다(측량 오차).
 * 임시값이다. 지금 사례(fixtures/spatial)로는 경계를 못 정한다: 대장 부속지번으로 확인된 실제 걸침 중
 * 가장 작은 것이 4.3%(낭성면 → 262-3)인데, 대장 근거가 없는 겹침(상봉동 126-50 건물 → 126-52)이 3.5%다.
 * 그래서 걸침을 놓치지 않도록 낮게 잡고, 값 자체(ratioOfBuilding)를 결과에 함께 준다.
 */
export const EDGE_CONTACT_RATIO = 0.01;

export class VworldError extends Error {
  override name = 'VworldError';
  constructor(
    message: string,
    /** VWorld error.code (INCORRECT_KEY 등) 또는 HTTP·TIMEOUT·NETWORK·PARSE·NO_KEY·NO_DOMAIN */
    readonly code: string,
  ) {
    super(message);
  }
}

export interface ParcelShape {
  pnu: string;
  /** 지번주소 (addr) */
  address: string | null;
  /** 지번 표기 원문 (예: "31대", "산1-3임" — 끝 글자는 지목) */
  jibunRaw: string | null;
  geometry: AreaGeometry;
}

export interface BuildingShape {
  /** 건물관리번호 25자리 — juso 검색 결과의 bdMgtSn과 같은 값 */
  buildingMgmtNo: string;
  name: string | null;
  /** 건물부명칭 (동) */
  dongName: string | null;
  roadName: string | null;
  buildingNo: string | null;
  groundFloors: number | null;
  geometry: AreaGeometry;
}

type RawFeature = Feature<AreaGeometry, Record<string, string | null | undefined>>;

interface VworldBody {
  response?: {
    status?: string;
    error?: { level?: string; code?: string; text?: string };
    record?: { total?: string; current?: string };
    page?: { total?: string; current?: string; size?: string };
    result?: { featureCollection?: { features?: RawFeature[] } };
  };
}

export interface VworldPage {
  features: RawFeature[];
  totalPages: number;
  currentPage: number;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t : null;
}

/** 응답 JSON 한 페이지를 해석한다. ERROR면 VworldError, NOT_FOUND면 빈 목록. */
export function parseVworldPage(json: unknown): VworldPage {
  const r = (json as VworldBody)?.response;
  if (!r?.status) throw new VworldError('응답에 response.status가 없습니다', 'PARSE');
  if (r.status === 'ERROR') {
    throw new VworldError(`VWorld API 오류: ${r.error?.text ?? ''}`.trim(), r.error?.code ?? 'ERROR');
  }
  const features = r.status === 'NOT_FOUND' ? [] : (r.result?.featureCollection?.features ?? []);
  return {
    features: features.filter((f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'),
    totalPages: Number(r.page?.total ?? 1) || 1,
    currentPage: Number(r.page?.current ?? 1) || 1,
  };
}

export function normalizeParcelShape(f: RawFeature): ParcelShape | null {
  const pnu = str(f.properties?.pnu);
  if (!pnu) return null;
  try {
    parsePnu(pnu);
  } catch {
    return null;
  }
  return { pnu, address: str(f.properties?.addr), jibunRaw: str(f.properties?.jibun), geometry: f.geometry };
}

export function normalizeBuildingShape(f: RawFeature): BuildingShape | null {
  const p = f.properties ?? {};
  const no = str(p.bd_mgt_sn);
  if (!no) return null;
  const floors = Number(str(p.gro_flo_co));
  return {
    buildingMgmtNo: no,
    name: str(p.buld_nm),
    dongName: str(p.buld_nm_dc),
    roadName: str(p.rd_nm),
    buildingNo: str(p.buld_no),
    groundFloors: Number.isFinite(floors) && str(p.gro_flo_co) !== null ? floors : null,
    geometry: f.geometry,
  };
}

// ── 도형 도구 ─────────────────────────────────────────────

const r7 = (n: number) => Math.round(n * 1e7) / 1e7;

/** GeoJSON 면 도형 → WKT (좌표 소수 7자리 ≈ 1cm) */
export function toWkt(g: AreaGeometry): string {
  const ring = (rg: Position[]) => `(${rg.map(([x, y]) => `${r7(x ?? 0)} ${r7(y ?? 0)}`).join(',')})`;
  if (g.type === 'Polygon') return `POLYGON(${g.coordinates.map(ring).join(',')})`;
  return `MULTIPOLYGON(${g.coordinates.map((p) => `(${p.map(ring).join(',')})`).join(',')})`;
}

export function toBox(g: AreaGeometry): string {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of polys)
    for (const rg of p)
      for (const [x = 0, y = 0] of rg) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
  return `BOX(${r7(minX)},${r7(minY)},${r7(maxX)},${r7(maxY)})`;
}

/** 면적(㎡) */
export function areaM2(g: AreaGeometry): number {
  return area(turfFeature(g));
}

export interface Overlap {
  /** 겹친 면적(㎡) */
  areaM2: number;
  /** 겹친 면적 / a 면적 */
  ratioOfA: number;
  /** 겹친 면적 / b 면적 */
  ratioOfB: number;
}

export function overlap(a: AreaGeometry, b: AreaGeometry): Overlap {
  const inter = intersect(featureCollection([turfFeature(a), turfFeature(b)]));
  const ov = inter ? area(inter) : 0;
  const aa = areaM2(a);
  const bb = areaM2(b);
  return { areaM2: ov, ratioOfA: aa > 0 ? ov / aa : 0, ratioOfB: bb > 0 ? ov / bb : 0 };
}

// ── 호출 ─────────────────────────────────────────────────

export interface VworldOptions {
  /** VWorld 인증키 (VWORLD_KEY) */
  key: string;
  /** 키 발급 때 등록한 서비스 URL (VWORLD_DOMAIN). 서버 호출에 필수 */
  domain: string;
  /** 요청 하나의 제한 시간. 기본 5000ms */
  timeoutMs?: number;
  /** 시간 초과·SYSTEM_ERROR 재시도 횟수. 기본 1 */
  retries?: number;
  /** geomFilter에 외곽선 그대로 넣을 최대 WKT 길이. 넘으면 BOX로 받고 여기서 거른다. 기본 6000 */
  maxWktLength?: number;
  /** 최대 페이지 수 (페이지당 1000건). 기본 5 */
  maxPages?: number;
  /** 테스트용 */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set(['TIMEOUT', 'SYSTEM_ERROR', 'HTTP_502', 'HTTP_503', 'HTTP_504']);

async function requestPage(
  layer: string,
  filter: Record<string, string>,
  page: number,
  opts: VworldOptions,
): Promise<VworldPage> {
  const params = new URLSearchParams({
    service: 'data',
    version: '2.0',
    request: 'GetFeature',
    format: 'json',
    errorFormat: 'json',
    data: layer,
    size: '1000',
    page: String(page),
    ...filter,
    key: opts.key,
    domain: opts.domain,
  });
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${VWORLD_DATA_URL}?${params}`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
  } catch (e) {
    const timeout = isTimeoutError(e);
    // URL에 키가 들어 있으므로 원인 메시지는 붙이지 않는다
    throw new VworldError(
      timeout ? 'VWorld API 응답 시간 초과' : 'VWorld API 호출 실패',
      timeout ? 'TIMEOUT' : 'NETWORK',
    );
  }
  if (!res.ok) throw new VworldError(`VWorld API HTTP ${res.status}`, `HTTP_${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new VworldError('VWorld API 응답이 JSON이 아닙니다', 'PARSE');
  }
  return parseVworldPage(json);
}

/** 레이어에서 조건에 맞는 도형을 모든 페이지에서 모은다. */
export async function fetchFeatures(
  layer: string,
  filter: Record<string, string>,
  opts: VworldOptions,
): Promise<RawFeature[]> {
  if (!opts.key) throw new VworldError('VWORLD_KEY가 없습니다', 'NO_KEY');
  if (!opts.domain) throw new VworldError('VWORLD_DOMAIN(키에 등록한 서비스 URL)이 없습니다', 'NO_DOMAIN');
  const retries = opts.retries ?? 1;
  const sleep = opts.sleep ?? defaultSleep;
  const out: RawFeature[] = [];
  const maxPages = opts.maxPages ?? 5;
  for (let page = 1; page <= maxPages; page++) {
    let p: VworldPage | undefined;
    for (let attempt = 0; !p; attempt++) {
      try {
        p = await requestPage(layer, filter, page, opts);
      } catch (e) {
        if (!(e instanceof VworldError) || !RETRYABLE.has(e.code) || attempt >= retries) throw e;
        await sleep(300 * (attempt + 1));
      }
    }
    out.push(...p.features);
    if (p.features.length === 0 || page >= p.totalPages) break;
  }
  return out;
}

function geomFilter(g: AreaGeometry, opts: VworldOptions): { filter: string; exact: boolean } {
  const wkt = toWkt(g);
  if (wkt.length <= (opts.maxWktLength ?? 6000)) return { filter: wkt, exact: true };
  return { filter: toBox(g), exact: false };
}

/** PNU의 필지 경계. 연속지적도에 없으면 null */
export async function getParcelShape(pnu: string, opts: VworldOptions): Promise<ParcelShape | null> {
  parsePnu(pnu);
  const fs = await fetchFeatures(LAYER_PARCEL, { attrFilter: `pnu:=:${pnu}` }, opts);
  for (const f of fs) {
    const p = normalizeParcelShape(f);
    if (p?.pnu === pnu) return p;
  }
  return null;
}

/** 건물관리번호의 건물 외곽선. 없으면 null */
export async function getBuildingShape(buildingMgmtNo: string, opts: VworldOptions): Promise<BuildingShape | null> {
  if (!/^\d{25}$/.test(buildingMgmtNo)) throw new VworldError('건물관리번호는 숫자 25자리여야 합니다', 'INVALID_INPUT');
  const fs = await fetchFeatures(LAYER_ROAD_BUILDING, { attrFilter: `bd_mgt_sn:=:${buildingMgmtNo}` }, opts);
  for (const f of fs) {
    const b = normalizeBuildingShape(f);
    if (b?.buildingMgmtNo === buildingMgmtNo) return b;
  }
  return null;
}

/** 도형과 겹치는 도로명주소 건물들 */
export async function findBuildingsIntersecting(g: AreaGeometry, opts: VworldOptions): Promise<BuildingShape[]> {
  const { filter } = geomFilter(g, opts);
  const fs = await fetchFeatures(LAYER_ROAD_BUILDING, { geomFilter: filter }, opts);
  const seen = new Set<string>();
  const out: BuildingShape[] = [];
  for (const f of fs) {
    const b = normalizeBuildingShape(f);
    if (b && !seen.has(b.buildingMgmtNo)) {
      seen.add(b.buildingMgmtNo);
      out.push(b);
    }
  }
  return out;
}

/** 도형과 겹치는 필지들 */
export async function findParcelsIntersecting(g: AreaGeometry, opts: VworldOptions): Promise<ParcelShape[]> {
  const { filter } = geomFilter(g, opts);
  const fs = await fetchFeatures(LAYER_PARCEL, { geomFilter: filter }, opts);
  const seen = new Set<string>();
  const out: ParcelShape[] = [];
  for (const f of fs) {
    const p = normalizeParcelShape(f);
    if (p && !seen.has(p.pnu)) {
      seen.add(p.pnu);
      out.push(p);
    }
  }
  return out;
}

// ── 관계 (공간 기준) ─────────────────────────────────────

export interface SpatialLink {
  /** 겹친 면적(㎡) */
  overlapAreaM2: number;
  /** 겹친 면적 / 건물 면적 */
  ratioOfBuilding: number;
  /** 겹친 면적 / 필지 면적 */
  ratioOfParcel: number;
  /** 건물 면적의 EDGE_CONTACT_RATIO 미만만 겹침 → 경계 접촉(측량 오차)으로 본다 */
  edgeContact: boolean;
}

export interface BuildingOnParcel extends SpatialLink {
  building: BuildingShape;
}

export interface ParcelUnderBuilding extends SpatialLink {
  parcel: ParcelShape;
}

function link(building: AreaGeometry, parcel: AreaGeometry, edgeRatio: number): SpatialLink {
  const o = overlap(building, parcel);
  return {
    overlapAreaM2: o.areaM2,
    ratioOfBuilding: o.ratioOfA,
    ratioOfParcel: o.ratioOfB,
    edgeContact: o.ratioOfA < edgeRatio,
  };
}

/** 비율 큰 순, 같으면(소수 6자리까지) id 순 — 결과 순서를 고정한다 */
function byRatioThenId<T extends { ratioOfBuilding: number }>(id: (x: T) => string) {
  return (a: T, b: T) => {
    const d = Math.round(b.ratioOfBuilding * 1e6) - Math.round(a.ratioOfBuilding * 1e6);
    return d !== 0 ? d : id(a).localeCompare(id(b));
  };
}

/** 필지 → 건물들. 겹침이 0인 것(BOX로 받은 것 등)은 뺀다. 겹침 큰 순. */
export function linkBuildingsToParcel(
  parcel: ParcelShape,
  buildings: BuildingShape[],
  edgeRatio = EDGE_CONTACT_RATIO,
): BuildingOnParcel[] {
  return buildings
    .map((building) => ({ building, ...link(building.geometry, parcel.geometry, edgeRatio) }))
    .filter((x) => x.overlapAreaM2 > 0)
    .sort(byRatioThenId((x) => x.building.buildingMgmtNo));
}

/** 건물 → 필지들. 겹침이 0인 것은 뺀다. 겹침 큰 순. */
export function linkParcelsToBuilding(
  building: BuildingShape,
  parcels: ParcelShape[],
  edgeRatio = EDGE_CONTACT_RATIO,
): ParcelUnderBuilding[] {
  return parcels
    .map((parcel) => ({ parcel, ...link(building.geometry, parcel.geometry, edgeRatio) }))
    .filter((x) => x.overlapAreaM2 > 0)
    .sort(byRatioThenId((x) => x.parcel.pnu));
}

export interface SpatialParcelBuildings {
  pnu: string;
  /** 연속지적도에 없거나 조회 실패면 null */
  parcel: ParcelShape | null;
  buildings: SourceResult<BuildingOnParcel>;
}

/** 필지 → 건물들 (공간 기준) */
export async function spatialParcelBuildings(pnu: string, opts: VworldOptions): Promise<SpatialParcelBuildings> {
  const found: { parcel: ParcelShape | null } = { parcel: null };
  const buildings = await settle(
    (async () => {
      const parcel = await getParcelShape(pnu, opts);
      found.parcel = parcel;
      if (!parcel) return [];
      return linkBuildingsToParcel(parcel, await findBuildingsIntersecting(parcel.geometry, opts));
    })(),
  );
  return { pnu, parcel: found.parcel, buildings };
}

export interface SpatialBuildingParcels {
  buildingMgmtNo: string;
  /** 도로명주소 건물 레이어에 없거나 조회 실패면 null */
  building: BuildingShape | null;
  parcels: SourceResult<ParcelUnderBuilding>;
}

/** 건물 → 필지들 (공간 기준) */
export async function spatialBuildingParcels(
  buildingMgmtNo: string,
  opts: VworldOptions,
): Promise<SpatialBuildingParcels> {
  const found: { building: BuildingShape | null } = { building: null };
  const parcels = await settle(
    (async () => {
      const building = await getBuildingShape(buildingMgmtNo, opts);
      found.building = building;
      if (!building) return [];
      return linkParcelsToBuilding(building, await findParcelsIntersecting(building.geometry, opts));
    })(),
  );
  return { buildingMgmtNo, building: found.building, parcels };
}
