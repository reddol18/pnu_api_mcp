import { SearchApp } from './ui/SearchApp';

export default function Page() {
  return <SearchApp tileKey={process.env.NEXT_PUBLIC_VWORLD_TILE_KEY ?? ''} />;
}
