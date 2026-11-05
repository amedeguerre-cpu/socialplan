import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountDTO,
  BrandDTO,
  PostDTO,
  SettingsDTO,
  SlotDTO,
  VideoDTO,
} from '@socialplan/shared';
import { api } from './api';

export const qk = {
  brands: ['brands'] as const,
  videos: (brandId: string) => ['videos', brandId] as const,
  video: (id: string) => ['video', id] as const,
  videoPosts: (id: string) => ['video-posts', id] as const,
  accounts: (brandId?: string) => ['accounts', brandId ?? 'all'] as const,
  slots: (brandId: string) => ['slots', brandId] as const,
  posts: (params: string) => ['posts', params] as const,
  settings: ['settings'] as const,
};

export const useBrands = () =>
  useQuery({ queryKey: qk.brands, queryFn: () => api.get<BrandDTO[]>('/brands') });
export const useSettings = () =>
  useQuery({ queryKey: qk.settings, queryFn: () => api.get<SettingsDTO>('/settings') });
export const useVideos = (brandId: string | null) =>
  useQuery({
    queryKey: qk.videos(brandId ?? ''),
    queryFn: () => api.get<VideoDTO[]>(`/videos?brand_id=${brandId}`),
    enabled: !!brandId,
  });
export const useAccounts = (brandId?: string | null) =>
  useQuery({
    queryKey: qk.accounts(brandId ?? undefined),
    queryFn: () => api.get<AccountDTO[]>(`/accounts${brandId ? `?brand_id=${brandId}` : ''}`),
  });
export const useSlots = (brandId: string | null) =>
  useQuery({
    queryKey: qk.slots(brandId ?? ''),
    queryFn: () => api.get<SlotDTO[]>(`/slots?brand_id=${brandId}`),
    enabled: !!brandId,
  });
export const useVideoPosts = (videoId: string | null) =>
  useQuery({
    queryKey: qk.videoPosts(videoId ?? ''),
    queryFn: () => api.get<PostDTO[]>(`/videos/${videoId}/posts`),
    enabled: !!videoId,
  });

/** Mutasyon sonrası ilgili sorguları tazele. */
export function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: readonly (readonly unknown[])[]) =>
    Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: k })));
}

export function useApiMutation<TVars, TRes>(
  fn: (v: TVars) => Promise<TRes>,
  invalidate: readonly (readonly unknown[])[] = [],
) {
  const inv = useInvalidate();
  return useMutation({ mutationFn: fn, onSuccess: () => inv(...invalidate) });
}
