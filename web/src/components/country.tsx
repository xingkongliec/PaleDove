import * as F from 'country-flag-icons/string/3x2';
import type { Locale } from '../shared/index';
import { Globe } from 'lucide-react';
import { useMemo } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/cn';
import { Select } from './ui/select';

/** 宿主机可选的国家或地区（ISO 3166-1 alpha-2）；只打包这些国旗 */
const FLAGS: Record<string, string> = {
  HK: F.HK, JP: F.JP, SG: F.SG, US: F.US, KR: F.KR, TW: F.TW, CN: F.CN, MO: F.MO, DE: F.DE, GB: F.GB, NL: F.NL, FR: F.FR,
  MY: F.MY, TH: F.TH, VN: F.VN, PH: F.PH, ID: F.ID, IN: F.IN, AE: F.AE, SA: F.SA, TR: F.TR, IL: F.IL, KZ: F.KZ, PK: F.PK,
  BD: F.BD, MN: F.MN, KH: F.KH, SE: F.SE, NO: F.NO, FI: F.FI, DK: F.DK, IE: F.IE, IT: F.IT, ES: F.ES, PT: F.PT, CH: F.CH,
  AT: F.AT, BE: F.BE, PL: F.PL, CZ: F.CZ, RO: F.RO, BG: F.BG, HU: F.HU, UA: F.UA, RU: F.RU, LU: F.LU, LT: F.LT, LV: F.LV,
  EE: F.EE, IS: F.IS, GR: F.GR, RS: F.RS, MD: F.MD, CA: F.CA, MX: F.MX, BR: F.BR, AR: F.AR, CL: F.CL, CO: F.CO, PE: F.PE,
  AU: F.AU, NZ: F.NZ, ZA: F.ZA, EG: F.EG, NG: F.NG, KE: F.KE, MA: F.MA,
};

/** 常用地区排在前面，其余按名称排序 */
const POPULAR = ['HK', 'JP', 'SG', 'US', 'KR', 'TW', 'CN', 'DE', 'GB', 'NL', 'FR'];

const flagUrl = (code: string) => {
  const svg = FLAGS[code];
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
};

/** 中文里香港、澳门的完整名称过长，使用常用简称（与服务端生成的默认地区名一致） */
const SHORT_ZH: Partial<Record<Locale, Record<string, string>>> = {
  'zh-CN': { HK: '香港', MO: '澳门' },
  'zh-TW': { HK: '香港', MO: '澳門' },
};

export function useCountryName() {
  const { locale } = useI18n();
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      /* 浏览器不支持时显示代码 */
    }
    return (code: string) => SHORT_ZH[locale]?.[code] || (code && names?.of(code)) || code;
  }, [locale]);
}

export function CountryFlag({ code, className }: { code: string; className?: string }) {
  const src = flagUrl(code);
  if (!src) return <Globe className={cn('h-3 w-[18px] shrink-0 text-fg-4', className)} aria-hidden />;
  return <img src={src} alt="" aria-hidden className={cn('h-3 w-[18px] shrink-0 rounded-[2px] object-cover ring-1 ring-line', className)} />;
}

/** 国旗 + 名称，例如宿主机列表中的地区 */
export function CountryLabel({ code, fallback, className }: { code: string; fallback?: string; className?: string }) {
  const name = useCountryName();
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <CountryFlag code={code} />
      <span className="truncate">{code ? name(code) : fallback}</span>
    </span>
  );
}

export function CountrySelect({ value, onChange, placeholder }: { value: string; onChange: (code: string) => void; placeholder?: string }) {
  const { locale } = useI18n();
  const name = useCountryName();
  const options = useMemo(() => {
    const collator = new Intl.Collator(locale);
    const rest = Object.keys(FLAGS)
      .filter((c) => !POPULAR.includes(c))
      .sort((a, b) => collator.compare(name(a), name(b)));
    // 已保存的代码不在列表中时也要能显示
    const codes = [...POPULAR, ...rest, ...(value && !FLAGS[value] ? [value] : [])];
    return codes.map((code) => ({ value: code, label: <CountryLabel code={code} /> }));
  }, [locale, name, value]);
  return <Select value={value || null} onChange={onChange} options={options} placeholder={placeholder} />;
}

/** 国家或地区所在的区域（按联合国地理分区归类），显示在国家名称下方，如“欧洲西部” */
const AREAS = {
  eastAsia: 'HK JP KR TW CN MO MN',
  southeastAsia: 'SG MY TH VN PH ID KH',
  southAsia: 'IN PK BD',
  westAsia: 'AE SA TR IL',
  centralAsia: 'KZ',
  northEurope: 'SE NO FI DK IE GB LT LV EE IS',
  westEurope: 'DE NL FR CH AT BE LU',
  southEurope: 'IT ES PT GR RS',
  eastEurope: 'PL CZ RO BG HU UA RU MD',
  northAmerica: 'US CA',
  centralAmerica: 'MX',
  southAmerica: 'BR AR CL CO PE',
  oceania: 'AU NZ',
  northAfrica: 'EG MA',
  westAfrica: 'NG',
  eastAfrica: 'KE',
  southAfrica: 'ZA',
} as const;
export type CountryArea = keyof typeof AREAS;
const AREA_OF: Record<string, CountryArea> = Object.fromEntries(
  (Object.entries(AREAS) as Array<[CountryArea, string]>).flatMap(([area, codes]) => codes.split(' ').map((code) => [code, area])),
);

/** 国家代码 → 所在区域名称；不在列表里时返回 null */
export function useCountryArea() {
  const { t } = useI18n();
  return (code: string | null | undefined) => {
    const area = code ? AREA_OF[code.toUpperCase()] : undefined;
    return area ? t(`geo.${area}`) : null;
  };
}
