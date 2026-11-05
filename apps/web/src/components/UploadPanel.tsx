import { useRef, useState } from 'react';
import { validateVideo, type ValidationResult, type VideoMeta } from '@socialplan/shared';
import { captureFrame, probeVideo, sampledHash } from '../lib/media';
import { uploadVideoFile } from '../lib/upload';
import { qk, useInvalidate } from '../lib/hooks';
import { Button, formatBytes } from './ui';
import { ValidationBadges } from './ValidationBadges';

interface Item {
  key: string;
  file: File;
  meta: VideoMeta | null;
  validation: ValidationResult | null;
  hash: string | null;
  thumb: Blob | null;
  thumbUrl?: string;
  ai: boolean | null;
  state: 'probing' | 'pending' | 'uploading' | 'done' | 'error';
  progress: number;
  error?: string;
  warning?: string | null;
}

export function UploadPanel({ brandId }: { brandId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const inv = useInvalidate();
  const update = (key: string, patch: Partial<Item>) =>
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const addFiles = (files: FileList | File[]) => {
    const list = [...files].filter(
      (f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(f.name),
    );
    const fresh: Item[] = list.map((file) => ({
      key: crypto.randomUUID(),
      file,
      meta: null,
      validation: null,
      hash: null,
      thumb: null,
      ai: null,
      state: 'probing',
      progress: 0,
    }));
    setItems((xs) => [...xs, ...fresh]);
    for (const it of fresh) {
      void (async () => {
        try {
          const meta = await probeVideo(it.file);
          const [hash, thumb] = await Promise.all([
            sampledHash(it.file),
            captureFrame(it.file, 1).catch(() => null),
          ]);
          update(it.key, {
            meta,
            hash,
            thumb,
            thumbUrl: thumb ? URL.createObjectURL(thumb) : undefined,
            validation: validateVideo(meta),
            state: 'pending',
          });
        } catch (e) {
          update(it.key, { state: 'error', error: e instanceof Error ? e.message : 'Okunamadı' });
        }
      })();
    }
  };

  const pending = items.filter((i) => i.state === 'pending');
  const canStart = pending.length > 0 && pending.every((i) => i.ai !== null);

  const start = async () => {
    const queue = [...pending];
    // Dosyalar sırayla (kuyruk sırası korunur), her dosyanın parçaları paralel.
    for (const it of queue) {
      update(it.key, { state: 'uploading', progress: 0 });
      try {
        const v = await uploadVideoFile({
          brandId,
          file: it.file,
          meta: it.meta as VideoMeta,
          contentHash: it.hash ?? undefined,
          aiGenerated: it.ai === true,
          thumbnail: it.thumb,
          onProgress: (l, t) => update(it.key, { progress: t ? l / t : 0 }),
          onInit: (init) =>
            init.duplicate_warning && update(it.key, { warning: init.duplicate_warning }),
        });
        update(it.key, { state: 'done', progress: 1, warning: v.duplicate_warning });
      } catch (e) {
        update(it.key, {
          state: 'error',
          error: e instanceof Error ? e.message : 'Yükleme başarısız',
        });
      }
      await inv(qk.videos(brandId), qk.brands);
    }
  };

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center text-sm ${drag ? 'border-brand-500 bg-brand-50' : 'border-slate-300'}`}
      >
        <p className="font-medium text-slate-700">Videoları buraya sürükleyin</p>
        <p className="text-slate-500">MP4 / MOV / WebM — doğrudan depolamaya yüklenir</p>
        <Button className="mt-3" onClick={() => input.current?.click()}>
          Dosya seç
        </Button>
        <input
          ref={input}
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
      </div>

      {items.length > 0 && (
        <div className="mt-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{items.length} dosya</span>
            {pending.length > 0 && (
              <>
                <span className="text-slate-500">Tümü için "Yapay zekâ ile üretildi mi?":</span>
                <Button
                  onClick={() =>
                    setItems((xs) =>
                      xs.map((x) => (x.state === 'pending' ? { ...x, ai: false } : x)),
                    )
                  }
                >
                  Hayır
                </Button>
                <Button
                  onClick={() =>
                    setItems((xs) =>
                      xs.map((x) => (x.state === 'pending' ? { ...x, ai: true } : x)),
                    )
                  }
                >
                  Evet
                </Button>
              </>
            )}
            <span className="flex-1" />
            <Button
              variant="ghost"
              onClick={() => setItems((xs) => xs.filter((x) => x.state !== 'done'))}
            >
              Bitenleri temizle
            </Button>
            <Button
              variant="primary"
              disabled={!canStart}
              onClick={() => void start()}
              title={canStart ? '' : 'Her video için yapay zekâ seçimi zorunlu'}
            >
              Yüklemeyi başlat
            </Button>
          </div>
          {items.map((it) => (
            <div
              key={it.key}
              className="flex items-center gap-3 rounded-lg border border-slate-100 p-2"
            >
              <div className="h-14 w-8 shrink-0 overflow-hidden rounded bg-slate-100">
                {it.thumbUrl && (
                  <img src={it.thumbUrl} alt="" className="h-full w-full object-cover" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{it.file.name}</p>
                <p className="text-xs text-slate-500">
                  {formatBytes(it.file.size)}
                  {it.meta?.width && ` · ${it.meta.width}×${it.meta.height}`}
                  {it.meta?.fps && ` · ${Math.round(it.meta.fps)} fps`}
                  {it.meta?.videoCodec && ` · ${it.meta.videoCodec}`}
                </p>
                {it.state === 'uploading' && (
                  <div className="mt-1 h-1.5 w-full rounded bg-slate-100">
                    <div
                      className="h-1.5 rounded bg-brand-500"
                      style={{ width: `${Math.round(it.progress * 100)}%` }}
                    />
                  </div>
                )}
                {it.error && <p className="text-xs text-red-600">{it.error}</p>}
                {it.warning && <p className="text-xs text-amber-700">{it.warning}</p>}
              </div>
              <ValidationBadges validation={it.validation} compact />
              {it.state === 'pending' && (
                <fieldset className="flex items-center gap-2 text-xs">
                  <legend className="sr-only">Yapay zekâ ile üretildi mi?</legend>
                  <span className="text-slate-500">YZ?</span>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`ai-${it.key}`}
                      checked={it.ai === false}
                      onChange={() => update(it.key, { ai: false })}
                    />{' '}
                    Hayır
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="radio"
                      name={`ai-${it.key}`}
                      checked={it.ai === true}
                      onChange={() => update(it.key, { ai: true })}
                    />{' '}
                    Evet
                  </label>
                </fieldset>
              )}
              <span className="w-24 text-right text-xs text-slate-500">
                {
                  {
                    probing: 'İnceleniyor…',
                    pending: 'Hazır',
                    uploading: `%${Math.round(it.progress * 100)}`,
                    done: 'Yüklendi ✓',
                    error: 'Hata',
                  }[it.state]
                }
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
