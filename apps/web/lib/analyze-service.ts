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

const DAY = 24 * 60 * 60 * 1000;
// 필지·건물 자료는 자주 바뀌지 않는다(설계 §6, TTL 7일). 메모리라 개수는 작게.
const cache = new TtlCache<Omit<WebResult, 'cached'>>(7 * DAY, 300);

export const MAX_INPUT_LENGTH = 100;

export async function analyzeForWeb(input: string, opts: AnalyzeOptions = keysFromEnv()): Promise<WebResult> {
  const key = cacheKey(input);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

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
  if (complete) cache.set(key, body);
  return { ...body, cached: false };
}
