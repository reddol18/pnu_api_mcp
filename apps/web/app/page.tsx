import { SearchApp } from './ui/SearchApp';

export default function Page() {
  return <SearchApp basemap={process.env.NEXT_PUBLIC_BASEMAP !== 'none'} />;
}
