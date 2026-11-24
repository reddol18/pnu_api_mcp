import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatJibun, type PnuParts, parsePnu } from './pnu.js';

export interface BjdongEntry {
  code: string;
  /** 전체 이름 (예: "서울특별시 중랑구 상봉동") */
  name: string;
  active: boolean;
}

export interface BjdongTable {
  /** 데이터 출처·기준 설명 (파일 첫 줄 주석) */
  source: string;
  get(code: string): BjdongEntry | undefined;
  size: number;
}

const DEFAULT_PATH = fileURLToPath(new URL('../data/bjdong_codes.tsv', import.meta.url));

export function parseBjdongTsv(text: string): BjdongTable {
  const map = new Map<string, BjdongEntry>();
  let source = '';
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('#')) {
      if (!source) source = line.slice(1).trim();
      continue;
    }
    const [code, name, active] = line.split('\t');
    if (!code || !name || !/^\d{10}$/.test(code)) continue;
    map.set(code, { code, name, active: active === '1' });
  }
  return { source, get: (c) => map.get(c), size: map.size };
}

let cached: BjdongTable | undefined;

/** 패키지에 들어 있는 법정동코드 스냅숏을 읽는다(한 번만). */
export function loadBjdongTable(path: string = DEFAULT_PATH): BjdongTable {
  if (path === DEFAULT_PATH && cached) return cached;
  const t = parseBjdongTsv(readFileSync(path, 'utf8'));
  if (path === DEFAULT_PATH) cached = t;
  return t;
}

export interface DecodedPnu extends PnuParts {
  pnu: string;
  /** 법정동코드가 표에 있는지 */
  known: boolean;
  /** 표에 폐지로 표시된 법정동이면 true */
  abolished: boolean;
  sido: string | null;
  sigungu: string | null;
  eupmyeondong: string | null;
  ri: string | null;
  /** 지번주소 (예: "서울특별시 중랑구 상봉동 126-39"). 법정동을 모르면 null */
  jibunAddress: string | null;
  /** 법정동코드 데이터 기준 */
  dataSource: string;
}

function stripPrefix(name: string, prefix: string | undefined): string {
  if (prefix && name.startsWith(`${prefix} `)) return name.slice(prefix.length + 1);
  return name;
}

/** PNU를 풀어 행정구역 이름과 지번주소까지 붙인다. 외부 호출 없음. */
export function decodePnu(pnu: string, table: BjdongTable = loadBjdongTable()): DecodedPnu {
  const parts = parsePnu(pnu);
  const c = parts.bjdongCode;
  const sidoE = table.get(`${c.slice(0, 2)}00000000`);
  const sggE = c.slice(2, 5) === '000' ? undefined : table.get(`${c.slice(0, 5)}00000`);
  const emdE = c.slice(5, 8) === '000' ? undefined : table.get(`${c.slice(0, 8)}00`);
  const self = table.get(c);

  let sido = sidoE?.name ?? null;
  let sigungu = sggE ? stripPrefix(sggE.name, sidoE?.name) : null;
  // 세종특별자치시처럼 시도 단위 코드가 표에 없고 시군구 코드가 시도 역할을 하는 경우
  if (!sido && sigungu) {
    sido = sigungu;
    sigungu = null;
  }
  const emd = emdE ? stripPrefix(emdE.name, sggE?.name ?? sidoE?.name) : null;
  const ri = c.slice(8, 10) !== '00' && self ? stripPrefix(self.name, emdE?.name) : null;

  return {
    pnu: pnu.trim(),
    ...parts,
    known: Boolean(self),
    abolished: self ? !self.active : false,
    sido,
    sigungu,
    eupmyeondong: emd,
    ri,
    jibunAddress: self ? `${self.name} ${formatJibun(parts)}` : null,
    dataSource: table.source,
  };
}
