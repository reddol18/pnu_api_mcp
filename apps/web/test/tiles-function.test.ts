import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// CloudFront Function 파일을 배포되는 그대로 읽어 handler를 꺼낸다(모듈 문법이 없는 런타임이라)
const code = readFileSync(new URL('../cloudfront/tiles.js', import.meta.url), 'utf8');
type Req = { uri: string; querystring: Record<string, unknown> };
type Res = { statusCode: number; headers: Record<string, { value: string }> };
const handler = new Function(`${code}; return handler;`)() as (e: { request: Req }) => Req | Res;

const run = (uri: string) => handler({ request: { uri, querystring: { a: { value: '1' } } } });

describe('타일 CloudFront Function', () => {
  it('한국 타일은 원본 경로 뒤에 붙을 주소로 바꾼다 (명세 예시: 11/793/1746)', () => {
    expect(run('/tiles/11/793/1746.png')).toEqual({ uri: '/11/793/1746.png', querystring: {} });
  });

  it('높은 레벨 서울 타일 (19/203127/446928)', () => {
    expect(run('/tiles/19/203127/446928.png')).toMatchObject({ uri: '/19/203127/446928.png' });
  });

  it.each([
    ['레벨 5', '/tiles/5/12/27.png'],
    ['레벨 20', '/tiles/20/1/1.png'],
    ['형식 오류', '/tiles/11/793/abc.png'],
    ['확장자 없음', '/tiles/11/793/1746'],
    ['경로 탈출', '/tiles/../11/793/1746.png'],
    ['범위 밖 좌표', '/tiles/6/64/9999.png'],
  ])('404: %s', (_, uri) => {
    expect(run(uri)).toMatchObject({ statusCode: 404 });
  });

  // 타일 번호는 웹 메르카토르 공식으로 계산한 값 (z=11)
  it.each([
    ['도쿄', '/tiles/11/806/1818.png'],
    ['베이징', '/tiles/11/776/1686.png'],
    ['뉴욕', '/tiles/11/770/603.png'],
  ])('한국 밖은 403: %s', (_, uri) => {
    expect(run(uri)).toMatchObject({ statusCode: 403 });
  });

  it.each([
    ['제주', '/tiles/11/821/1743.png'],
    ['마라도', '/tiles/11/824/1742.png'],
    ['독도 (경도 132 경계 칸)', '/tiles/11/795/1774.png'],
  ])('한국 가장자리도 허용: %s', (_, uri) => {
    expect(run(uri)).toMatchObject({ uri: uri.replace('/tiles', '') });
  });
});
