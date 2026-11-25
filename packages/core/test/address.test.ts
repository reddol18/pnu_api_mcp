import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  type AddressCandidate,
  classifyInput,
  JUSO_SEARCH_URL,
  JusoError,
  type JusoResponse,
  parseJusoResponse,
  parsePnu,
  sanitizeKeyword,
  searchAddress,
  splitBuildingMgmtNo,
} from '../src/index.js';

interface Fixture {
  request: { keyword: string };
  response: JusoResponse;
}

function load(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`../fixtures/juso/${name}.json`, import.meta.url), 'utf8')) as Fixture;
}

function parse(name: string) {
  const f = load(name);
  return parseJusoResponse(f.request.keyword, f.response);
}

function byName(cands: AddressCandidate[], name: string): AddressCandidate {
  const c = cands.find((x) => x.buildingName === name);
  if (!c) throw new Error(`후보 없음: ${name}`);
  return c;
}

describe('classifyInput', () => {
  it.each([
    ['1126010200101260039', 'pnu'],
    ['1114010300100310000019224', 'buildingMgmtNo'],
    ['세종대로 110', 'road'],
    ['서울특별시 중구 세종대로110', 'road'],
    ['동일로110길 10', 'road'],
    ['세종대로14길 20-2', 'road'],
    ['상봉동 126-39', 'jibun'],
    ['중랑구 상봉동 126', 'jibun'],
    ['태평로1가 31', 'jibun'], // 법정동 이름에 '로'가 들어 있다
    ['용산동2가 산1-3', 'jibun'],
    ['용산동2가 산 1-3', 'jibun'],
    ['낭성면 이목리 120-3', 'jibun'],
    ['낭성초등학교', 'unknown'],
    ['126-39', 'unknown'],
  ])('%s → %s', (input, kind) => {
    expect(classifyInput(input)).toBe(kind);
  });
});

describe('parseJusoResponse (실제 응답 fixture)', () => {
  it('도로명: 서울특별시청', () => {
    const r = parse('road-seoul-cityhall');
    expect(r.inputKind).toBe('road');
    expect(r.totalCount).toBe(2);
    const c = byName(r.candidates, '서울특별시청');
    expect(c).toMatchObject({
      pnu: '1114010300100310000',
      jibunAddress: '서울특별시 중구 태평로1가 31',
      roadAddress: '서울특별시 중구 세종대로 110',
      roadAddressNote: '(태평로1가)',
      detailBuildingNames: ['본관동', '신관'],
      apartment: false,
      underground: false,
      buildingMainNo: 110,
      buildingSubNo: 0,
      relatedJibunRaw: null,
      fromHistory: false,
    });
  });

  it('지번: 상봉동 126 → 같은 본번의 여러 필지·건물', () => {
    const r = parse('jibun-sangbong-126-multi');
    expect(r.inputKind).toBe('jibun');
    expect(r.totalCount).toBe(24);
    expect(r.candidates).toHaveLength(10);
    for (const c of r.candidates) expect(parsePnu(c.pnu).bonbun).toBe(126);
    const apt = byName(r.candidates, '정원팰리스');
    expect(apt.apartment).toBe(true);
    expect(apt.detailBuildingNames).toEqual(['101동', '103동', '102동']);
  });

  it('블로그 예시 상봉동 126-39는 도로명주소가 붙은 건물이 없다', () => {
    const r = parse('jibun-sangbong-126-39-none');
    expect(r.totalCount).toBe(0);
    expect(r.candidates).toEqual([]);
  });

  it('산 번지: mtYn 1 → PNU 필지구분 2', () => {
    const c = byName(parse('road-namsan-mountain').candidates, 'YTN서울타워');
    expect(c.pnu).toBe('1117010200200010003');
    expect(c.jibunAddress).toBe('서울특별시 용산구 용산동2가 산 1-3');
  });

  it('산1-3 한 필지에 도로명주소 건물이 둘 (필지 → 건물 N)', () => {
    const r = parse('jibun-mountain-two-buildings');
    expect(r.candidates.map((c) => c.pnu)).toEqual(['1117010200200010003', '1117010200200010003']);
    expect(new Set(r.candidates.map((c) => c.roadAddress)).size).toBe(2);
  });

  it('리 단위 주소와 관련지번', () => {
    const c = byName(parse('ri-nangseong-office').candidates, '낭성면 행정복지센터');
    expect(c.pnu).toBe('4311131025101200003');
    expect(c.jibunAddress).toBe('충청북도 청주시 상당구 낭성면 이목리 120-3');
    expect(c.relatedJibunRaw).toBe('충청북도 청주시 상당구 낭성면 이목리 120-4');
  });

  it.each(['error-E0008', 'error-E0013'])('오류 응답은 JusoError(code): %s', (name) => {
    const f = load(name);
    const code = f.response.results.common.errorCode;
    expect(() => parseJusoResponse(f.request.keyword, f.response)).toThrow(
      expect.objectContaining({ name: 'JusoError', code }),
    );
  });
});

describe('건물관리번호 앞 19자리 ≠ PNU (실제 응답으로 확인)', () => {
  it('YTN서울타워: 부번이 현재 지번과 다르다', () => {
    const c = byName(parse('road-namsan-mountain').candidates, 'YTN서울타워');
    const b = splitBuildingMgmtNo(c.buildingMgmtNo);
    expect(b.mountainFlagRaw).toBe('2');
    expect(b.bubun).toBe(11);
    expect(c.parcel.bubun).toBe(3);
  });

  it('낭성면 행정복지센터: 법정동코드가 옛 청원군 코드, 산 여부 자리는 0', () => {
    const c = byName(parse('ri-nangseong-office').candidates, '낭성면 행정복지센터');
    const b = splitBuildingMgmtNo(c.buildingMgmtNo);
    expect(b.bjdongCode).toBe('4371031026');
    expect(c.parcel.bjdongCode).toBe('4311131025');
    expect(b.mountainFlagRaw).toBe('0');
  });

  it('서울 대지: 산 여부 자리 1 (mtYn은 0)', () => {
    const c = byName(parse('road-seoul-cityhall').candidates, '서울특별시청');
    expect(splitBuildingMgmtNo(c.buildingMgmtNo).mountainFlagRaw).toBe('1');
  });
});

describe('sanitizeKeyword', () => {
  it('E0013 특수문자를 지운다', () => {
    expect(sanitizeKeyword(' 세종대로 [110] %=<> ')).toBe('세종대로 110');
  });
});

describe('searchAddress', () => {
  const okFetch = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('POST form으로 호출하고 정규화한다', async () => {
    const f = load('road-seoul-cityhall');
    const fetchMock = okFetch(f.response);
    const r = await searchAddress('세종대로 110', { key: 'TEST', fetch: fetchMock });
    expect(r.candidates).toHaveLength(2);
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(JUSO_SEARCH_URL);
    expect(init.method).toBe('POST');
    const sent = new URLSearchParams(init.body as URLSearchParams);
    expect(Object.fromEntries(sent)).toMatchObject({
      confmKey: 'TEST',
      keyword: '세종대로 110',
      resultType: 'json',
      currentPage: '1',
      countPerPage: '10',
    });
  });

  it('키가 없으면 호출하지 않는다', async () => {
    const fetchMock = okFetch({});
    await expect(searchAddress('세종대로 110', { key: '', fetch: fetchMock })).rejects.toMatchObject({
      code: 'NO_KEY',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('HTTP 오류', async () => {
    await expect(searchAddress('세종대로 110', { key: 'K', fetch: okFetch({}, 500) })).rejects.toMatchObject({
      code: 'HTTP',
    });
  });

  it('네트워크 오류 메시지에 키가 섞이지 않는다', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('failed: confmKey=SECRET');
    }) as unknown as typeof fetch;
    const err = await searchAddress('세종대로 110', { key: 'SECRET', fetch: fetchMock }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JusoError);
    expect(String((err as JusoError).message)).not.toContain('SECRET');
  });
});
