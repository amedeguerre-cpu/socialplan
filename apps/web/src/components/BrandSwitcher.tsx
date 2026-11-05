import { useState } from 'react';
import type { BrandDTO } from '@socialplan/shared';
import { useBrand } from '../lib/brand';
import { api } from '../lib/api';
import { qk, useInvalidate } from '../lib/hooks';
import { PlatformIcon } from './PlatformIcon';
import { Button, Field, inputCls, Modal } from './ui';

export function BrandAvatar({
  brand,
  size = 28,
}: {
  brand: Pick<BrandDTO, 'name' | 'color' | 'avatar_url'>;
  size?: number;
}) {
  if (brand.avatar_url)
    return (
      <img
        src={brand.avatar_url}
        alt=""
        className="rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: brand.color, fontSize: size * 0.42 }}
    >
      {brand.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function QueueBadge({ brand }: { brand: BrandDTO }) {
  const low = brand.queue_days_left !== null && brand.queue_days_left < 3;
  return (
    <span
      className={`text-xs ${low ? 'font-medium text-amber-700' : 'text-slate-500'}`}
      title={
        brand.queue_days_left !== null
          ? `Kuyruk ≈ ${brand.queue_days_left} gün yeter`
          : 'Slot tanımlı değil'
      }
    >
      {brand.queue_count} sırada{low ? ' ⚠' : ''}
    </span>
  );
}

export function BrandSwitcher() {
  const { brands, brand, setBrandId } = useBrand();
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<'new' | 'edit' | null>(null);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1 hover:bg-slate-50"
        aria-haspopup="listbox"
      >
        {brand ? (
          <>
            <BrandAvatar brand={brand} size={24} />
            <span className="max-w-[10rem] truncate text-sm font-medium">{brand.name}</span>
            <span className="hidden gap-0.5 sm:flex">
              {brand.platforms.map((p) => (
                <PlatformIcon key={p} platform={p} size={14} />
              ))}
            </span>
            <QueueBadge brand={brand} />
          </>
        ) : (
          <span className="text-sm text-slate-500">Marka seçin</span>
        )}
        <span className="text-slate-400">▾</span>
      </button>
      {open && (
        <div
          className="absolute left-0 z-30 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-1 shadow-lg"
          role="listbox"
        >
          {brands.map((b) => (
            <button
              key={b.id}
              role="option"
              aria-selected={b.id === brand?.id}
              onClick={() => {
                setBrandId(b.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-50 ${b.id === brand?.id ? 'bg-brand-50' : ''}`}
            >
              <BrandAvatar brand={b} size={22} />
              <span className="min-w-0 flex-1 truncate">{b.name}</span>
              {b.paused && <span className="text-xs text-amber-700">duraklatıldı</span>}
              <QueueBadge brand={b} />
            </button>
          ))}
          <div className="mt-1 flex gap-1 border-t border-slate-100 pt-1">
            <Button
              variant="ghost"
              className="flex-1"
              onClick={() => (setModal('new'), setOpen(false))}
            >
              + Marka ekle
            </Button>
            {brand && (
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => (setModal('edit'), setOpen(false))}
              >
                Marka ayarları
              </Button>
            )}
          </div>
        </div>
      )}
      <BrandModal
        mode={modal}
        brand={modal === 'edit' ? brand : null}
        onClose={() => setModal(null)}
        onCreated={(id) => setBrandId(id)}
      />
    </div>
  );
}

function BrandModal({
  mode,
  brand,
  onClose,
  onCreated,
}: {
  mode: 'new' | 'edit' | null;
  brand: BrandDTO | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const inv = useInvalidate();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!mode) return null;
  const submit = async (fd: FormData) => {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        name: String(fd.get('name') ?? ''),
        color: String(fd.get('color') ?? '#6366f1'),
        timezone: String(fd.get('timezone') ?? 'Europe/Istanbul'),
      };
      if (mode === 'new') {
        const b = await api.post<BrandDTO>('/brands', body);
        onCreated(b.id);
      } else if (brand) {
        await api.patch(`/brands/${brand.id}`, {
          ...body,
          paused: fd.get('paused') === 'on',
          autofill_enabled: fd.get('autofill_enabled') === 'on',
          autofill_days: Number(fd.get('autofill_days') ?? 7),
        });
      }
      await inv(qk.brands);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open title={mode === 'new' ? 'Marka ekle' : 'Marka ayarları'} onClose={onClose}>
      <form action={(fd) => void submit(fd)} className="space-y-3">
        <Field label="Ad">
          <input name="name" required defaultValue={brand?.name} className={inputCls} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Renk">
            <input
              name="color"
              type="color"
              defaultValue={brand?.color ?? '#6366f1'}
              className="h-9 w-full rounded border border-slate-300"
            />
          </Field>
          <Field label="Saat dilimi">
            <input
              name="timezone"
              defaultValue={brand?.timezone ?? 'Europe/Istanbul'}
              className={inputCls}
            />
          </Field>
        </div>
        {brand && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="paused" defaultChecked={brand.paused} /> Markayı duraklat
              (yeni paylaşım başlamaz)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="autofill_enabled"
                defaultChecked={brand.autofill_enabled}
              />{' '}
              Günlük otomatik doldurma
            </label>
            <Field label="Otomatik doldurma (gün)">
              <input
                name="autofill_days"
                type="number"
                min={1}
                max={60}
                defaultValue={brand.autofill_days}
                className={inputCls}
              />
            </Field>
          </>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" onClick={onClose}>
            Vazgeç
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Kaydet
          </Button>
        </div>
      </form>
    </Modal>
  );
}
