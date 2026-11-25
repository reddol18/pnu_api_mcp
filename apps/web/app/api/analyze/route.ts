import { analyzeForWeb, MAX_INPUT_LENGTH } from '../../../lib/analyze-service';
import { clientIp, RateLimiter } from '../../../lib/rate-limit';

// IP당 10분에 30회 (캐시에 맞은 요청도 센다)
const limiter = new RateLimiter(30, 10 * 60 * 1000);

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
  if (!q) return Response.json({ error: '주소나 PNU를 입력하세요' }, { status: 400 });
  if (q.length > MAX_INPUT_LENGTH) {
    return Response.json({ error: `입력은 ${MAX_INPUT_LENGTH}자 이하로` }, { status: 400 });
  }

  const ip = clientIp(req.headers);
  const allowed = limiter.check(ip);
  if (!allowed.ok) {
    return Response.json(
      { error: `요청이 너무 많습니다. ${allowed.retryAfterSec}초 뒤에 다시 시도하세요.` },
      { status: 429, headers: { 'Retry-After': String(allowed.retryAfterSec) } },
    );
  }

  // 입력 주소는 로그에 남기지 않는다(설계 §9)
  const body = await analyzeForWeb(q);
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
