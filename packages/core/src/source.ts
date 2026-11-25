/** 외부 소스 하나의 결과. 한 소스가 실패해도 나머지 결과는 보여 준다(설계 §4). */
export type SourceResult<T> =
  | { status: 'ok'; data: T[] }
  | { status: 'empty'; data: [] }
  | { status: 'error'; data: []; error: { code: string; message: string } };

/** 오류 코드가 붙은 오류 (JusoError·LedgerError·VworldError) */
export interface CodedError extends Error {
  code: string;
}

function errorCode(e: unknown): string {
  if (e instanceof Error && typeof (e as Partial<CodedError>).code === 'string') return (e as CodedError).code;
  return 'UNKNOWN';
}

export async function settle<T>(p: Promise<T[]>): Promise<SourceResult<T>> {
  try {
    const data = await p;
    return data.length ? { status: 'ok', data } : { status: 'empty', data: [] };
  } catch (e) {
    return {
      status: 'error',
      data: [],
      error: { code: errorCode(e), message: e instanceof Error ? e.message : String(e) },
    };
  }
}

/**
 * 실패 종류: 다시 물어보면 되는지(retry), 설정을 고쳐야 하는지(config), 내일 다시 해야 하는지(quota)
 * 코드 출처: 실제 응답(30·05·INCORRECT_KEY), VWorld 2D데이터 오류표, juso 검색 API 오류표.
 * data.go.kr 게이트웨이의 다른 사유코드(한도 초과 등)는 아직 확인 안 함 → unknown(재시도 안내)으로 둔다.
 */
export type FailureKind = 'retry' | 'config' | 'quota' | 'unknown';

const CONFIG_CODES = new Set([
  'NO_KEY',
  'NO_DOMAIN',
  'INVALID_KEY', // VWorld: 등록되지 않은 인증키
  'INCORRECT_KEY', // VWorld: 인증키 정보가 올바르지 않음 (domain이 다를 때 실제로 봄)
  'UNAVAILABLE_KEY', // VWorld: 임시로 사용할 수 없는 키
  '30', // 건축HUB: 등록되지 않은 서비스키 (실제로 봄)
  'E0001', // juso: 승인되지 않은 KEY
  'E0014', // juso: 개발승인키 기간 만료
]);
const QUOTA_CODES = new Set(['OVER_REQUEST_LIMIT']); // VWorld: 일일 제한량 초과
const RETRY_CODES = new Set(['TIMEOUT', 'NETWORK', '05', 'SYSTEM_ERROR', '-999']);

export function failureKind(code: string): FailureKind {
  if (CONFIG_CODES.has(code)) return 'config';
  if (QUOTA_CODES.has(code)) return 'quota';
  if (RETRY_CODES.has(code) || /^HTTP_5\d\d$/.test(code)) return 'retry';
  return 'unknown';
}

export interface FailedSource {
  /** 예: "대장 부속지번", "공간 필지 경계" */
  source: string;
  code: string;
  message: string;
  kind: FailureKind;
}

/** 일부 소스가 실패해 결과가 빠졌을 때의 안내 */
export interface Incomplete {
  failed: FailedSource[];
  /** 같은 질문을 잠시 후 다시 하면 나아질 수 있으면 true */
  retryable: boolean;
  /** 사용자에게 그대로 보여 줄 안내 */
  message: string;
}

export function describeIncomplete(failed: FailedSource[]): Incomplete | null {
  if (!failed.length) return null;
  const kinds = new Set(failed.map((f) => f.kind));
  const names = failed.map((f) => `${f.source}(${f.code})`).join(', ');
  const parts: string[] = [`일부 자료를 받지 못해 결과가 빠졌을 수 있다: ${names}.`];
  if (kinds.has('retry') || kinds.has('unknown')) {
    parts.push('공공 API가 잠깐 응답하지 않은 경우가 대부분이다. 잠시(수십 초) 뒤 같은 질문을 다시 하면 된다.');
  }
  if (kinds.has('config')) {
    parts.push('API 키나 VWORLD_DOMAIN 설정 문제다. 다시 물어도 같으니 .env(또는 MCP 서버 환경변수)를 확인해야 한다.');
  }
  if (kinds.has('quota')) parts.push('API 일일 호출 한도를 넘었다. 내일 다시 하거나 운영계정 한도를 늘려야 한다.');
  return { failed, retryable: kinds.has('retry') || kinds.has('unknown'), message: parts.join(' ') };
}

export function failedFrom<T>(source: string, r: SourceResult<T>): FailedSource[] {
  return r.status === 'error'
    ? [{ source, code: r.error.code, message: r.error.message, kind: failureKind(r.error.code) }]
    : [];
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}
