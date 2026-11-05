import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  formatTr,
  PLATFORM_LABELS,
  POST_STATUS_LABELS,
  type PostDTO,
  type PostEventDTO,
} from '@socialplan/shared';
import { api } from '../lib/api';
import { useBrand } from '../lib/brand';
import { useInvalidate, useSettings } from '../lib/hooks';
import { PlatformIcon } from './PlatformIcon';
import { StatusDot } from './StatusDot';
import { Badge, Button, Drawer, inputCls, Tabs } from './ui';
import { ErrorState, Skeleton } from './States';

const ERROR_HELP: Record<string, string> = {
  missed_slot:
    'Planlanan saat tolerans süresini aştı; otomatik paylaşılmadı. "Tekrar dene" ile şimdi paylaşabilirsiniz.',
  kill_switch: 'Kill switch açıkken durduruldu. Kapatıp "Tekrar dene".',
  commit_uncertain:
    'Platformdaki son adımın sonucu kesinleşmedi. Platformda kontrol edin: yayınlandıysa "Yayınladım", değilse "Tekrar dene".',
  account_reconnect: 'Hesap bağlantısı düştü. Hesaplar ekranından yeniden bağlayın.',
  token_refresh_failed: 'Token yenilenemedi. Hesaplar ekranından yeniden bağlayın.',
  account_not_allowed: 'Hesap ALLOWED_ACCOUNT_IDS beyaz listesinde değil.',
  youtube_not_audited: 'YouTube audit onayı yok: yalnız test kanalına private yükleme yapılabilir.',
};

export function PostDetail({ postId, onClose }: { postId: string | null; onClose: () => void }) {
  const post = useQuery({
    queryKey: ['post', postId],
    queryFn: () => api.get<PostDTO>(`/posts/${postId}`),
    enabled: !!postId,
    refetchInterval: (q) => (q.state.data?.status === 'processing' ? 3000 : false),
  });
  return (
    <Drawer
      open={!!postId}
      onClose={onClose}
      title={post.data ? post.data.video_title || 'Paylaşım' : 'Paylaşım'}
    >
      {post.isLoading ? (
        <Skeleton rows={5} />
      ) : post.error ? (
        <ErrorState error={post.error} onRetry={() => void post.refetch()} />
      ) : post.data ? (
        <Body post={post.data} onClose={onClose} />
      ) : null}
    </Drawer>
  );
}

function Body({ post, onClose }: { post: PostDTO; onClose: () => void }) {
  const { brand } = useBrand();
  const settings = useSettings();
  const inv = useInvalidate();
  const siblings = useQuery({
    queryKey: ['video-posts', post.video_id],
    queryFn: () => api.get<PostDTO[]>(`/videos/${post.video_id}/posts`),
  });
  const group = (siblings.data ?? []).filter(
    (p) => p.scheduled_at === post.scheduled_at && p.status !== 'cancelled',
  );
  const [activeId, setActiveId] = useState(post.id);
  const active = group.find((p) => p.id === activeId) ?? post;
  const refresh = () =>
    inv(['post'], ['posts'], ['video-posts', post.video_id], ['videos'], ['brands']);

  return (
    <div className="space-y-4">
      {group.length > 1 && (
        <Tabs
          value={active.id}
          onChange={setActiveId}
          items={group.map((p) => ({
            value: p.id,
            label: (
              <span className="flex items-center gap-1.5">
                <PlatformIcon platform={p.platform} size={14} />
                {PLATFORM_LABELS[p.platform]}
                <StatusDot status={p.status} size={6} />
              </span>
            ),
          }))}
        />
      )}
      <PostPanel
        key={active.id}
        post={active}
        tz={brand?.timezone ?? 'Europe/Istanbul'}
        youtubeAudited={settings.data?.youtube_audited ?? false}
        onChanged={refresh}
        onClose={onClose}
      />
    </div>
  );
}

function PostPanel({
  post,
  tz,
  youtubeAudited,
  onChanged,
  onClose,
}: {
  post: PostDTO;
  tz: string;
  youtubeAudited: boolean;
  onChanged: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [caption, setCaption] = useState(post.caption_snapshot ?? '');
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const events = useQuery({
    queryKey: ['post-events', post.id, post.updated_at],
    queryFn: () => api.get<PostEventDTO[]>(`/posts/${post.id}/events`),
  });
  const editable = ['draft', 'scheduled', 'needs_action', 'failed'].includes(post.status);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await onChanged();
      setMsg(ok);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'İşlem başarısız');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        {post.thumbnail_url && (
          <img src={post.thumbnail_url} alt="" className="h-28 w-16 rounded object-cover" />
        )}
        <div className="space-y-1 text-sm">
          <div className="flex items-center gap-2">
            <PlatformIcon platform={post.platform} />
            <span className="font-medium">{PLATFORM_LABELS[post.platform]}</span>
            <StatusDot status={post.status} />
            <span>{POST_STATUS_LABELS[post.status]}</span>
            {post.visibility === 'dry-run' && <Badge tone="violet">dry-run</Badge>}
            {post.visibility === 'private' && <Badge tone="amber">private</Badge>}
          </div>
          <p className="text-slate-600">{formatTr(post.scheduled_at, tz)}</p>
          {post.step && post.status === 'processing' && (
            <p className="text-xs text-slate-500">
              Adım: {post.step} · deneme {post.attempt_count}
            </p>
          )}
          {post.external_url && (
            <a
              href={post.external_url}
              target="_blank"
              rel="noreferrer"
              className="text-brand-600 hover:underline"
            >
              Platformda aç ↗
            </a>
          )}
          {post.platform === 'youtube' && !youtubeAudited && (
            <p className="text-xs text-amber-700">Audit onayı yok: video private kalacak.</p>
          )}
        </div>
      </div>

      {post.last_error_message &&
        (post.status === 'failed' ||
          post.status === 'needs_action' ||
          post.status === 'processing') && (
          <div
            className={`rounded-lg p-3 text-sm ${post.status === 'needs_action' ? 'bg-orange-50 text-orange-900' : post.status === 'failed' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900'}`}
          >
            <p className="font-medium">
              {post.status === 'processing'
                ? 'Geçici hata — yeniden denenecek'
                : post.status === 'failed'
                  ? 'Hata'
                  : 'İşlem gerekli'}
            </p>
            <p>{post.last_error_message}</p>
            {post.last_error_code && ERROR_HELP[post.last_error_code] && (
              <p className="mt-1 text-xs">{ERROR_HELP[post.last_error_code]}</p>
            )}
          </div>
        )}

      {post.status === 'inbox_sent' && (
        <div className="space-y-2 rounded-lg bg-violet-50 p-3 text-sm text-violet-900">
          <p className="font-medium">Taslak TikTok gelen kutusunda</p>
          <p>
            TikTok uygulamasında bildirimi açıp tek dokunuşla yayınlayın, sonra burada işaretleyin.
          </p>
          {post.caption_snapshot && (
            <Button
              onClick={() =>
                void navigator.clipboard
                  .writeText(post.caption_snapshot ?? '')
                  .then(() => setMsg('Metin kopyalandı'))
              }
            >
              Metni kopyala (TikTok açıklaması)
            </Button>
          )}
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.tiktok.com/@hesap/video/… (isteğe bağlı)"
            className={inputCls}
          />
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(
                () => api.post(`/posts/${post.id}/mark-published`, url ? { url } : {}),
                'Yayınlandı olarak işaretlendi',
              )
            }
          >
            Yayınladım
          </Button>
        </div>
      )}

      <div>
        <label className="mb-1 block text-sm font-medium">
          Metin ({PLATFORM_LABELS[post.platform]})
        </label>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          rows={5}
          disabled={!editable}
          className={inputCls}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {editable && (
          <Button
            disabled={busy || caption === (post.caption_snapshot ?? '')}
            onClick={() =>
              void act(
                () => api.patch(`/posts/${post.id}`, { caption_snapshot: caption }),
                'Kaydedildi',
              )
            }
          >
            Metni kaydet
          </Button>
        )}
        {(post.status === 'scheduled' || post.status === 'draft') && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(() => api.post(`/posts/${post.id}/publish-now`), 'Kuyruğa alındı')
            }
          >
            Şimdi paylaş
          </Button>
        )}
        {post.platform === 'youtube' &&
          post.status === 'published' &&
          post.visibility === 'private' &&
          youtubeAudited && (
            <Button
              disabled={busy}
              onClick={() =>
                void act(() => api.post(`/posts/${post.id}/youtube-public`), 'Video public yapıldı')
              }
            >
              YouTube'da public yap
            </Button>
          )}
        {(post.status === 'failed' || post.status === 'needs_action') && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(() => api.post(`/posts/${post.id}/retry`), 'Yeniden kuyruğa alındı')
            }
          >
            Tekrar dene
          </Button>
        )}
        {post.status === 'needs_action' && (
          <Button
            disabled={busy}
            onClick={() =>
              void act(
                () => api.post(`/posts/${post.id}/mark-published`, {}),
                'Yayınlandı olarak işaretlendi',
              )
            }
          >
            Yayınlandı olarak işaretle
          </Button>
        )}
        {!['published', 'cancelled'].includes(post.status) && (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (confirm('Paylaşım iptal edilsin mi?'))
                void act(() => api.post(`/posts/${post.id}/cancel`), 'İptal edildi').then(onClose);
            }}
          >
            İptal
          </Button>
        )}
      </div>
      {msg && <p className="text-sm text-slate-600">{msg}</p>}

      <section>
        <h3 className="mb-2 text-sm font-semibold">Geçmiş</h3>
        {events.isLoading ? (
          <Skeleton rows={3} />
        ) : (
          <ol className="space-y-1.5 border-l border-slate-200 pl-3 text-xs">
            {(events.data ?? []).map((e) => (
              <li key={e.id}>
                <span className="text-slate-400">{formatTr(e.at, tz)}</span>{' '}
                {e.from_status !== e.to_status && e.to_status ? (
                  <b>{POST_STATUS_LABELS[e.to_status]}</b>
                ) : (
                  <span>{e.step}</span>
                )}
                {e.detail && (
                  <span className="ml-1 text-slate-500">
                    {String(
                      e.detail.message ??
                        e.detail.reason ??
                        e.detail.action ??
                        e.detail.source ??
                        (e.detail.retry_in_sec
                          ? `${String(e.detail.retry_in_sec)} sn sonra tekrar`
                          : ''),
                    )}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
