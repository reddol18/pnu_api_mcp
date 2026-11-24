import { describe, expect, it } from 'vitest';
import {
  decodePnu,
  formatJibun,
  formatPnu,
  ledgerKeyToPnu,
  loadBjdongTable,
  PnuError,
  parsePnu,
  pnuToLedgerKey,
  splitBuildingMgmtNo,
} from '../src/index.js';

// 블로그 /make-pnu-code 예시: 서울특별시 중랑구 상봉동 126-39
const SANGBONG = '1126010200101260039';

describe('parsePnu / formatPnu', () => {
  it('블로그 예시를 자리별로 나눈다', () => {
    expect(parsePnu(SANGBONG)).toEqual({ bjdongCode: '1126010200', mountain: false, bonbun: 126, bubun: 39 });
  });

  it('산 번지(필지구분 2)', () => {
    expect(parsePnu('1126010200201260039').mountain).toBe(true);
  });

  it('앞뒤 공백은 허용한다', () => {
    expect(parsePnu(` ${SANGBONG}\n`).bonbun).toBe(126);
  });

  it.each([
    ['18자리', '112601020010126003'],
    ['20자리', '11260102001012600390'],
    ['문자 포함', '11260102001012600a9'],
    ['하이픈 포함', '1126010200-1-0126-0039'],
    ['필지구분 0', '1126010200001260039'],
    ['필지구분 3', '1126010200301260039'],
  ])('형식 오류: %s', (_, v) => {
    expect(() => parsePnu(v)).toThrow(PnuError);
  });

  it('조립 → 해독 왕복', () => {
    const parts = { bjdongCode: '1126010200', mountain: true, bonbun: 7, bubun: 0 };
    const s = formatPnu(parts);
    expect(s).toBe('1126010200200070000');
    expect(parsePnu(s)).toEqual(parts);
  });

  it.each([
    ['본번 0', { bjdongCode: '1126010200', mountain: false, bonbun: 0, bubun: 1 }],
    ['본번 10000', { bjdongCode: '1126010200', mountain: false, bonbun: 10000, bubun: 0 }],
    ['부번 음수', { bjdongCode: '1126010200', mountain: false, bonbun: 1, bubun: -1 }],
    ['부번 소수', { bjdongCode: '1126010200', mountain: false, bonbun: 1, bubun: 1.5 }],
    ['법정동 9자리', { bjdongCode: '112601020', mountain: false, bonbun: 1, bubun: 0 }],
  ])('조립 오류: %s', (_, p) => {
    expect(() => formatPnu(p)).toThrow(PnuError);
  });

  it('지번 표기', () => {
    expect(formatJibun({ mountain: false, bonbun: 126, bubun: 39 })).toBe('126-39');
    expect(formatJibun({ mountain: false, bonbun: 83, bubun: 0 })).toBe('83');
    expect(formatJibun({ mountain: true, bonbun: 12, bubun: 3 })).toBe('산 12-3');
  });
});

describe('건축물대장 키 (필지구분 값 체계가 다르다)', () => {
  it('일반 토지: PNU 1 → platGbCd 0', () => {
    expect(pnuToLedgerKey(SANGBONG)).toEqual({
      sigunguCd: '11260',
      bjdongCd: '10200',
      platGbCd: '0',
      bun: '0126',
      ji: '0039',
    });
  });

  it('산: PNU 2 → platGbCd 1', () => {
    expect(pnuToLedgerKey('1126010200201260039').platGbCd).toBe('1');
  });

  it.each([SANGBONG, '1126010200201260039', '4311131021100010000'])('왕복: %s', (pnu) => {
    expect(ledgerKeyToPnu(pnuToLedgerKey(pnu))).toBe(pnu);
  });

  it('잘못된 platGbCd는 거부한다 (PNU 체계 값 2를 넣는 실수)', () => {
    const key = { ...pnuToLedgerKey(SANGBONG), platGbCd: '2' as unknown as '0' };
    expect(() => ledgerKeyToPnu(key)).toThrow(PnuError);
  });
});

describe('건물관리번호 25자리', () => {
  it('자리별로 나누고 산 여부 자리는 해석하지 않는다', () => {
    expect(splitBuildingMgmtNo('1126010200101260039000001')).toEqual({
      bjdongCode: '1126010200',
      mountainFlagRaw: '1',
      bonbun: 126,
      bubun: 39,
      serial: '000001',
    });
  });

  it('앞 19자리가 PNU와 같은 구조다 (값 체계가 같다고 가정할 때)', () => {
    const no = `${SANGBONG}000001`;
    expect(no.slice(0, 19)).toBe(SANGBONG);
  });

  it('형식 오류', () => {
    expect(() => splitBuildingMgmtNo('112601020010126003900000')).toThrow(PnuError);
  });
});

describe('decodePnu (법정동코드 스냅숏)', () => {
  const table = loadBjdongTable();

  it('표가 읽힌다', () => {
    expect(table.size).toBeGreaterThan(40000);
    expect(table.source).toContain('2022-04');
  });

  it('블로그 예시: 상봉동 126-39', () => {
    const d = decodePnu(SANGBONG, table);
    expect(d).toMatchObject({
      known: true,
      abolished: false,
      sido: '서울특별시',
      sigungu: '중랑구',
      eupmyeondong: '상봉동',
      ri: null,
      jibunAddress: '서울특별시 중랑구 상봉동 126-39',
    });
  });

  it('리 단위와 일반구: 충청북도 청주시 상당구 낭성면 관정리', () => {
    const d = decodePnu('4311131021100010000', table);
    expect(d).toMatchObject({
      sido: '충청북도',
      sigungu: '청주시 상당구',
      eupmyeondong: '낭성면',
      ri: '관정리',
      jibunAddress: '충청북도 청주시 상당구 낭성면 관정리 1',
    });
  });

  it('세종특별자치시: 시도 코드 없이 시군구 코드가 시도 역할', () => {
    const d = decodePnu('3611010100100010000', table);
    expect(d).toMatchObject({ sido: '세종특별자치시', sigungu: null, eupmyeondong: '반곡동' });
  });

  it('산 번지 지번주소', () => {
    expect(decodePnu('1126010200200120003', table).jibunAddress).toBe('서울특별시 중랑구 상봉동 산 12-3');
  });

  it('폐지된 법정동은 abolished', () => {
    // 1123000200: 서울특별시 동대문구 상봉동 (폐지)
    const d = decodePnu('1123000200101260039', table);
    expect(d.known).toBe(true);
    expect(d.abolished).toBe(true);
  });

  it('표에 없는 법정동코드는 known=false, 주소 null', () => {
    const d = decodePnu('9999999999100010000', table);
    expect(d.known).toBe(false);
    expect(d.jibunAddress).toBeNull();
  });
});
