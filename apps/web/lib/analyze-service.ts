/**
 * 웹 API의 본체: 입력 → core analyze → 응답 본문(+ 지도 GeoJSON). Route Handler는 이것만 부른다.
 * 공공 API 키는 서버 환경변수에서만 읽는다(브라우저로 보내지 않는다).
 */
import {
  type AnalyzeOptions,
  analyze,
  type MapFeatures,
  mapFeaturesWithMissing,
  type PresentedResult,
  presentResult,
} from '@pnu/core';
import { cacheKey, TtlCache } from './cache';
import { dynamoCacheFromEnv, type SharedCache } from './dynamo-cache';

export interface WebResult {
  result: PresentedResult;
  /** 지도용 도형. 판정 결과가 없으면 null */
  map: MapFeatures | null;
  cached: boolean;
}

export function keysFromEnv(env: NodeJS.ProcessEnv = process.env): AnalyzeOptions {
  return {
    jusoKey: env.JUSO_KEY ?? '',
    dataGoKrKey: env.DATA_GO_KR_KEY ?? '',
    vworldKey: env.VWORLD_KEY ?? '',
    vworldDomain: env.VWORLD_DOMAIN ?? '',
  };
}

type Body = Omit<WebResult, 'cached'>;

const DAY = 24 * 60 * 60 * 1000;
const TTL_MS = 7 * DAY;
// 필지·건물 자료는 자주 바뀌지 않는다(설계 §6, TTL 7일). 1단계: 인스턴스 메모리(개수는 작게), 2단계: DynamoDB(공유)
const cache = new TtlCache<Body>(TTL_MS, 300);
const shared: SharedCache<Body> | null = dynamoCacheFromEnv<Body>(TTL_MS);

export const MAX_INPUT_LENGTH = 100;

/** 적중률을 보려고 남기는 한 줄(주소는 남기지 않는다) */
function logCache(cache: 'memory' | 'shared' | 'miss'): void {
  console.log(JSON.stringify({ cache }));
}

export async function analyzeForWeb(
  input: string,
  opts: AnalyzeOptions = keysFromEnv(),
  sharedCache: SharedCache<Body> | null = shared,
): Promise<WebResult> {
  const key = cacheKey(input);
  const hit = cache.get(key);
  if (hit) {
    logCache('memory');
    return { ...hit, cached: true };
  }
  const sharedHit = await sharedCache?.get(key);
  if (sharedHit) {
    logCache('shared');
    cache.set(key, sharedHit);
    return { ...sharedHit, cached: true };
  }
  logCache('miss');

  const r = await analyze(input, opts);
  const map =
    r.status === 'ok'
      ? await mapFeaturesWithMissing(r.analysis, {
          key: opts.vworldKey ?? '',
          domain: opts.vworldDomain ?? '',
          ...(opts.fetch && { fetch: opts.fetch }),
        })
      : null;
  const body = { result: presentResult(r), map };
  // 완전한 결과만 캐시한다. 일부가 빠졌거나 오류면 다음에 다시 조회하게 둔다.
  const complete = r.status === 'ok' ? r.analysis.incomplete === null : r.status === 'ambiguous';
  if (complete) {
    cache.set(key, body);
    await sharedCache?.set(key, body);
  }
  return { ...body, cached: false };
}
