/**
 * 입력(주소·PNU·건물관리번호) 하나로 대장·공간을 조회하고 관계를 판정한다.
 * MCP 도구와 웹이 이것만 부른다.
 *
 * - 지번주소·PNU → 필지에서 출발 (필지 → 건물들)
 * - 도로명주소·건물관리번호·건물명 → 건물에서 출발 (건물 → 필지들)
 */
import { type AddressCandidate, classifyInput, type InputKind, parseAddressNumber, searchAddress } from './address.js';
import { findBjdongByName, loadBjdongTable } from './bjdong.js';
import type { CircuitBreaker } from './breaker.js';
import { defaultLedgerBreaker, type LedgerOptions, lookupParcelLedger, type ParcelLedger } from './ledger.js';
import { formatJibun, formatPnu, parsePnu } from './pnu.js';
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
import {
  describeIncomplete,
  type FailedSource,
  failedFrom,
  failureKind,
  type Incomplete,
  type SourceResult,
  settle,
} from './source.js';
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
  /** 대장 API 회로 차단기. 기본은 프로세스 공용(defaultLedgerBreaker), null이면 쓰지 않는다 */
  ledgerBreaker?: CircuitBreaker | null;
}

/** 대장·공간 근거를 따로 보여 주고, 둘이 같은지 알려 준다 */
export interface RelationResult {
  ledger: RelationView;
  spatial: RelationView;
  /** 둘 다 판정됐고 관계 종류가 같으면 true, 어느 한쪽이라도 판정 못 하면 null */
  agree: boolean | null;
  discrepancies: Discrepancy[];
  notes: string[];
  /** 일부 소스가 실패했으면 무엇이 빠졌는지와 다시 물어보면 되는지 안내. 모두 받았으면 null */
  incomplete: Incomplete | null;
}

export interface ParcelAnalysis extends RelationResult {
  start: 'parcel';
  pnu: string;
  raw: {
    ledger: ParcelLedger;
    spatial: SpatialParcelBuildings;
    /** 건물관리번호 → 그 건물이 걸친 필지들 (지도에 그릴 때 쓴다) */
    parcelsOfBuilding: Record<string, SourceResult<ParcelUnderBuilding>>;
  };
}

export interface BuildingAnalysis extends RelationResult {
  start: 'building';
  candidate: AddressCandidate;
  raw: { ledger: ParcelLedger; spatial: SpatialBuildingParcels };
}

export interface ParcelChoice {
  pnu: string;
  jibunAddress: string;
}

export type AnalysisResult =
  | { status: 'ok'; input: string; inputKind: InputKind; analysis: ParcelAnalysis | BuildingAnalysis }
  | {
      status: 'ambiguous';
      input: string;
      inputKind: InputKind;
      message: string;
      /** 건물 후보 (주소 검색 결과) */
      candidates: AddressCandidate[];
      /** 필지 후보 (같은 이름의 법정동이 여럿일 때) */
      parcels: ParcelChoice[];
    }
  | { status: 'not_found'; input: string; inputKind: InputKind; message: string }
  | {
      status: 'error';
      input: string;
      inputKind: InputKind;
      error: { code: string; message: string };
      /** 잠시 후 같은 질문을 다시 하면 나아질 수 있으면 true */
      retryable: boolean;
      /** 사용자에게 보여 줄 안내 */
      message: string;
    };

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
  const breaker = o.ledgerBreaker === undefined ? defaultLedgerBreaker : o.ledgerBreaker;
  return { key: o.dataGoKrKey ?? '', ...common(o), ...(breaker && { breaker }) };
}

/** 관계 종류와 필지 목록이 둘 다 같아야 일치. 한쪽이라도 판정 못 하면 null */
function agree(a: RelationView, b: RelationView): boolean | null {
  if (!a.relation || !b.relation) return null;
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((p) => y.includes(p));
  return a.relation === b.relation && same(a.parcels, b.parcels);
}

/** 일부 소스만 실패한 것은 판정 결과(view)에 드러나지 않으니 모아서 incomplete로 알린다 */
function ledgerFailures(l: ParcelLedger): FailedSource[] {
  return [
    ...failedFrom('대장 표제부', l.titles),
    ...failedFrom('대장 총괄표제부', l.recapTitles),
    ...failedFrom('대장 부속지번', l.attachedJibuns),
  ];
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
  const notes = [NOTE_NO_REVERSE, NOTE_SPATIAL_LAYER];
  const skipped = spatialRaw.buildings.data.filter((b) => !b.edgeContact).length - targets.length;
  if (skipped > 0) notes.push(`건물이 많아 ${skipped}동은 다른 필지에 걸쳤는지 보지 않았다.`);
  const failed: FailedSource[] = [
    ...ledgerFailures(ledgerRaw),
    ...failedFrom('공간 필지·건물', spatialRaw.buildings),
    ...[...parcelsOf.entries()].flatMap(([id, r]) => failedFrom(`공간 건물 ${id}의 걸친 필지`, r)),
  ];
  return {
    start: 'parcel',
    pnu,
    ledger,
    spatial,
    agree: agree(ledger, spatial),
    discrepancies: discrepanciesFromParcel({ pnu, ledgerRaw, spatialRaw }, ledger, spatial),
    notes,
    incomplete: describeIncomplete(failed),
    raw: { ledger: ledgerRaw, spatial: spatialRaw, parcelsOfBuilding: Object.fromEntries(parcelsOf) },
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
  const notes = [NOTE_SPATIAL_LAYER];
  const failed = [...ledgerFailures(ledgerRaw), ...failedFrom('공간 건물·필지', spatialRaw.parcels)];
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
    incomplete: describeIncomplete(failed),
    raw: { ledger: ledgerRaw, spatial: spatialRaw },
  };
}

function errorOf(e: unknown): { code: string; message: string } {
  const code = (e as { code?: unknown } | null)?.code;
  return { code: typeof code === 'string' ? code : 'UNKNOWN', message: e instanceof Error ? e.message : String(e) };
}

function errorResult(base: { input: string; inputKind: InputKind }, e: unknown): AnalysisResult {
  const error = errorOf(e);
  const kind = failureKind(error.code);
  const message =
    kind === 'config'
      ? `API 키나 VWORLD_DOMAIN 설정 문제다(${error.code}). 다시 물어도 같으니 .env(또는 MCP 서버 환경변수)를 확인해야 한다.`
      : kind === 'quota'
        ? `API 일일 호출 한도를 넘었다(${error.code}). 내일 다시 하거나 운영계정 한도를 늘려야 한다.`
        : `공공 API가 응답하지 않았다(${error.code}). 잠시(수십 초) 뒤 같은 질문을 다시 하면 된다.`;
  const retryable = kind === 'retry' || kind === 'unknown' || kind === 'skipped';
  return { status: 'error', ...base, error, retryable, message };
}

/**
 * 지번주소 → PNU를 법정동코드 표로 직접 만든다(외부 호출 없음).
 * juso 검색은 도로명주소 건물 단위라서, 건물이 대표지번으로 걸려 있지 않은 필지(도로·빈 땅·부속지번 전용 필지,
 * 없어진 지번)는 지번으로 검색해도 안 나온다. 그래도 PNU는 이름만으로 만들 수 있다.
 */
function parcelsFromBjdongTable(head: string, num: { mountain: boolean; main: number; sub: number }): ParcelChoice[] {
  if (num.main < 1 || num.main > 9999 || num.sub > 9999) return [];
  const lot = { mountain: num.mountain, bonbun: num.main, bubun: num.sub };
  // "서울특별시 중랑구 상봉동"처럼 앞부분을 다 줬으면 그대로, 일부만 줬으면 뒤에서부터 맞춘다
  return findBjdongByName(head).map((e) => ({
    pnu: formatPnu({ bjdongCode: e.code, ...lot }),
    jibunAddress: `${e.name} ${formatJibun(lot)}`,
  }));
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

    const num = parseAddressNumber(s);

    if (inputKind === 'jibun' && num) {
      // 1) juso: 이 지번을 대표지번으로 하는 건물이 있으면 그 PNU (juso는 관련지번으로도 찾아 주므로 지번이 같은 것만)
      let candidates: AddressCandidate[] = [];
      let jusoError: unknown = null;
      try {
        candidates = await search(s, opts);
      } catch (e) {
        jusoError = e;
      }
      const hits = candidates.filter(
        (c) => c.parcel.mountain === num.mountain && c.parcel.bonbun === num.main && c.parcel.bubun === num.sub,
      );
      const pnus = [...new Set(hits.map((c) => c.pnu))];
      if (pnus.length === 1 && pnus[0]) return { status: 'ok', ...base, analysis: await analyzeParcel(pnus[0], opts) };

      // 2) 법정동코드 표로 직접 (juso에 없거나 juso가 실패해도)
      const choices = pnus.length > 1 ? [] : parcelsFromBjdongTable(num.head, num);
      if (pnus.length > 1 || choices.length > 1) {
        return {
          status: 'ambiguous',
          ...base,
          message: '같은 이름의 법정동이 여럿이다. 시·군·구까지 붙여 다시 묻거나 아래 PNU 중 하나로 물어보라',
          candidates: hits,
          parcels: pnus.length > 1 ? hits.map((c) => ({ pnu: c.pnu, jibunAddress: c.jibunAddress })) : choices,
        };
      }
      const only = choices[0];
      if (only) {
        const analysis = await analyzeParcel(only.pnu, opts);
        const lotText = ` ${formatJibun({ mountain: num.mountain, bonbun: num.main, bubun: num.sub })}`;
        const related = candidates.filter((c) => c.relatedJibunRaw?.includes(lotText));
        analysis.notes.unshift(
          `주소 검색(juso)에 이 지번을 대표지번으로 하는 도로명주소 건물이 없어, 법정동코드 표(${loadBjdongTable().source})로 PNU를 만들었다.`,
          ...(related.length
            ? [
                `이 지번을 관련지번으로 가진 건물: ${related.map((c) => `${c.roadAddress}(대표지번 ${c.pnu})`).join(', ')}.`,
              ]
            : []),
        );
        return { status: 'ok', ...base, analysis };
      }
      if (jusoError) return errorResult(base, jusoError);
      return {
        status: 'not_found',
        ...base,
        message: `"${num.head}"에 해당하는 법정동을 찾지 못했다. 시·도부터 전체 지번주소로 묻거나 PNU(19자리)로 물어보라`,
      };
    }

    const candidates = await search(s, opts);
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
    return {
      status: 'ambiguous',
      ...base,
      message: '후보가 여럿이다. 하나를 골라 다시 물어보라',
      candidates: pick,
      parcels: [],
    };
  } catch (e) {
    return errorResult(base, e);
  }
}
