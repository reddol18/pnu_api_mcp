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

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isTimeoutError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
}
