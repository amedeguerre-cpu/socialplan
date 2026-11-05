import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  formatTr,
  PLATFORMS,
  PLATFORM_LABELS,
  type AccountDTO,
  type BrandDTO,
  type Platform,
  type QuotaDTO,
} from '@socialplan/shared';
import { api } from '../lib/api';
import { useBrand } from '../lib/brand';
import { qk, useAccounts, useInvalidate, useSettings } from '../lib/hooks';
import { PlatformIcon } from '../components/PlatformIcon';
import { BrandAvatar } from '../components/BrandSwitcher';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { Badge, Button } from '../components/ui';

const MODE_INFO: Record<Platform, string> = {
  instagram: 'Reels olarak otomatik yayınlar',
  youtube: 'Shorts olarak otomatik yükler',
  tiktok: 'Taslağa gönderir: TikTok uygulamasından tek dokunuşla yayınlanır',
};

function expiryTone(iso: string | null): 'green' | 'amber' | 'red' | 'slate' {
  if (!iso) return 'slate';
  const d = (new Date(iso).getTime() - Date.now()) / 86400_000;
  return d < 0 ? 'red' : d < 10 ? 'amber' : 'green';
}

export function AccountsPage() {
  const { brands, isLoading, error, refetch } = useBrand();
  const accounts = useAccounts(null);
  const settings = useSettings();
  const quota = useQuery({
    queryKey: ['quota'],
    queryFn: () => api.get<QuotaDTO>('/accounts/quota'),
  });
  const [params, setParams] = useSearchParams();
  const connected = params.get('connected');
  const err = params.get('error');

  if (isLoading || accounts.isLoading) return <Skeleton rows={6} className="p-6" />;
  if (error || accounts.error)
    return (
      <div className="p-6">
        <ErrorState
          error={error ?? accounts.error}
          onRetry={() => {
            refetch();
            void accounts.refetch();
          }}
        />
      </div>
    );
  if (!brands.length)
    return (
      <div className="p-6">
        <EmptyState title="Önce bir marka ekleyin" />
      </div>
    );

  const yt = quota.data?.youtube;
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      {(connected || err) && (
        <div
          className={`flex items-center justify-between rounded-lg p-3 text-sm ${err ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-800'}`}
        >
          <span>
            {err
              ? `Bağlantı başarısız: ${err}`
              : `${PLATFORM_LABELS[connected as Platform] ?? connected} hesabı bağlandı.`}
          </span>
          <button onClick={() => setParams({})} aria-label="Kapat">
            ✕
          </button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
          <p className="mb-1 flex items-center gap-2 font-medium">
            <PlatformIcon platform="youtube" size={16} /> YouTube kotası (Pasifik günü {yt?.day})
          </p>
          {yt ? (
            <p className="text-slate-600">
              Yükleme {yt.uploads_used}/{yt.uploads_limit} · birim {yt.units_used}/{yt.units_limit}
            </p>
          ) : (
            <p className="text-slate-400">—</p>
          )}
          <p className="mt-1">
            {settings.data?.youtube_audited ? (
              <Badge tone="green">Audit onaylı: public</Badge>
            ) : (
              <Badge tone="amber">Audit yok: videolar private kalır</Badge>
            )}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
          <p className="mb-1 flex items-center gap-2 font-medium">
            <PlatformIcon platform="instagram" size={16} /> Instagram 24 sa yayın kotası
          </p>
          <p className="text-slate-600">Her yayından önce API'den okunur (hesap kartında).</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
          <p className="mb-1 flex items-center gap-2 font-medium">
            <PlatformIcon platform="tiktok" size={16} /> TikTok modu
          </p>
          <p className="text-slate-600">{MODE_INFO.tiktok}.</p>
        </div>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-slate-50 text-left text-xs text-slate-500">
            <tr>
              <th className="p-3">Marka</th>
              {PLATFORMS.map((p) => (
                <th key={p} className="p-3">
                  <span className="flex items-center gap-1.5">
                    <PlatformIcon platform={p} size={16} /> {PLATFORM_LABELS[p]}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {brands.map((b) => (
              <tr key={b.id} className="align-top">
                <td className="p-3">
                  <span className="flex items-center gap-2 font-medium">
                    <BrandAvatar brand={b} size={24} /> {b.name}
                  </span>
                </td>
                {PLATFORMS.map((p) => (
                  <td key={p} className="p-3">
                    <AccountCell
                      brand={b}
                      platform={p}
                      account={
                        (accounts.data ?? []).find(
                          (a) => a.brand_id === b.id && a.platform === p,
                        ) ?? null
                      }
                      quota={quota.data}
                      dryRun={settings.data?.dry_run ?? true}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Bağlanmak için Worker'da DRY_RUN kapalı olmalı (OAuth token takası platforma istek atar).
        Önerilen sıra: kill switch aç → DRY_RUN=false → hesapları bağla → ALLOWED_ACCOUNT_IDS → kill
        switch kapat.
      </p>
    </div>
  );
}

function AccountCell({
  brand,
  platform,
  account,
  quota,
  dryRun,
}: {
  brand: BrandDTO;
  platform: Platform;
  account: AccountDTO | null;
  quota: QuotaDTO | undefined;
  dryRun: boolean;
}) {
  const inv = useInvalidate();
  const connectUrl = `/api/oauth/${platform}/start?brand_id=${encodeURIComponent(brand.id)}`;
  const refresh = () => inv(qk.accounts(), qk.accounts(brand.id), qk.brands);
  if (!account) {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-slate-400">Bağlı değil</p>
        <div className="flex flex-wrap gap-1.5">
          <a
            href={connectUrl}
            className="inline-flex rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700"
          >
            Bağla
          </a>
          {dryRun && (
            <Button
              className="!px-2 !py-1 text-xs"
              onClick={() =>
                void api.post('/accounts/demo', { brand_id: brand.id, platform }).then(refresh)
              }
            >
              Demo bağla
            </Button>
          )}
        </div>
        <p className="text-xs text-slate-400">{MODE_INFO[platform]}</p>
      </div>
    );
  }
  const ig = platform === 'instagram' ? quota?.instagram[account.id] : undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        {account.avatar_url ? (
          <img src={account.avatar_url} alt="" className="h-6 w-6 rounded-full" />
        ) : (
          <PlatformIcon platform={platform} size={22} />
        )}
        <div className="min-w-0">
          <p className="truncate font-medium">@{account.username ?? account.external_id}</p>
          <p className="truncate text-xs text-slate-500">{account.display_name}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        <Badge tone={account.status === 'active' ? 'green' : 'red'}>
          {account.status === 'active' ? 'Aktif' : 'Yeniden bağlanmalı'}
        </Badge>
        {!account.allowed && (
          <Badge tone="amber" title="ALLOWED_ACCOUNT_IDS dışında: gerçek istek atılmaz">
            Beyaz liste dışı
          </Badge>
        )}
        {account.mode === 'inbox' && <Badge tone="violet">Taslağa gönderir</Badge>}
        {account.scopes.includes('demo') && <Badge tone="violet">Demo</Badge>}
      </div>
      {account.token_expires_at && (
        <p className="text-xs">
          <Badge tone={expiryTone(account.token_expires_at)}>
            Token bitişi: {formatTr(account.token_expires_at)}
          </Badge>
        </p>
      )}
      {ig && ig.quota_total !== null && (
        <p className="text-xs text-slate-600">
          24 sa kota: {ig.quota_usage}/{ig.quota_total}
        </p>
      )}
      {account.last_error && <p className="text-xs text-red-600">{account.last_error}</p>}
      <p className="text-xs text-slate-400" title={account.id}>
        Kimlik: {account.external_id}
      </p>
      <div className="flex gap-1.5">
        <a
          href={connectUrl}
          className="rounded-md border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50"
        >
          Yeniden bağla
        </a>
        <button
          className="rounded-md px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
          onClick={() =>
            confirm('Bağlantı kesilsin mi? Token silinir.') &&
            void api.del(`/accounts/${account.id}`).then(refresh)
          }
        >
          Bağlantıyı kes
        </button>
      </div>
    </div>
  );
}
