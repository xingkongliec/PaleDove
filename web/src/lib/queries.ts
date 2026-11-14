import { QueryClient, useQuery } from '@tanstack/react-query';
import type { MeDTO, PublicConfigDTO } from '../shared/index';
import { api, ApiError } from './api';

export const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { meta: { progress: true } },
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && ((err.status >= 400 && err.status < 500) || err.code === 'MAINTENANCE')) && count < 2,
    },
  },
});

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => (await api.get<{ user: MeDTO | null }>('/auth/me')).user,
    staleTime: 30_000,
  });
}

export function usePublicConfig() {
  return useQuery({
    queryKey: ['public-config'],
    queryFn: () => api.get<PublicConfigDTO>('/public/config'),
    staleTime: 30_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

/** 当前站点的货币符号 */
export function useCurrency(): string {
  return usePublicConfig().data?.currency ?? '¥';
}
