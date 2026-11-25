/**
 * 도로명주소 검색 API(행정안전부, business.juso.go.kr) 연동.
 *
 * 요청: POST https://business.juso.go.kr/addrlink/addrLinkApi.do (form)
 *   confmKey, currentPage, countPerPage, keyword, resultType=json, addInfoYn=Y
 *
 * 실제 응답으로 확인한 것 (fixtures/juso, 2026-11-25):
 * - 숫자 필드(lnbrMnnm, buldMnnm 등)도 모두 문자열로 온다.
 * - admCd는 현행 법정동코드 10자리, mtYn은 0(대지)/1(산).
 * - 건물관리번호(bdMgtSn) 앞 19자리는 PNU로 쓸 수 없다. 발급 당시 값을 담고 있어서
 *   법정동코드가 옛 코드이거나(청원군 4371… vs 현행 청주시 4311…), 부번이 현재 지번과 다르다
 *   (YTN서울타워: 지번 산1-3, 건물관리번호는 …0001 0011…). 11번째 자리도 0·1·2가 모두 나온다.
 *   그래서 PNU는 admCd + mtYn + lnbrMnnm + lnbrSlno로 만든다.
 */
import { formatJibun, formatPnu, type PnuParts } from './pnu.js';

export const JUSO_SEARCH_URL = 'https://business.juso.go.kr/addrlink/addrLinkApi.do';

/** 입력 문자열이 무엇을 가리키는지 */
export type InputKind = 'pnu' | 'buildingMgmtNo' | 'road' | 'jibun' | 'unknown';

/**
 * 입력 종류를 판별한다. 외부 호출 없음.
 * - 숫자 19자리 → PNU, 25자리 → 건물관리번호
 * - 마지막 번지 앞 낱말이 `로`·`길`로 끝나면 도로명, `동`·`리`·`가`로 끝나면 지번
 * - 그 밖(건물명 등)은 unknown
 */
export function classifyInput(input: string): InputKind {
  const s = input.trim().replace(/\s+/g, ' ');
  if (/^\d{19}$/.test(s)) return 'pnu';
  if (/^\d{25}$/.test(s)) return 'buildingMgmtNo';

  // "…동 산 12-3", "…동 산12-3", "…로 110", "…길 20-2", "…로110"
  const m = s.match(/^(.*?)\s*(산\s*)?(\d+(?:-\d+)?)(?:\s.*)?$/u);
  if (!m) return 'unknown';
  const head = (m[1] ?? '').trim();
  const mountain = Boolean(m[2]);
  const last = head.split(' ').at(-1) ?? '';
  if (!last) return 'unknown';
  if (mountain) return 'jibun';
  // "태평로1가"처럼 로가 들어간 법정동 이름이 있으니 끝 글자로만 본다
  if (/[로길]$/u.test(last)) return 'road';
  if (/[동리가]$/u.test(last)) return 'jibun';
  return 'unknown';
}

/** 검색 API 응답의 juso 항목 (원문 필드명) */
export interface JusoRaw {
  roadAddr: string;
  roadAddrPart1: string;
  roadAddrPart2?: string;
  jibunAddr: string;
  engAddr?: string;
  zipNo: string;
  admCd: string;
  rnMgtSn: string;
  bdMgtSn: string;
  detBdNmList?: string;
  bdNm?: string;
  bdKdcd: string;
  siNm: string;
  sggNm: string;
  emdNm: string;
  liNm?: string;
  rn: string;
  udrtYn: string;
  buldMnnm: string;
  buldSlno: string;
  mtYn: string;
  lnbrMnnm: string;
  lnbrSlno: string;
  hstryYn?: string;
  relJibun?: string;
  hemdNm?: string;
  emdNo?: string;
}

export interface JusoResponse {
  results: {
    common: {
      totalCount: string;
      currentPage: string;
      countPerPage: string;
      errorCode: string;
      errorMessage: string;
    };
    juso: JusoRaw[] | null;
  };
}

/** 정규화한 주소 후보 하나 (= 도로명주소가 붙은 건물 하나) */
export interface AddressCandidate {
  /** 대표 지번의 PNU (admCd + mtYn + 지번본번·부번) */
  pnu: string;
  parcel: PnuParts;
  /** 지번주소 (건물명 없이). 예) "서울특별시 중구 태평로1가 31" */
  jibunAddress: string;
  /** 도로명주소 (참고항목 제외). 예) "서울특별시 중구 세종대로 110" */
  roadAddress: string;
  /** 도로명주소 참고항목. 예) "(태평로1가)" */
  roadAddressNote: string | null;
  buildingName: string | null;
  /** 상세건물명 (동 이름 등, API가 쉼표로 묶어 준 것을 나눔) */
  detailBuildingNames: string[];
  /** 공동주택 여부 (bdKdcd 1) */
  apartment: boolean;
  /** 건물관리번호 25자리 원값. 앞 19자리를 PNU로 쓰지 말 것 */
  buildingMgmtNo: string;
  /** 도로명코드 12자리 */
  roadNameCode: string;
  roadName: string;
  underground: boolean;
  buildingMainNo: number;
  buildingSubNo: number;
  zipCode: string;
  /** 관련지번 원문 (addInfoYn=Y일 때). 여러 개일 때의 구분 형식은 아직 확인 안 함 */
  relatedJibunRaw: string | null;
  /** 변동된(옛) 주소정보에서 검색된 결과인지 (hstryYn 1) */
  fromHistory: boolean;
}

export interface AddressSearchResult {
  keyword: string;
  inputKind: InputKind;
  totalCount: number;
  page: number;
  countPerPage: number;
  candidates: AddressCandidate[];
}

export class JusoError extends Error {
  override name = 'JusoError';
  constructor(
    message: string,
    /** API errorCode (예: E0001) 또는 HTTP·TIMEOUT·PARSE */
    readonly code: string,
  ) {
    super(message);
  }
}

function lotNumber(name: string, v: string): number {
  if (!/^\d{1,4}$/.test(v)) throw new JusoError(`${name} 값이 예상과 다릅니다: "${v}"`, 'PARSE');
  return Number(v);
}

function nonEmpty(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

export function normalizeJuso(j: JusoRaw): AddressCandidate {
  if (!/^\d{10}$/.test(j.admCd)) throw new JusoError(`admCd가 10자리 숫자가 아닙니다: "${j.admCd}"`, 'PARSE');
  if (j.mtYn !== '0' && j.mtYn !== '1') throw new JusoError(`mtYn 값이 0/1이 아닙니다: "${j.mtYn}"`, 'PARSE');
  const parcel: PnuParts = {
    bjdongCode: j.admCd,
    mountain: j.mtYn === '1',
    bonbun: lotNumber('lnbrMnnm', j.lnbrMnnm),
    bubun: lotNumber('lnbrSlno', j.lnbrSlno),
  };
  const area = [j.siNm, j.sggNm, j.emdNm, j.liNm].map((x) => x?.trim()).filter(Boolean);
  return {
    pnu: formatPnu(parcel),
    parcel,
    jibunAddress: `${area.join(' ')} ${formatJibun(parcel)}`,
    roadAddress: j.roadAddrPart1.trim(),
    roadAddressNote: nonEmpty(j.roadAddrPart2),
    buildingName: nonEmpty(j.bdNm),
    detailBuildingNames: (j.detBdNmList ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    apartment: j.bdKdcd === '1',
    buildingMgmtNo: j.bdMgtSn,
    roadNameCode: j.rnMgtSn,
    roadName: j.rn,
    underground: j.udrtYn === '1',
    buildingMainNo: Number(j.buldMnnm),
    buildingSubNo: Number(j.buldSlno),
    zipCode: j.zipNo,
    relatedJibunRaw: nonEmpty(j.relJibun),
    fromHistory: j.hstryYn === '1',
  };
}

/** API 응답 JSON을 정규화한다. errorCode가 0이 아니면 JusoError. */
export function parseJusoResponse(keyword: string, body: JusoResponse): AddressSearchResult {
  const common = body?.results?.common;
  if (!common) throw new JusoError('응답에 results.common이 없습니다', 'PARSE');
  if (common.errorCode !== '0') throw new JusoError(common.errorMessage, common.errorCode);
  return {
    keyword,
    inputKind: classifyInput(keyword),
    totalCount: Number(common.totalCount),
    page: Number(common.currentPage),
    countPerPage: Number(common.countPerPage),
    candidates: (body.results.juso ?? []).map(normalizeJuso),
  };
}

/** API가 거부하는 특수문자(E0013: % = > < [ ])를 지운다. SQL 예약어는 API 판단에 맡긴다. */
export function sanitizeKeyword(keyword: string): string {
  return keyword
    .replace(/[%=<>[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SearchAddressOptions {
  /** 도로명주소 검색 API 승인키 (JUSO_KEY) */
  key: string;
  page?: number;
  /** 페이지당 결과 수 (기본 10) */
  countPerPage?: number;
  /** 기본 5000ms */
  timeoutMs?: number;
  /** 테스트용 */
  fetch?: typeof fetch;
}

/** 주소를 검색해 후보 목록을 돌려준다. */
export async function searchAddress(keyword: string, opts: SearchAddressOptions): Promise<AddressSearchResult> {
  if (!opts.key) throw new JusoError('JUSO_KEY가 없습니다', 'NO_KEY');
  const q = sanitizeKeyword(keyword);
  const body = new URLSearchParams({
    confmKey: opts.key,
    currentPage: String(opts.page ?? 1),
    countPerPage: String(opts.countPerPage ?? 10),
    keyword: q,
    resultType: 'json',
    addInfoYn: 'Y',
  });
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(JUSO_SEARCH_URL, { method: 'POST', body, signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    // 에러 메시지에 요청 본문(키)이 섞이지 않도록 원인 메시지는 붙이지 않는다
    throw new JusoError(
      timeout ? '주소 검색 API 응답 시간 초과' : '주소 검색 API 호출 실패',
      timeout ? 'TIMEOUT' : 'NETWORK',
    );
  }
  if (!res.ok) throw new JusoError(`주소 검색 API HTTP ${res.status}`, 'HTTP');
  let json: JusoResponse;
  try {
    json = (await res.json()) as JusoResponse;
  } catch {
    throw new JusoError('주소 검색 API 응답이 JSON이 아닙니다', 'PARSE');
  }
  return parseJusoResponse(q, json);
}
