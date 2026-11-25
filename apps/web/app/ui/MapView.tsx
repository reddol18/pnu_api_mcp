'use client';

import type { MapFeatures } from '@pnu/core';
import {
  type FilterSpecification,
  type MapLayerMouseEvent,
  Map as MlMap,
  NavigationControl,
  Popup,
  ScaleControl,
  type StyleSpecification,
} from 'maplibre-gl';
import { useEffect, useRef } from 'react';

/**
 * 필지·건물 외곽선을 겹쳐 그린다.
 * 배경지도는 브이월드 WMTS(Base, 레벨 6~19)를 같은 사이트의 /tiles/{z}/{y}/{x}.png로 받는다. 브라우저는 키를 모른다.
 * - 배포: CloudFront가 /tiles/*를 브이월드에서 직접 받아 캐시한다(키는 CloudFront 원본 경로, cloudfront/tiles.js가 검사).
 * - 로컬 next dev: next.config의 개발용 rewrites가 서버에서 대신 받는다.
 * 설계 §4-3 「배경지도」.
 */
function styleOf(basemap: boolean): StyleSpecification {
  if (!basemap) {
    return {
      version: 8,
      sources: {},
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f4f4f2' } }],
    };
  }
  return {
    version: 8,
    sources: {
      vworld: {
        type: 'raster',
        // MapLibre는 타일 주소에 절대 URL이 필요하다
        tiles: [`${window.location.origin}/tiles/{z}/{y}/{x}.png`],
        tileSize: 256,
        minzoom: 6,
        maxzoom: 19,
        attribution: '© 브이월드',
      },
    },
    layers: [{ id: 'vworld', type: 'raster', source: 'vworld' }],
  };
}

const COLORS = {
  start: '#2563eb',
  parcel: '#6b7280',
  ledger: '#dc2626',
  building: '#f59e0b',
};

function bounds(fc: MapFeatures): [[number, number], [number, number]] | null {
  let [a, b, c, d] = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (x: unknown): void => {
    if (Array.isArray(x) && typeof x[0] === 'number') {
      const [lon, lat] = x as [number, number];
      a = Math.min(a, lon);
      b = Math.min(b, lat);
      c = Math.max(c, lon);
      d = Math.max(d, lat);
    } else if (Array.isArray(x)) for (const y of x) walk(y);
  };
  for (const f of fc.features) walk(f.geometry.coordinates);
  return Number.isFinite(a)
    ? [
        [a, b],
        [c, d],
      ]
    : null;
}

export function MapView({ features, basemap }: { features: MapFeatures; basemap: boolean }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!el.current) return;
    const map = new MlMap({ container: el.current, style: styleOf(basemap), maxZoom: 20 });
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      map.addSource('f', { type: 'geojson', data: features });
      const role = (r: string) => ['==', ['get', 'role'], r] as FilterSpecification;
      map.addLayer({
        id: 'parcel-fill',
        type: 'fill',
        source: 'f',
        filter: ['!=', ['get', 'role'], 'building'],
        paint: {
          'fill-color': [
            'match',
            ['get', 'role'],
            'start-parcel',
            COLORS.start,
            'ledger-only-parcel',
            COLORS.ledger,
            COLORS.parcel,
          ],
          'fill-opacity': 0.12,
        },
      });
      map.addLayer({
        id: 'parcel-line',
        type: 'line',
        source: 'f',
        filter: ['!=', ['get', 'role'], 'building'],
        paint: {
          'line-color': [
            'match',
            ['get', 'role'],
            'start-parcel',
            COLORS.start,
            'ledger-only-parcel',
            COLORS.ledger,
            COLORS.parcel,
          ],
          'line-width': 2,
        },
      });
      map.addLayer({
        id: 'ledger-dash',
        type: 'line',
        source: 'f',
        filter: role('ledger-only-parcel'),
        paint: { 'line-color': COLORS.ledger, 'line-width': 2, 'line-dasharray': [2, 2] },
      });
      map.addLayer({
        id: 'building-fill',
        type: 'fill',
        source: 'f',
        filter: role('building'),
        paint: { 'fill-color': COLORS.building, 'fill-opacity': 0.55 },
      });
      map.addLayer({
        id: 'building-line',
        type: 'line',
        source: 'f',
        filter: role('building'),
        paint: { 'line-color': '#b45309', 'line-width': 1.5 },
      });
      // 글자 라벨은 글꼴(glyphs) 서버가 따로 필요해 쓰지 않는다 — 클릭하면 팝업으로 이름을 보여 준다
      const b = bounds(features);
      if (b) map.fitBounds(b, { padding: 40, maxZoom: 19, duration: 0 });
    });

    const popup = new Popup({ closeButton: false, closeOnClick: true });
    for (const id of ['building-fill', 'parcel-fill']) {
      map.on('click', id, (e: MapLayerMouseEvent) => {
        const f = e.features?.[0];
        if (!f) return;
        popup.setLngLat(e.lngLat).setText(String(f.properties.label)).addTo(map);
      });
    }
    return () => map.remove();
  }, [features, basemap]);

  return <div ref={el} className="map" />;
}
