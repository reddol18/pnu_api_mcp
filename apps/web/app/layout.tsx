import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import './globals.css';

export const metadata: Metadata = {
  title: '필지-건물 관계 조회',
  description:
    '주소나 PNU로 건물이 필지 몇 개에 걸쳤는지, 필지에 건물이 몇 동인지 건축물대장과 공간 데이터로 판정한다.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
