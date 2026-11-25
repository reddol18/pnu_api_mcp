'use client';

import type { MapFeatures, PresentedResult } from '@pnu/core';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { MapView } from './MapView';

type Ok = Extract<PresentedResult, { status: 'ok' }>;
type View = Ok['ledger'];

interface ApiBody {
  result: PresentedResult;
  map: MapFeatures | null;
  cached: boolean;
}

const EXAMPLES = ['남산공원길 105', '서울특별시 중구 태평로1가 31', '세종대로 110', '낭성면 행정복지센터'];

export function SearchApp({ tileKey }: { tileKey: string }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState<ApiBody | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (input: string) => {
    const s = input.trim();
    if (!s) return;
    setQ(s);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/analyze?q=${encodeURIComponent(s)}`);
      const json = (await res.json()) as ApiBody | { error: string };
      if (!res.ok || 'error' in json) {
        setBody(null);
        setError('error' in json ? json.error : `요청 실패 (${res.status})`);
      } else {
        setBody(json);
        const url = new URL(window.location.href);
        url.searchParams.set('q', s);
        window.history.replaceState(null, '', url);
      }
    } catch {
      setError('서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.');
    } finally {
      setBusy(false);
    }
  }, []);

  // 주소창의 ?q= 로 바로 조회 (공유 링크)
  useEffect(() => {
    const initial = new URL(window.location.href).searchParams.get('q');
    if (initial) void run(initial);
  }, [run]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void run(q);
  };

  return (
    <main>
      <header>
        <h1>필지-건물 관계 조회</h1>
        <p className="lead">
          건물 하나가 필지 몇 개에 걸쳤는지, 필지 하나에 건물이 몇 동인지 <b>건축물대장</b>과 <b>공간 데이터</b>(건물
          외곽선·지적도) 두 근거로 따로 판정합니다.
        </p>
      </header>

      <form onSubmit={onSubmit} className="search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="지번주소, 도로명주소, PNU(19자리), 건물명"
          aria-label="주소 또는 PNU"
          maxLength={100}
        />
        <button type="submit" disabled={busy}>
          {busy ? '조회 중…' : '조회'}
        </button>
      </form>
      <p className="examples">
        예:{' '}
        {EXAMPLES.map((ex) => (
          <button key={ex} type="button" className="link" onClick={() => void run(ex)} disabled={busy}>
            {ex}
          </button>
        ))}
      </p>

      {error && <p className="alert">{error}</p>}
      {body && (
        <Result body={body} onPick={(s) => void run(s)} onRetry={() => void run(q)} busy={busy} tileKey={tileKey} />
      )}

      <footer>
        자료: 행정안전부 도로명주소 검색 API, 국토교통부 건축HUB 건축물대장정보, 브이월드 연속지적도·도로명주소 건물.
        대장과 공간 데이터는 기준일이 달라 서로 다를 수 있으며, 다른 것은 오류가 아니라 정보입니다. 법적 효력이
        없습니다.
      </footer>
    </main>
  );
}

function Result({
  body,
  onPick,
  onRetry,
  busy,
  tileKey,
}: {
  body: ApiBody;
  onPick: (s: string) => void;
  onRetry: () => void;
  busy: boolean;
  tileKey: string;
}) {
  const r = body.result;
  if (r.status === 'not_found') return <p className="alert">{r.message}</p>;
  if (r.status === 'error') {
    return (
      <div className="alert">
        <p>{r.message}</p>
        {r.retryable && (
          <button type="button" onClick={onRetry} disabled={busy}>
            다시 시도
          </button>
        )}
      </div>
    );
  }
  if (r.status === 'ambiguous') {
    return (
      <section>
        <p className="notice">{r.message}</p>
        <ul className="choices">
          {r.candidates.map((c) => (
            <li key={c.buildingMgmtNo}>
              <button type="button" className="link" onClick={() => onPick(c.roadAddress)}>
                {c.roadAddress}
                {c.buildingName ? ` (${c.buildingName})` : ''}
              </button>{' '}
              <small>{c.jibunAddress}</small>
            </li>
          ))}
          {r.parcels.map((p) => (
            <li key={p.pnu}>
              <button type="button" className="link" onClick={() => onPick(p.pnu)}>
                {p.jibunAddress}
              </button>{' '}
              <small>PNU {p.pnu}</small>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section>
      <p className={`summary ${r.agree === false ? 'warn' : ''}`}>{r.summary}</p>
      {r.incomplete && (
        <div className="alert">
          <p>{r.incomplete.message}</p>
          {r.incomplete.retryable && (
            <button type="button" onClick={onRetry} disabled={busy}>
              다시 시도
            </button>
          )}
        </div>
      )}

      <div className="layout">
        <div className="map-wrap">
          {body.map && <MapView features={body.map} tileKey={tileKey} />}
          <Legend />
        </div>
        <div className="panels">
          <Panel title="건축물대장 기준 (법적)" v={r.ledger} />
          <Panel title="공간 기준 (실제 겹침)" v={r.spatial} />
        </div>
      </div>

      {r.discrepancies.length > 0 && (
        <>
          <h3>불일치·주의</h3>
          <ul className="disc">
            {r.discrepancies.map((d) => (
              <li key={`${d.code}|${d.pnu ?? ''}|${d.buildingId ?? ''}`}>
                <code>{d.code}</code> {d.message}
              </li>
            ))}
          </ul>
        </>
      )}
      {r.notes.length > 0 && (
        <details>
          <summary>참고</summary>
          <ul>
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="muted">
        관계 표기: {r.relationNotation}
        {body.cached ? ' · 저장된 결과' : ''}
      </p>
    </section>
  );
}

function Panel({ title, v }: { title: string; v: View }) {
  const pctBy = new Map(v.edges.map((e) => [`${e.buildingId}|${e.pnu}`, e]));
  return (
    <div className="panel">
      <h3>{title}</h3>
      {v.status !== 'ok' ? (
        <p className="muted">{v.status === 'error' ? `조회 실패 (${v.error?.code ?? ''})` : '자료 없음'}</p>
      ) : (
        <>
          <p className="rel">
            <b>{v.relation}</b> {v.relationText}
          </p>
          <table>
            <thead>
              <tr>
                <th>건물</th>
                <th>필지</th>
                <th>근거</th>
              </tr>
            </thead>
            <tbody>
              {v.buildings.flatMap((b) =>
                v.edges
                  .filter((e) => e.buildingId === b.id)
                  .map((e) => {
                    const edge = pctBy.get(`${b.id}|${e.pnu}`);
                    const parcel = v.parcels.find((p) => p.pnu === e.pnu);
                    return (
                      <tr key={`${b.id}|${e.pnu}`}>
                        <td>{[b.name, b.dongName].filter(Boolean).join(' ') || <small>{b.id}</small>}</td>
                        <td>{parcel?.jibunAddress ?? e.pnu}</td>
                        <td>
                          {e.via === 'representative'
                            ? '대지위치'
                            : e.via === 'attached'
                              ? '부속지번'
                              : `겹침 ${edge?.overlapPercentOfBuilding ?? '?'}%`}
                        </td>
                      </tr>
                    );
                  }),
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Legend() {
  return (
    <ul className="legend">
      <li>
        <span className="sw start" /> 출발 필지
      </li>
      <li>
        <span className="sw parcel" /> 건물이 걸친 필지
      </li>
      <li>
        <span className="sw ledger" /> 대장에만 있는 필지
      </li>
      <li>
        <span className="sw building" /> 건물 외곽선
      </li>
    </ul>
  );
}
