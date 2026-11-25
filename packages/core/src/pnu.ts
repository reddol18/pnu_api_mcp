/**
 * PNU(필지고유번호) 19자리:
 *   법정동코드 10 (시도2 + 시군구3 + 읍면동3 + 리2)
 *   + 필지구분 1 (1 = 일반 토지, 2 = 산)
 *   + 본번 4 + 부번 4
 *
 * 예) 서울특별시 중랑구 상봉동 126-39 → 1126010200 1 0126 0039
 */

export interface PnuParts {
  /** 법정동코드 10자리 */
  bjdongCode: string;
  /** 산 번지 여부 (PNU 필지구분 2) */
  mountain: boolean;
  /** 본번 0~9999 */
  bonbun: number;
  /** 부번 0~9999 (없으면 0) */
  bubun: number;
}

export class PnuError extends Error {
  override name = 'PnuError';
}

const PNU_RE = /^\d{19}$/;
const BJDONG_RE = /^\d{10}$/;

/** 19자리 PNU 문자열을 구성 요소로 나눈다. 형식이 틀리면 PnuError. */
export function parsePnu(pnu: string): PnuParts {
  const s = pnu.trim();
  if (!PNU_RE.test(s)) {
    throw new PnuError(`PNU는 숫자 19자리여야 합니다: "${pnu}"`);
  }
  const landType = s.charAt(10);
  if (landType !== '1' && landType !== '2') {
    throw new PnuError(`PNU 11번째 자리(필지구분)는 1(일반) 또는 2(산)여야 합니다: "${landType}"`);
  }
  return {
    bjdongCode: s.slice(0, 10),
    mountain: landType === '2',
    bonbun: Number(s.slice(11, 15)),
    bubun: Number(s.slice(15, 19)),
  };
}

function checkLot(name: string, n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > 9999) {
    throw new PnuError(`${name}은 0~9999 정수여야 합니다: ${n}`);
  }
}

/** 구성 요소로 19자리 PNU를 만든다. */
export function formatPnu(parts: PnuParts): string {
  if (!BJDONG_RE.test(parts.bjdongCode)) {
    throw new PnuError(`법정동코드는 숫자 10자리여야 합니다: "${parts.bjdongCode}"`);
  }
  checkLot('본번', parts.bonbun);
  checkLot('부번', parts.bubun);
  if (parts.bonbun === 0) {
    throw new PnuError('본번은 1 이상이어야 합니다');
  }
  return (
    parts.bjdongCode +
    (parts.mountain ? '2' : '1') +
    String(parts.bonbun).padStart(4, '0') +
    String(parts.bubun).padStart(4, '0')
  );
}

/** 지번 표기: "126-39", 부번 0이면 "126", 산이면 "산 12-3" */
export function formatJibun(parts: Pick<PnuParts, 'mountain' | 'bonbun' | 'bubun'>): string {
  const lot = parts.bubun ? `${parts.bonbun}-${parts.bubun}` : `${parts.bonbun}`;
  return parts.mountain ? `산 ${lot}` : lot;
}

/**
 * 건축물대장(국토교통부 건축HUB) 조회 키.
 * 주의: 필지구분 값이 PNU와 다르다 — 대지 `0`, 산 `1`.
 */
export interface LedgerKey {
  /** 시군구코드 5자리 (법정동코드 앞 5자리) */
  sigunguCd: string;
  /** 법정동코드 뒤 5자리 (읍면동3 + 리2) */
  bjdongCd: string;
  /** 대지구분: '0' 대지, '1' 산 */
  platGbCd: '0' | '1';
  /** 번 4자리 */
  bun: string;
  /** 지 4자리 */
  ji: string;
}

export function pnuToLedgerKey(pnu: string | PnuParts): LedgerKey {
  const p = typeof pnu === 'string' ? parsePnu(pnu) : pnu;
  formatPnu(p); // 값 검증
  return {
    sigunguCd: p.bjdongCode.slice(0, 5),
    bjdongCd: p.bjdongCode.slice(5, 10),
    platGbCd: p.mountain ? '1' : '0',
    bun: String(p.bonbun).padStart(4, '0'),
    ji: String(p.bubun).padStart(4, '0'),
  };
}

export function ledgerKeyToPnu(key: LedgerKey): string {
  if (key.platGbCd !== '0' && key.platGbCd !== '1') {
    throw new PnuError(`platGbCd는 0(대지) 또는 1(산)이어야 합니다: "${String(key.platGbCd)}"`);
  }
  if (!/^\d{4}$/.test(key.bun) || !/^\d{4}$/.test(key.ji)) {
    throw new PnuError(`bun·ji는 숫자 4자리여야 합니다: bun="${key.bun}" ji="${key.ji}"`);
  }
  return formatPnu({
    bjdongCode: key.sigunguCd + key.bjdongCd,
    mountain: key.platGbCd === '1',
    bonbun: Number(key.bun),
    bubun: Number(key.ji),
  });
}

/**
 * 도로명주소 건물관리번호 25자리를 자리별로 나눈다.
 * 구조: 법정동코드 10 + 산 여부 1 + 본번 4 + 부번 4 + 일련 6
 *
 * 주의(실제 응답으로 확인, fixtures/juso): 이 번호는 발급 당시 값을 담고 있어서
 * 앞 19자리를 PNU로 쓸 수 없다. 법정동코드가 옛 코드이거나 부번이 현재 지번과 다르고,
 * 산 여부 자리에는 0·1·2가 모두 나온다. 그래서 해석하지 않고 원래 값을 돌려준다.
 * PNU는 주소 검색 API의 admCd·mtYn·lnbrMnnm·lnbrSlno로 만든다(address.ts).
 */
export interface BuildingMgmtNoParts {
  bjdongCode: string;
  mountainFlagRaw: string;
  bonbun: number;
  bubun: number;
  serial: string;
}

export function splitBuildingMgmtNo(no: string): BuildingMgmtNoParts {
  const s = no.trim();
  if (!/^\d{25}$/.test(s)) {
    throw new PnuError(`건물관리번호는 숫자 25자리여야 합니다: "${no}"`);
  }
  return {
    bjdongCode: s.slice(0, 10),
    mountainFlagRaw: s.charAt(10),
    bonbun: Number(s.slice(11, 15)),
    bubun: Number(s.slice(15, 19)),
    serial: s.slice(19, 25),
  };
}
