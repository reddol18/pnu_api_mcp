/**
 * 입력(주소·PNU·건물관리번호) 하나로 대장·공간을 조회하고 관계를 판정한다.
 * MCP 도구와 웹이 이것만 부른다.
 *
 * - 지번주소·PNU → 필지에서 출발 (필지 → 건물들)
 * - 도로명주소·건물관리번호·건물명 → 건물에서 출발 (건물 → 필지들)
 */
import { type AddressCandidate, classifyInput, type InputKind, parseAddressNumber, searchAddress } from './address.js';
import { type LedgerOptions, lookupParcelLedger, type ParcelLedger } from './ledger.js';
import { parsePnu } from './pnu.js';
import {
  type BuildingStartContext,
  type Discrepancy,
  discrepanciesFromBuilding,
  discrepanciesFromParcel,
  ledgerViewFromBuilding,
  ledgerViewFromParcel,
  type RelationView,
  spatialViewFromBuilding,
  spatialViewFromParcel,
} from './relation.js';
import { type SourceResult, settle } from './source.js';
import {
  findParcelsIntersecting,
  getBuildingShape,
  linkParcelsToBuilding,
  type ParcelUnderBuilding,
  type SpatialBuildingParcels,
  type SpatialParcelBuildings,
  spatialBuildingParcels,
  spatialParcelBuildings,
  type VworldOptions,
} from './spatial.js';

export interface AnalyzeOptions {
  jusoKey?: string;
  dataGoKrKey?: string;
  vworldKey?: string;
  vworldDomain?: string;
  /** 요청 하나의 제한 시간. 기본 5000ms */
  timeoutMs?: number;
  /** 필지 → 건물 방향에서 각 건물이 걸친 필지까지 볼 최대 건물 수. 기본 10 */
  maxBuildings?: number;
  /** 테스트용 */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** 대장·공간 근거를 따로 보여 주고, 둘이 같은지 알려 준다 */
export interface RelationResult {
  ledger: RelationView;
  spatial: RelationView;
  /** 둘 다 판정됐고 관계 종류가 같으면 true, 어느 한쪽이라도 판정 못 하면 null */
  agree: boolean | null;
  discrepancies: Discrepancy[];
  notes: string[];
}

export interface ParcelAnalysis extends RelationResult {
  start: 'parcel';
  pnu: string;
  raw: { ledger: ParcelLedger; spatial: SpatialParcelBuildings };
}

export interface BuildingAnalysis extends RelationResult {
  start: 'building';
  candidate: AddressCandidate;
  raw: { ledger: ParcelLedger; spatial: SpatialBuildingParcels };
}

export type AnalysisResult =
  | { status: 'ok'; input: string; inputKind: InputKind; analysis: ParcelAnalysis | BuildingAnalysis }
  | { status: 'ambiguous'; input: string; inputKind: InputKind; message: string; candidates: AddressCandidate[] }
  | { status: 'not_found'; input: string; inputKind: InputKind; message: string }
  | { status: 'error'; input: string; inputKind: InputKind; error: { code: string; message: string } };

/** 공통 선택 옵션 (값이 있는 것만 — exactOptionalPropertyTypes) */
function common(o: AnalyzeOptions) {
  return {
    ...(o.timeoutMs !== undefined && { timeoutMs: o.timeoutMs }),
    ...(o.fetch && { fetch: o.fetch }),
    ...(o.sleep && { sleep: o.sleep }),
  };
}

function vworldOpts(o: AnalyzeOptions): VworldOptions {
  return { key: o.vworldKey ?? '', domain: o.vworldDomain ?? '', ...common(o) };
}

function ledgerOpts(o: AnalyzeOptions): LedgerOptions {
  return { key: o.dataGoKrKey ?? '', ...common(o) };
}

/** 관계 종류와 필지 목록이 둘 다 같아야 일치. 한쪽이라도 판정 못 하면 null */
function agree(a: RelationView, b: RelationView): boolean | null {
  if (!a.relation || !b.relation) return null;
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((p) => y.includes(p));
  return a.relation === b.relation && same(a.parcels, b.parcels);
}

/** 일부 소스만 실패한 것은 판정 결과(view)에 드러나지 않으니 notes에 적는다 */
function ledgerFailureNotes(l: ParcelLedger): string[] {
  const names: [keyof Omit<ParcelLedger, 'pnu'>, string][] = [
    ['titles', '표제부'],
    ['recapTitles', '총괄표제부'],
    ['attachedJibuns', '부속지번'],
  ];
  return names.flatMap(([k, label]) => {
    const r = l[k];
    return r.status === 'error' ? [`대장 ${label} 조회 실패(${r.error.code}) — 대장 기준 결과가 빠졌을 수 있다.`] : [];
  });
}

const NOTE_NO_REVERSE =
  '대장으로는 "이 필지를 부속지번으로 쓰는 다른 지번의 건물"을 찾을 수 없다(건축HUB에 역방향 조회 없음). 그런 건물은 공간 기준에만 나온다.';
const NOTE_SPATIAL_LAYER =
  '공간 기준의 건물은 도로명주소 건물 레이어(LT_C_SPBD)라서 도로명주소가 없는 부속건축물은 빠진다.';

/** 필지(PNU)에서 출발: 이 필지의 건물들과, 그 건물들이 걸친 다른 필지들 */
export async function analyzeParcel(pnu: string, opts: AnalyzeOptions): Promise<ParcelAnalysis> {
  parsePnu(pnu);
  const vw = vworldOpts(opts);
  const [ledgerRaw, spatialRaw] = await Promise.all([
    lookupParcelLedger(pnu, ledgerOpts(opts)),
    spatialParcelBuildings(pnu, vw),
  ]);

  // 각 건물이 걸친 다른 필지들 (건물 외곽선은 이미 받았으니 필지만 찾는다)
  const parcelsOf = new Map<string, SourceResult<ParcelUnderBuilding>>();
  const targets = spatialRaw.buildings.data.filter((b) => !b.edgeContact).slice(0, opts.maxBuildings ?? 10);
  await Promise.all(
    targets.map(async (b) => {
      const r = await settle(
        findParcelsIntersecting(b.building.geometry, vw).then((ps) => linkParcelsToBuilding(b.building, ps)),
      );
      parcelsOf.set(b.building.buildingMgmtNo, r);
    }),
  );

  const ledger = ledgerViewFromParcel(ledgerRaw);
  const spatial = spatialViewFromParcel(spatialRaw, parcelsOf);
  const notes = [NOTE_NO_REVERSE, NOTE_SPATIAL_LAYER, ...ledgerFailureNotes(ledgerRaw)];
  const skipped = spatialRaw.buildings.data.filter((b) => !b.edgeContact).length - targets.length;
  if (skipped > 0) notes.push(`건물이 많아 ${skipped}동은 다른 필지에 걸쳤는지 보지 않았다.`);
  const failed = [...parcelsOf.values()].filter((r) => r.status === 'error').length;
  if (failed) notes.push(`건물 ${failed}동은 걸친 필지 조회에 실패했다.`);
  return {
    start: 'parcel',
    pnu,
    ledger,
    spatial,
    agree: agree(ledger, spatial),
    discrepancies: discrepanciesFromParcel({ pnu, ledgerRaw, spatialRaw }, ledger, spatial),
    notes,
    raw: { ledger: ledgerRaw, spatial: spatialRaw },
  };
}

/** 건물(주소 검색 후보)에서 출발: 이 건물이 걸친 필지들 */
export async function analyzeBuilding(candidate: AddressCandidate, opts: AnalyzeOptions): Promise<BuildingAnalysis> {
  const [ledgerRaw, spatialRaw] = await Promise.all([
    lookupParcelLedger(candidate.pnu, ledgerOpts(opts)),
    spatialBuildingParcels(candidate.buildingMgmtNo, vworldOpts(opts)),
  ]);
  const { view: ledger, matched } = ledgerViewFromBuilding(ledgerRaw, candidate);
  const spatial = spatialViewFromBuilding(spatialRaw);
  const ctx: BuildingStartContext = { candidate, ledgerMatched: matched, ledgerRaw, spatialRaw };
  const notes = [NOTE_SPATIAL_LAYER, ...ledgerFailureNotes(ledgerRaw)];
  if (matched === 'road-key' && ledger.buildings.length > 1) {
    notes.push(`이 도로명주소 하나에 대장 표제부가 ${ledger.buildings.length}동 있다.`);
  }
  return {
    start: 'building',
    candidate,
    ledger,
    spatial,
    agree: agree(ledger, spatial),
    discrepancies: discrepanciesFromBuilding(ctx, ledger, spatial),
    notes,
    raw: { ledger: ledgerRaw, spatial: spatialRaw },
  };
}

function errorOf(e: unknown): { code: string; message: string } {
  const code = (e as { code?: unknown } | null)?.code;
  return { code: typeof code === 'string' ? code : 'UNKNOWN', message: e instanceof Error ? e.message : String(e) };
}

async function search(keyword: string, opts: AnalyzeOptions): Promise<AddressCandidate[]> {
  const { sleep: _sleep, ...rest } = common(opts);
  const r = await searchAddress(keyword, { key: opts.jusoKey ?? '', countPerPage: 20, ...rest });
  return r.candidates;
}

/**
 * 입력 하나를 받아 출발점을 정하고 관계를 판정한다.
 * 후보가 여럿이면 판정하지 않고 ambiguous로 후보를 돌려준다(사용자가 고르게).
 */
export async function analyze(input: string, opts: AnalyzeOptions): Promise<AnalysisResult> {
  const s = input.trim();
  const inputKind = classifyInput(s);
  const base = { input: s, inputKind };
  try {
    if (inputKind === 'pnu') {
      return { status: 'ok', ...base, analysis: await analyzeParcel(s, opts) };
    }

    if (inputKind === 'buildingMgmtNo') {
      const shape = await getBuildingShape(s, vworldOpts(opts));
      if (!shape?.roadAddressHint) {
        return { status: 'not_found', ...base, message: '이 건물관리번호의 도로명주소 건물을 찾지 못했다' };
      }
      const c = (await search(shape.roadAddressHint, opts)).find((x) => x.buildingMgmtNo === s);
      if (!c) {
        return {
          status: 'not_found',
          ...base,
          message: `건물은 있지만(${shape.roadAddressHint}) 주소 검색에서 같은 건물관리번호를 찾지 못했다`,
        };
      }
      return { status: 'ok', ...base, analysis: await analyzeBuilding(c, opts) };
    }

    const candidates = await search(s, opts);
    const num = parseAddressNumber(s);

    if (inputKind === 'jibun') {
      const hits = num
        ? candidates.filter(
            (c) => c.parcel.mountain === num.mountain && c.parcel.bonbun === num.main && c.parcel.bubun === num.sub,
          )
        : [];
      const pnus = [...new Set(hits.map((c) => c.pnu))];
      if (pnus.length === 1 && pnus[0]) return { status: 'ok', ...base, analysis: await analyzeParcel(pnus[0], opts) };
      if (pnus.length > 1) {
        return {
          status: 'ambiguous',
          ...base,
          message: '같은 지번이 여러 법정동에 있다. PNU로 다시 물어보라',
          candidates: hits,
        };
      }
      return {
        status: 'not_found',
        ...base,
        message:
          '주소 검색에서 이 지번의 건물을 찾지 못했다(도로명주소 건물이 없는 필지일 수 있다). PNU(19자리)로 물어보면 대장·공간을 바로 조회한다',
      };
    }

    let pick = candidates;
    if (inputKind === 'road' && num) {
      // "세종대로 110" → 세종대로 110만 (세종대로14길 20-2 같은 다른 길 제외)
      const roadName = num.head.split(' ').at(-1) ?? '';
      const exact = candidates.filter(
        (c) => c.roadName === roadName && c.buildingMainNo === num.main && c.buildingSubNo === num.sub,
      );
      if (exact.length) pick = exact;
    }
    if (pick.length === 1 && pick[0]) return { status: 'ok', ...base, analysis: await analyzeBuilding(pick[0], opts) };
    if (pick.length === 0) return { status: 'not_found', ...base, message: '주소 검색 결과가 없다' };
    return { status: 'ambiguous', ...base, message: '후보가 여럿이다. 하나를 골라 다시 물어보라', candidates: pick };
  } catch (e) {
    return { status: 'error', ...base, error: errorOf(e) };
  }
}
