/**
 * 국토교통부 건축HUB 건축물대장정보 서비스 (data.go.kr 15134735).
 *
 * GET https://apis.data.go.kr/1613000/BldRgstHubService/{operation}
 *   serviceKey, sigunguCd, bjdongCd, platGbCd(0 대지·1 산·2 블록), bun, ji, _type=json, numOfRows, pageNo
 *   - getBrTitleInfo       표제부 (동 하나)
 *   - getBrRecapTitleInfo  총괄표제부 (한 대지에 주건축물이 여럿일 때)
 *   - getBrAtchJibunInfo   부속지번
 *
 * 실제 응답으로 확인한 것 (fixtures/ledger, 2026-11-25):
 * - 정상: response.header.resultCode "00". 0건이면 items.item = [].
 * - 숫자·문자 섞임: mgmBldrgstPk·totArea·bylotCnt 등은 JSON 숫자, 빈 값은 " "(공백 한 칸).
 *   totalCount는 숫자로도 문자열로도 온다.
 * - 게이트웨이 오류는 다른 모양: OpenAPI_ServiceResponse.cmmMsgHeader.returnReasonCode
 *   (05 SERVICETIMEOUT_ERROR는 HTTP 503으로 간헐적으로 옴 → 재시도, 30 등록되지 않은 키는 HTTP 403).
 * - 요청 변수에 부속지번 필드가 없다 → "이 필지를 부속지번으로 쓰는 건물"을 거꾸로 찾을 수 없다.
 */
import { formatPnu, type LedgerKey, type PnuParts, pnuToLedgerKey } from './pnu.js';
import { defaultSleep, isTimeoutError, type SourceResult, settle } from './source.js';

export const BLD_HUB_BASE_URL = 'https://apis.data.go.kr/1613000/BldRgstHubService';

export type LedgerOperation = 'getBrTitleInfo' | 'getBrRecapTitleInfo' | 'getBrAtchJibunInfo';

export type LedgerItemRaw = Record<string, string | number | null | undefined>;

export class LedgerError extends Error {
  override name = 'LedgerError';
  constructor(
    message: string,
    /** API resultCode, 게이트웨이 returnReasonCode, 또는 HTTP·TIMEOUT·NETWORK·PARSE·NO_KEY */
    readonly code: string,
  ) {
    super(message);
  }
}

/** 대장에 적힌 지번. 블록(platGbCd 2)처럼 PNU로 바꿀 수 없으면 pnu는 null */
export interface LedgerParcel {
  pnu: string | null;
  /** 대장 원값 */
  sigunguCd: string;
  bjdongCd: string;
  platGbCd: string;
  bun: string;
  ji: string;
}

export interface LedgerRegister {
  /** 대장 PK (관리건축물대장PK). 숫자로 오지만 문자열로 다룬다 */
  pk: string;
  /** 대장구분: 1 일반, 2 집합 */
  registerType: string;
  registerTypeName: string | null;
  /** 대장종류: 1 총괄표제부, 2 일반건축물, 3 표제부 (실제 응답에서 본 값) */
  registerKind: string;
  registerKindName: string | null;
  parcel: LedgerParcel;
  /** 대지위치 (예: "서울특별시 중구 태평로1가 31번지") */
  parcelAddress: string | null;
  /** 도로명대지위치 */
  roadAddress: string | null;
  buildingName: string | null;
  /**
   * 새주소 도로코드·본번·부번 (naRoadCd·naMainBun·naSubBun). 도로명주소가 없으면 null.
   * juso 검색 결과의 rnMgtSn·buldMnnm·buldSlno와 같은 값이라 대장 ↔ 건물관리번호를 잇는 데 쓴다
   * (서울시청 111402005001·110, 서울타워 111704103024·105로 확인).
   */
  roadKey: { roadCode: string; mainNo: number; subNo: number } | null;
  /** 데이터 생성일자 YYYYMMDD */
  createdDate: string | null;
}

/** 표제부 (동 하나) */
export interface TitleRecord extends LedgerRegister {
  dongName: string | null;
  /** 주건축물/부속건축물 (mainAtchGbCd 0/1) */
  mainOrAttached: 'main' | 'attached' | null;
  mainPurpose: string | null;
  totalArea: number | null;
  /** 외필지수 — 대표지번 밖에 걸친 필지 수 */
  otherParcelCount: number | null;
  useApprovalDate: string | null;
}

/** 총괄표제부 */
export interface RecapTitleRecord extends LedgerRegister {
  mainPurpose: string | null;
  totalArea: number | null;
  mainBuildingCount: number | null;
  attachedBuildingCount: number | null;
  otherParcelCount: number | null;
}

/** 부속지번 한 줄: pk 대장의 부속지번이 attachedParcel */
export interface AttachedJibunRecord extends LedgerRegister {
  attachedParcel: LedgerParcel;
  /** 부속기타지번명 */
  attachedEtcJibunName: string | null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t : null;
}

function num(v: unknown): number | null {
  const t = str(v);
  if (t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 대장 지번 원값 → PNU. 대지 0 → 1, 산 1 → 2. 그 밖(블록 2 등)이나 형식이 틀리면 null */
export function ledgerParcel(
  sigunguCd: unknown,
  bjdongCd: unknown,
  platGbCd: unknown,
  bun: unknown,
  ji: unknown,
): LedgerParcel {
  const p: LedgerParcel = {
    pnu: null,
    sigunguCd: str(sigunguCd) ?? '',
    bjdongCd: str(bjdongCd) ?? '',
    platGbCd: str(platGbCd) ?? '',
    bun: str(bun) ?? '',
    ji: str(ji) ?? '',
  };
  if (
    /^\d{5}$/.test(p.sigunguCd) &&
    /^\d{5}$/.test(p.bjdongCd) &&
    (p.platGbCd === '0' || p.platGbCd === '1') &&
    /^\d{1,4}$/.test(p.bun) &&
    /^\d{1,4}$/.test(p.ji) &&
    Number(p.bun) > 0
  ) {
    const parts: PnuParts = {
      bjdongCode: p.sigunguCd + p.bjdongCd,
      mountain: p.platGbCd === '1',
      bonbun: Number(p.bun),
      bubun: Number(p.ji),
    };
    p.pnu = formatPnu(parts);
  }
  return p;
}

function roadKeyOf(it: LedgerItemRaw): LedgerRegister['roadKey'] {
  const roadCode = str(it.naRoadCd);
  const mainNo = num(it.naMainBun);
  if (!roadCode || !/^\d{12}$/.test(roadCode) || !mainNo) return null;
  return { roadCode, mainNo, subNo: num(it.naSubBun) ?? 0 };
}

function register(it: LedgerItemRaw): LedgerRegister {
  const pk = str(it.mgmBldrgstPk);
  if (!pk) throw new LedgerError('mgmBldrgstPk가 없습니다', 'PARSE');
  return {
    pk,
    registerType: str(it.regstrGbCd) ?? '',
    registerTypeName: str(it.regstrGbCdNm),
    registerKind: str(it.regstrKindCd) ?? '',
    registerKindName: str(it.regstrKindCdNm),
    parcel: ledgerParcel(it.sigunguCd, it.bjdongCd, it.platGbCd, it.bun, it.ji),
    parcelAddress: str(it.platPlc),
    roadAddress: str(it.newPlatPlc),
    buildingName: str(it.bldNm),
    roadKey: roadKeyOf(it),
    createdDate: str(it.crtnDay),
  };
}

export function normalizeTitle(it: LedgerItemRaw): TitleRecord {
  const ma = str(it.mainAtchGbCd);
  return {
    ...register(it),
    dongName: str(it.dongNm),
    mainOrAttached: ma === '0' ? 'main' : ma === '1' ? 'attached' : null,
    mainPurpose: str(it.mainPurpsCdNm),
    totalArea: num(it.totArea),
    otherParcelCount: num(it.bylotCnt),
    useApprovalDate: str(it.useAprDay),
  };
}

export function normalizeRecapTitle(it: LedgerItemRaw): RecapTitleRecord {
  return {
    ...register(it),
    mainPurpose: str(it.mainPurpsCdNm),
    totalArea: num(it.totArea),
    mainBuildingCount: num(it.mainBldCnt),
    attachedBuildingCount: num(it.atchBldCnt),
    otherParcelCount: num(it.bylotCnt),
  };
}

export function normalizeAttachedJibun(it: LedgerItemRaw): AttachedJibunRecord {
  return {
    ...register(it),
    attachedParcel: ledgerParcel(it.atchSigunguCd, it.atchBjdongCd, it.atchPlatGbCd, it.atchBun, it.atchJi),
    attachedEtcJibunName: str(it.atchEtcJibunNm),
  };
}

export interface LedgerPage {
  totalCount: number;
  pageNo: number;
  numOfRows: number;
  items: LedgerItemRaw[];
}

/** 큰 정수 PK가 JSON 숫자로 와서 정밀도를 잃지 않도록 문자열로 바꿔 파싱한다. */
export function parseLedgerJson(text: string): unknown {
  return JSON.parse(text.replace(/("mgmBldrgstPk"\s*:\s*)(-?\d+)/g, '$1"$2"'));
}

interface GatewayError {
  OpenAPI_ServiceResponse?: { cmmMsgHeader?: { errMsg?: string; returnAuthMsg?: string; returnReasonCode?: string } };
}

interface LedgerBody {
  response?: {
    header?: { resultCode?: string; resultMsg?: string };
    body?: {
      items?: { item?: LedgerItemRaw | LedgerItemRaw[] } | string;
      totalCount?: string | number;
      pageNo?: string | number;
      numOfRows?: string | number;
    };
  };
}

/** 응답 JSON 한 페이지를 해석한다. 오류면 LedgerError. */
export function parseLedgerPage(json: unknown): LedgerPage {
  const gw = (json as GatewayError)?.OpenAPI_ServiceResponse?.cmmMsgHeader;
  if (gw) {
    throw new LedgerError(
      `건축물대장 API 오류: ${gw.returnAuthMsg ?? gw.errMsg ?? ''}`.trim(),
      gw.returnReasonCode ?? 'GATEWAY',
    );
  }
  const r = (json as LedgerBody)?.response;
  if (!r?.header) throw new LedgerError('응답에 response.header가 없습니다', 'PARSE');
  if (r.header.resultCode !== '00') {
    throw new LedgerError(`건축물대장 API 오류: ${r.header.resultMsg ?? ''}`.trim(), r.header.resultCode ?? 'UNKNOWN');
  }
  const b = r.body ?? {};
  const raw = typeof b.items === 'object' ? b.items?.item : undefined;
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return {
    totalCount: num(b.totalCount) ?? items.length,
    pageNo: num(b.pageNo) ?? 1,
    numOfRows: num(b.numOfRows) ?? items.length,
    items,
  };
}

export interface LedgerOptions {
  /** 공공데이터포털 인증키 (DATA_GO_KR_KEY). 인코딩 키(%포함)·디코딩 키 모두 받는다 */
  key: string;
  /**
   * 요청 하나의 제한 시간. 기본 2000ms.
   * 실험(설계 §4-2): 성공은 60~131ms, 실패는 언제나 약 5.1초 뒤 503/05(게이트웨이 백엔드 제한).
   * 2초 안에 안 오면 실패가 거의 확실하니 5초를 다 기다리지 않는다.
   */
  timeoutMs?: number;
  /** 일시 오류(HTTP 503 / 사유코드 05 / 시간 초과) 재시도 횟수. 기본 2 */
  retries?: number;
  /** 한 페이지 크기. 기본 100 */
  numOfRows?: number;
  /** 최대 페이지 수. 기본 10 */
  maxPages?: number;
  /** 테스트용 */
  fetch?: typeof fetch;
  /** 테스트용 (재시도 대기) */
  sleep?: (ms: number) => Promise<void>;
}

function decodeKey(key: string): string {
  if (!key.includes('%')) return key;
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

// 05·503은 간헐적 게이트웨이 오류. 보통 100ms 안팎인 응답이 가끔 멈추는 것도 실제로 봤다(TIMEOUT).
const RETRYABLE = new Set(['05', 'HTTP_503', 'TIMEOUT']);
export const LEDGER_TIMEOUT_MS = 2000;

async function requestPage(
  op: LedgerOperation,
  key: LedgerKey,
  pageNo: number,
  opts: LedgerOptions,
): Promise<LedgerPage> {
  const params = new URLSearchParams({
    serviceKey: decodeKey(opts.key),
    sigunguCd: key.sigunguCd,
    bjdongCd: key.bjdongCd,
    platGbCd: key.platGbCd,
    bun: key.bun,
    ji: key.ji,
    _type: 'json',
    numOfRows: String(opts.numOfRows ?? 100),
    pageNo: String(pageNo),
  });
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${BLD_HUB_BASE_URL}/${op}?${params}`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? LEDGER_TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = isTimeoutError(e);
    // URL에 키가 들어 있으므로 원인 메시지는 붙이지 않는다
    throw new LedgerError(
      timeout ? '건축물대장 API 응답 시간 초과' : '건축물대장 API 호출 실패',
      timeout ? 'TIMEOUT' : 'NETWORK',
    );
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = parseLedgerJson(text);
  } catch {
    throw new LedgerError(
      `건축물대장 API 응답이 JSON이 아닙니다 (HTTP ${res.status})`,
      res.ok ? 'PARSE' : `HTTP_${res.status}`,
    );
  }
  return parseLedgerPage(json);
}

async function requestPageWithRetry(op: LedgerOperation, key: LedgerKey, pageNo: number, opts: LedgerOptions) {
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestPage(op, key, pageNo, opts);
    } catch (e) {
      if (!(e instanceof LedgerError) || !RETRYABLE.has(e.code) || attempt >= retries) throw e;
      // 장애는 시간대로 몰려서 같은 순간에 다시 보내면 잘 안 된다 → 0.5초, 1초로 조금씩 벌린다
      await sleep(500 * 2 ** attempt);
    }
  }
}

/** 한 필지(PNU)로 대장 오퍼레이션을 호출해 모든 페이지의 원 항목을 모은다. */
export async function fetchLedgerItems(
  op: LedgerOperation,
  pnu: string,
  opts: LedgerOptions,
): Promise<LedgerItemRaw[]> {
  if (!opts.key) throw new LedgerError('DATA_GO_KR_KEY가 없습니다', 'NO_KEY');
  const key = pnuToLedgerKey(pnu);
  const items: LedgerItemRaw[] = [];
  const maxPages = opts.maxPages ?? 10;
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const page = await requestPageWithRetry(op, key, pageNo, opts);
    items.push(...page.items);
    if (page.items.length === 0 || items.length >= page.totalCount) break;
  }
  return items;
}

export async function getTitles(pnu: string, opts: LedgerOptions): Promise<TitleRecord[]> {
  return (await fetchLedgerItems('getBrTitleInfo', pnu, opts)).map(normalizeTitle);
}

export async function getRecapTitles(pnu: string, opts: LedgerOptions): Promise<RecapTitleRecord[]> {
  return (await fetchLedgerItems('getBrRecapTitleInfo', pnu, opts)).map(normalizeRecapTitle);
}

export async function getAttachedJibuns(pnu: string, opts: LedgerOptions): Promise<AttachedJibunRecord[]> {
  return (await fetchLedgerItems('getBrAtchJibunInfo', pnu, opts)).map(normalizeAttachedJibun);
}

export interface ParcelLedger {
  pnu: string;
  titles: SourceResult<TitleRecord>;
  recapTitles: SourceResult<RecapTitleRecord>;
  attachedJibuns: SourceResult<AttachedJibunRecord>;
}

/** 필지 하나의 표제부·총괄표제부·부속지번을 함께 조회한다. */
export async function lookupParcelLedger(pnu: string, opts: LedgerOptions): Promise<ParcelLedger> {
  pnuToLedgerKey(pnu); // 형식 검증 (잘못된 PNU는 여기서 PnuError)
  const [titles, recapTitles, attachedJibuns] = await Promise.all([
    settle(getTitles(pnu, opts)),
    settle(getRecapTitles(pnu, opts)),
    settle(getAttachedJibuns(pnu, opts)),
  ]);
  return { pnu, titles, recapTitles, attachedJibuns };
}
