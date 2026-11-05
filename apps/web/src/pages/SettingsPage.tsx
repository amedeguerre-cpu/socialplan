import { useState } from 'react';
import { PLATFORMS, type Platform, type SettingsDTO, type SlotDTO } from '@socialplan/shared';
import { api } from '../lib/api';
import { useBrand } from '../lib/brand';
import { qk, useInvalidate, useSettings, useSlots } from '../lib/hooks';
import { PlatformIcon } from '../components/PlatformIcon';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { Badge, Button, Field, inputCls, Modal } from '../components/ui';
import { AuditLog } from '../components/AuditLog';
import { TemplateManager } from '../components/Templates';
import type { WeeklyReportDTO } from '@socialplan/shared';

export const WEEKDAYS = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];

export function SettingsPage() {
  const s = useSettings();
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <SlotEditor />
      {s.isLoading ? (
        <Skeleton rows={6} />
      ) : s.error ? (
        <ErrorState error={s.error} onRetry={() => void s.refetch()} />
      ) : (
        s.data && <GlobalSettings s={s.data} />
      )}
      <TemplatesCard />
      <AuditLog />
    </div>
  );
}

function Card({
  title,
  children,
  desc,
}: {
  title: string;
  children: React.ReactNode;
  desc?: string;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {desc && <p className="mb-3 text-sm text-slate-500">{desc}</p>}
      <div className={desc ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

function SlotEditor() {
  const { brand, brandId } = useBrand();
  const slots = useSlots(brandId);
  const inv = useInvalidate();
  const [weekday, setWeekday] = useState(1);
  const [time, setTime] = useState('09:00');
  const [platforms, setPlatforms] = useState<Platform[]>(['instagram']);
  const [err, setErr] = useState<string | null>(null);
  if (!brandId) return <EmptyState title="Marka seçin" />;
  const refresh = () => inv(qk.slots(brandId), qk.brands);
  const add = async () => {
    setErr(null);
    try {
      await api.post('/slots', { brand_id: brandId, weekday, time_local: time, platforms });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Eklenemedi');
    }
  };
  const byDay = WEEKDAYS.map((_, i) => (slots.data ?? []).filter((x) => x.weekday === i + 1));
  return (
    <Card
      title={`Slotlar — ${brand?.name ?? ''}`}
      desc={`Haftalık paylaşım saatleri (${brand?.timezone}). "Kuyruğu doldur" bu slotlara sıradaki videoları atar.`}
    >
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <select
          value={weekday}
          onChange={(e) => setWeekday(Number(e.target.value))}
          className={`${inputCls} w-36!`}
          aria-label="Gün"
        >
          {WEEKDAYS.map((d, i) => (
            <option key={d} value={i + 1}>
              {d}
            </option>
          ))}
        </select>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value)}
          className={`${inputCls} w-28!`}
          aria-label="Saat"
        />
        {PLATFORMS.map((p) => (
          <label key={p} className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={platforms.includes(p)}
              onChange={(e) =>
                setPlatforms((xs) => (e.target.checked ? [...xs, p] : xs.filter((x) => x !== p)))
              }
            />
            <PlatformIcon platform={p} size={16} />
          </label>
        ))}
        <Button variant="primary" disabled={!platforms.length} onClick={() => void add()}>
          Slot ekle
        </Button>
        {err && <span className="text-sm text-red-600">{err}</span>}
      </div>
      {slots.isLoading ? (
        <Skeleton rows={3} />
      ) : (
        <div className="grid gap-2 sm:grid-cols-7">
          {byDay.map((list, i) => (
            <div key={i} className="rounded-lg bg-slate-50 p-2">
              <p className="mb-1 text-xs font-semibold text-slate-600">{WEEKDAYS[i]}</p>
              {list.length === 0 && <p className="text-xs text-slate-400">—</p>}
              {list.map((sl) => (
                <SlotChip key={sl.id} slot={sl} onChanged={refresh} />
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SlotChip({ slot, onChanged }: { slot: SlotDTO; onChanged: () => Promise<unknown> }) {
  return (
    <div
      className={`mb-1 flex items-center gap-1 rounded-md bg-white px-1.5 py-1 text-xs shadow-sm ${slot.active ? '' : 'opacity-50'}`}
    >
      <span className="font-medium">{slot.time_local}</span>
      {slot.platforms.map((p) => (
        <PlatformIcon key={p} platform={p} size={12} />
      ))}
      <span className="flex-1" />
      <button
        title={slot.active ? 'Pasifleştir' : 'Etkinleştir'}
        className="text-slate-400 hover:text-slate-700"
        onClick={() =>
          void api.patch(`/slots/${slot.id}`, { active: !slot.active }).then(onChanged)
        }
      >
        {slot.active ? '⏸' : '▶'}
      </button>
      <button
        title="Sil"
        className="text-slate-400 hover:text-red-600"
        onClick={() =>
          confirm('Slot silinsin mi?') && void api.del(`/slots/${slot.id}`).then(onChanged)
        }
      >
        ✕
      </button>
    </div>
  );
}

function GlobalSettings({ s }: { s: SettingsDTO }) {
  const inv = useInvalidate();
  const [confirmKill, setConfirmKill] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (patch: Partial<SettingsDTO>) => {
    setMsg(null);
    try {
      await api.put('/settings', patch);
      await inv(qk.settings);
      setMsg('Kaydedildi');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Kaydedilemedi');
    }
  };
  const test = async () => {
    try {
      const r = await api.post<{ slack?: boolean; telegram?: boolean }>('/notify/test');
      setMsg(
        `Deneme mesajı: Slack ${r.slack === undefined ? '—' : r.slack ? '✓' : '✗'}, Telegram ${r.telegram === undefined ? '—' : r.telegram ? '✓' : '✗'}`,
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Gönderilemedi');
    }
  };
  return (
    <>
      <Card title="Güvenlik" desc="Acil durdurma ve çalışma modu.">
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-3">
            <Badge tone={s.kill_switch ? 'red' : 'green'}>
              {s.kill_switch ? 'Kill switch AÇIK' : 'Kill switch kapalı'}
            </Badge>
            <Button
              variant={s.kill_switch ? 'secondary' : 'danger'}
              onClick={() =>
                s.kill_switch ? void save({ kill_switch: false }) : setConfirmKill(true)
              }
            >
              {s.kill_switch ? 'Kapat' : 'Tüm paylaşımları durdur'}
            </Button>
          </div>
          <p>
            DRY_RUN:{' '}
            <Badge tone={s.dry_run ? 'violet' : 'amber'}>
              {s.dry_run ? 'açık — platformlara istek gitmez' : 'kapalı — gerçek paylaşım'}
            </Badge>{' '}
            <span className="text-xs text-slate-500">
              (Worker değişkeni, buradan değiştirilemez)
            </span>
          </p>
          <p>
            ALLOWED_ACCOUNT_IDS:{' '}
            {s.allowed_account_ids.length ? (
              s.allowed_account_ids.join(', ')
            ) : (
              <span className="text-slate-500">boş (tüm hesaplar)</span>
            )}
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s.youtube_audited}
              onChange={(e) => void save({ youtube_audited: e.target.checked })}
            />
            YouTube API audit onayı alındı (kapalıyken videolar private yüklenir ve yalnız beyaz
            listedeki test kanalına izin verilir)
          </label>
        </div>
      </Card>
      <Card
        title="Bakım"
        desc="Anahtar döndürme sonrası token'ları yeni TOKEN_ENC_KEY ile yeniden şifreleyin; günlük işleri elle çalıştırın."
      >
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              void api
                .post<{ rotated: number; total: number; failed: string[] }>('/system/rotate-tokens')
                .then((r) =>
                  setMsg(
                    `${r.rotated}/${r.total} token yeniden şifrelendi${r.failed.length ? `, ${r.failed.length} başarısız` : ''}`,
                  ),
                )
                .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Başarısız'))
            }
          >
            Token'ları yeniden şifrele
          </Button>
          <Button
            onClick={() =>
              void api
                .post<Record<string, number>>('/system/run-daily')
                .then((r) =>
                  setMsg(
                    `Günlük işler: ${Object.entries(r)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(', ')}`,
                  ),
                )
                .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Başarısız'))
            }
          >
            Günlük işleri şimdi çalıştır
          </Button>
        </div>
      </Card>
      <Card title="Zamanlama">
        <form
          className="grid gap-3 sm:grid-cols-3"
          action={(fd) =>
            void save({
              missed_slot_grace_min: Number(fd.get('grace')),
              autofill_default_days: Number(fd.get('days')),
              retention_days: Number(fd.get('retention')),
            })
          }
        >
          <Field
            label="Kaçırılan slot toleransı (dk)"
            hint="Bu süreden geç kalan paylaşım otomatik yapılmaz"
          >
            <input
              name="grace"
              type="number"
              min={1}
              max={1440}
              defaultValue={s.missed_slot_grace_min}
              className={inputCls}
            />
          </Field>
          <Field label="Doldurma varsayılanı (gün)">
            <input
              name="days"
              type="number"
              min={1}
              max={60}
              defaultValue={s.autofill_default_days}
              className={inputCls}
            />
          </Field>
          <Field
            label="Video saklama (gün)"
            hint="Tüm platformlarda yayınlandıktan sonra dosya silinir; kapak kalır"
          >
            <input
              name="retention"
              type="number"
              min={1}
              max={365}
              defaultValue={s.retention_days}
              className={inputCls}
            />
          </Field>
          <div className="sm:col-span-3">
            <Button type="submit" variant="primary">
              Kaydet
            </Button>
          </div>
        </form>
      </Card>
      <Card
        title="Bildirimler"
        desc="Yayın hatası, işlem gerekli, token düşmesi, kuyruk azalması, kill switch, TikTok taslağı hatırlatması."
      >
        <div className="space-y-2 text-sm">
          <label
            className={`flex items-center gap-2 ${s.notify_available.slack ? '' : 'opacity-50'}`}
          >
            <input
              type="checkbox"
              disabled={!s.notify_available.slack}
              checked={s.notify.slack}
              onChange={(e) => void save({ notify: { ...s.notify, slack: e.target.checked } })}
            />
            Slack {s.notify_available.slack ? '' : '(SLACK_WEBHOOK_URL tanımlı değil)'}
          </label>
          <label
            className={`flex items-center gap-2 ${s.notify_available.telegram ? '' : 'opacity-50'}`}
          >
            <input
              type="checkbox"
              disabled={!s.notify_available.telegram}
              checked={s.notify.telegram}
              onChange={(e) => void save({ notify: { ...s.notify, telegram: e.target.checked } })}
            />
            Telegram{' '}
            {s.notify_available.telegram
              ? ''
              : '(TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID tanımlı değil)'}
          </label>
          <Button onClick={() => void test()} disabled={!s.notify.slack && !s.notify.telegram}>
            Deneme mesajı gönder
          </Button>
          <WeeklyReport
            enabled={s.weekly_report}
            onToggle={(v) => void save({ weekly_report: v })}
          />
        </div>
      </Card>
      {msg && <p className="text-sm text-slate-600">{msg}</p>}
      <Modal
        open={confirmKill}
        onClose={() => setConfirmKill(false)}
        title="Tüm paylaşımlar durdurulsun mu?"
      >
        <p className="text-sm text-slate-600">
          Kill switch açıkken cron yeni paylaşım başlatmaz ve devam edenler bir sonraki dış çağrıdan
          önce durur ("İşlem gerekli"). İşlem audit log'a yazılır.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setConfirmKill(false)}>Vazgeç</Button>
          <Button
            variant="danger"
            onClick={() => void save({ kill_switch: true }).then(() => setConfirmKill(false))}
          >
            Durdur
          </Button>
        </div>
      </Modal>
    </>
  );
}

function TemplatesCard() {
  const { brand, brandId } = useBrand();
  if (!brandId) return null;
  return (
    <Card
      title={`Metin şablonları ve hashtag setleri — ${brand?.name ?? ''}`}
      desc="Video detayında platform sekmesinden uygulanır. Marka imzası: Marka ayarları."
    >
      <TemplateManager brandId={brandId} />
    </Card>
  );
}

function WeeklyReport({ enabled, onToggle }: { enabled: boolean; onToggle: (v: boolean) => void }) {
  const { brandId } = useBrand();
  const [preview, setPreview] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />{' '}
        Haftalık özet (her pazartesi 09:05, marka başına)
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!brandId}
          onClick={() =>
            void api
              .get<WeeklyReportDTO>(`/reports/weekly?brand_id=${brandId}`)
              .then((r) => setPreview(r.text))
          }
        >
          Bu markanın özetini önizle
        </Button>
        <Button
          disabled={!brandId}
          onClick={() =>
            void api
              .post<{ sent: number }>('/reports/weekly/send', { brand_id: brandId })
              .then((r) =>
                setMsg(
                  r.sent ? 'Özet gönderildi' : 'Gönderilmedi (bildirim kanalı kapalı olabilir)',
                ),
              )
              .catch((e: unknown) => setMsg(e instanceof Error ? e.message : 'Gönderilemedi'))
          }
        >
          Şimdi gönder
        </Button>
        {msg && <span className="text-slate-600">{msg}</span>}
      </div>
      {preview && (
        <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
          {preview}
        </pre>
      )}
    </div>
  );
}
