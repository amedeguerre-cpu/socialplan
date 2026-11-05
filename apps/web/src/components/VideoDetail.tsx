import { useEffect, useState } from 'react';
import {
  PLATFORMS,
  PLATFORM_LABELS,
  buildCaption,
  formatTr,
  POST_STATUS_LABELS,
  type Platform,
  type VideoDTO,
} from '@socialplan/shared';
import { api } from '../lib/api';
import { qk, useAccounts, useInvalidate, useVideoPosts } from '../lib/hooks';
import { captureFrame } from '../lib/media';
import { uploadThumbnail } from '../lib/upload';
import { useBrand } from '../lib/brand';
import { PlatformIcon } from './PlatformIcon';
import { ValidationBadges } from './ValidationBadges';
import { Badge, Button, Drawer, Field, formatBytes, formatDuration, inputCls, Tabs } from './ui';
import { StatusDot } from './StatusDot';

export function VideoDetail({ video, onClose }: { video: VideoDTO | null; onClose: () => void }) {
  return (
    <Drawer
      open={!!video}
      onClose={onClose}
      title={video?.title || video?.original_name || 'Video'}
      width="max-w-2xl"
    >
      {video && <VideoDetailBody key={video.id} video={video} onClose={onClose} />}
    </Drawer>
  );
}

function VideoDetailBody({ video, onClose }: { video: VideoDTO; onClose: () => void }) {
  const inv = useInvalidate();
  const [title, setTitle] = useState(video.title);
  const [description, setDescription] = useState(video.description);
  const [hashtags, setHashtags] = useState(video.hashtags.map((h) => `#${h}`).join(' '));
  const [overrides, setOverrides] = useState<Partial<Record<Platform, string>>>(
    video.caption_overrides,
  );
  const [tab, setTab] = useState<Platform>('instagram');
  const [ai, setAi] = useState(video.ai_generated);
  const [kids, setKids] = useState(video.made_for_kids);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tags = hashtags
    .split(/[\s,]+/)
    .map((t) => t.replace(/^#/, ''))
    .filter(Boolean);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v && v.trim()));
      await api.patch(`/videos/${video.id}`, {
        title,
        description,
        hashtags: tags,
        caption_overrides: clean,
        ai_generated: ai,
        made_for_kids: kids,
      });
      await inv(qk.videos(video.brand_id));
      setMsg('Kaydedildi');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Kaydedilemedi');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm('Video silinsin mi? Depolamadaki dosya da silinir.')) return;
    try {
      await api.del(`/videos/${video.id}`);
      await inv(qk.videos(video.brand_id), qk.brands);
      onClose();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Silinemedi');
    }
  };

  const preview = buildCaption(
    { title, description, hashtags: tags, caption_overrides: overrides },
    tab,
  );

  return (
    <div className="space-y-5">
      <div className="flex gap-4">
        <video
          src={`/api/media/video/${video.id}`}
          controls
          preload="metadata"
          className="h-80 w-44 shrink-0 rounded-lg bg-black object-contain"
        />
        <div className="min-w-0 flex-1 space-y-2 text-sm">
          <p className="text-slate-500">
            {formatBytes(video.size_bytes)} · {formatDuration(video.duration_ms)} · {video.width}×
            {video.height}
            {video.fps ? ` · ${Math.round(video.fps)} fps` : ''} · {video.video_codec ?? '?'} /{' '}
            {video.audio_codec ?? '—'}
          </p>
          {video.duplicate_warning && <Badge tone="amber">{video.duplicate_warning}</Badge>}
          <ValidationBadges validation={video.validation} />
          <ThumbnailPicker video={video} />
        </div>
      </div>

      <div className="grid gap-3">
        <Field label="Başlık (YouTube başlığı)">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            className={inputCls}
          />
        </Field>
        <Field label="Açıklama">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className={inputCls}
          />
        </Field>
        <Field label="Hashtag'ler" hint="Boşluk veya virgülle ayırın">
          <input
            value={hashtags}
            onChange={(e) => setHashtags(e.target.value)}
            className={inputCls}
          />
        </Field>
        <div>
          <Tabs
            value={tab}
            onChange={setTab}
            items={PLATFORMS.map((p) => ({
              value: p,
              label: (
                <span className="flex items-center gap-1.5">
                  <PlatformIcon platform={p} size={14} />
                  {PLATFORM_LABELS[p]}
                </span>
              ),
            }))}
          />
          <textarea
            value={overrides[tab] ?? ''}
            onChange={(e) => setOverrides((o) => ({ ...o, [tab]: e.target.value }))}
            rows={3}
            placeholder="Bu platform için özel metin (boşsa açıklama + hashtag'ler)"
            className={`${inputCls} mt-2`}
          />
          <p className="mt-1 whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-600">
            {preview || '—'}
          </p>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /> Yapay
            zekâ ile üretildi (platform etiketi)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={kids} onChange={(e) => setKids(e.target.checked)} />{' '}
            Çocuklara yönelik (YouTube)
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            Kaydet
          </Button>
          <Button variant="danger" onClick={() => void remove()}>
            Sil
          </Button>
          {msg && <span className="text-sm text-slate-600">{msg}</span>}
        </div>
      </div>

      <ScheduleForm video={video} />
      <VideoPosts videoId={video.id} />
    </div>
  );
}

function ThumbnailPicker({ video }: { video: VideoDTO }) {
  const inv = useInvalidate();
  const [t, setT] = useState(1);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const max = Math.max(1, Math.floor((video.duration_ms ?? 1000) / 1000));
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  const grab = async () => {
    setBusy(true);
    try {
      const blob = await captureFrame(`/api/media/video/${video.id}`, t);
      setPreview(URL.createObjectURL(blob));
      await uploadThumbnail(video.id, blob);
      await inv(qk.videos(video.brand_id));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-slate-200 p-2">
      <p className="mb-1 text-xs font-medium text-slate-600">Kapak karesi</p>
      <div className="flex items-center gap-2">
        {(preview ?? video.thumbnail_url) && (
          <img
            src={preview ?? video.thumbnail_url ?? ''}
            alt="Kapak"
            className="h-16 w-9 rounded object-cover"
          />
        )}
        <input
          type="range"
          min={0}
          max={max}
          step={0.5}
          value={t}
          onChange={(e) => setT(Number(e.target.value))}
          className="flex-1"
          aria-label="Kare saniyesi"
        />
        <span className="w-10 text-xs text-slate-500">{t} sn</span>
        <Button onClick={() => void grab()} disabled={busy}>
          Bu kareyi kullan
        </Button>
      </div>
    </div>
  );
}

function ScheduleForm({ video }: { video: VideoDTO }) {
  const { brand } = useBrand();
  const accounts = useAccounts(video.brand_id);
  const inv = useInvalidate();
  const connected = (accounts.data ?? [])
    .filter((a) => a.status === 'active')
    .map((a) => a.platform);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async () => {
    setMsg(null);
    try {
      await api.post('/posts/manual', { video_id: video.id, platforms, date, time });
      await inv(qk.videoPosts(video.id), qk.videos(video.brand_id), ['posts']);
      setMsg('Planlandı');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Planlanamadı');
    }
  };
  return (
    <section className="rounded-lg border border-slate-200 p-3">
      <h3 className="mb-2 text-sm font-semibold">Tarih ve saat seçerek planla</h3>
      <p className="mb-2 text-xs text-slate-500">
        Saat {brand?.timezone ?? 'Europe/Istanbul'} saat dilimindedir; zamanı gelince otomatik
        paylaşılır.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-2">
          {PLATFORMS.map((p) => {
            const ok = connected.includes(p) && video.validation?.[p].ok !== false;
            return (
              <label
                key={p}
                className={`flex items-center gap-1 text-sm ${ok ? '' : 'opacity-40'}`}
                title={ok ? '' : 'Hesap bağlı değil veya video uygun değil'}
              >
                <input
                  type="checkbox"
                  disabled={!ok}
                  checked={platforms.includes(p)}
                  onChange={(e) =>
                    setPlatforms((xs) =>
                      e.target.checked ? [...xs, p] : xs.filter((x) => x !== p),
                    )
                  }
                />
                <PlatformIcon platform={p} size={16} />
              </label>
            );
          })}
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={`${inputCls} w-40!`}
          aria-label="Tarih"
        />
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className={`${inputCls} w-28!`}
          aria-label="Saat"
        />
        <Button
          variant="primary"
          disabled={!platforms.length || !date || !time}
          onClick={() => void submit()}
        >
          Planla
        </Button>
      </div>
      {msg && <p className="mt-2 text-sm text-slate-600">{msg}</p>}
    </section>
  );
}

function VideoPosts({ videoId }: { videoId: string }) {
  const posts = useVideoPosts(videoId);
  if (!posts.data?.length) return null;
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">Paylaşımlar</h3>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
        {posts.data.map((p) => (
          <li key={p.id} className="flex items-center gap-2 px-3 py-2">
            <PlatformIcon platform={p.platform} size={16} />
            <span className="flex-1">{formatTr(p.scheduled_at)}</span>
            <StatusDot status={p.status} />
            <span className="text-xs text-slate-600">{POST_STATUS_LABELS[p.status]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
