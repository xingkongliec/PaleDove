import type { InstanceType, MarketListPageDTO, MarketSort } from '../shared/index';
import { api } from './api';

export const MARKET_PAGE_SIZE = 12;

export interface MarketFilters {
  region: string;
  type: InstanceType | 'ALL';
  sort: MarketSort;
  keyword: string;
  page: number;
}

export function marketListOptions(filters: MarketFilters, user: number) {
  const { region, type, sort, keyword, page } = filters;
  return {
    queryKey: ['market', { ...filters, user }],
    queryFn: () => api.get<MarketListPageDTO>('/public/market', {
      page, pageSize: MARKET_PAGE_SIZE, sort,
      region: region === 'ALL' ? undefined : region,
      type: type === 'ALL' ? undefined : type,
      q: keyword || undefined,
    }),
  };
}
