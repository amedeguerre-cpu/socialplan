# SocialPlan — Plan

Dahili sosyal video planlayıcı ("kendi Buffer'ımız"). Kısa dikey videoları markalar için kuyruğa alır, slotlara/elle seçilen tarihlere dağıtır ve saati gelince **Instagram Reels**, **YouTube Shorts** ve **TikTok (taslağa gönder)** hesaplarına gönderir.

## Sabit kararlar

| Konu                 | Karar                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ücretli API          | **Yok.** X/Twitter kapsam dışı.                                                                                                                                                  |
| Resmi olmayan yollar | Yazılmaz (tarayıcı otomasyonu, şifreyle giriş, çerezli gizli API yok).                                                                                                           |
| Barındırma           | Cloudflare Workers Paid ($5/ay) — tek Worker: Hono API + statik panel + cron + Queue tüketicisi.                                                                                 |
| Veri                 | D1 (ham SQL, ORM yok), R2 (videolar/thumbnail), Queues (yayın hattı + DLQ).                                                                                                      |
| Kimlik               | Cloudflare Access JWT'si her `/api` isteğinde doğrulanır (JWKS, iss, aud).                                                                                                       |
| Instagram            | Instagram API with Instagram Login (graph.instagram.com, v26.0, sürüm tek sabitte). Reels container → poll → publish → permalink.                                                |
| YouTube              | Data API v3 resumable upload; `youtube_audited=false` iken **private** ve yalnız `ALLOWED_ACCOUNT_IDS` kanalına.                                                                 |
| TikTok               | **Upload/inbox modu** (video.upload): video hesabın gelen kutusuna gider, kullanıcı uygulamadan yayınlar; panelden "Yayınladım" ya da webhook ile kapanır. Direct Post yazılmaz. |
| Güvenlik             | Token'lar AES-256-GCM ile şifreli, asla loglanmaz/frontend'e gitmez. Tek dış HTTP istemcisi, DRY_RUN'da platform isteklerini reddeder.                                           |
| Dil                  | Arayüz ve doküman Türkçe; kod adları İngilizce.                                                                                                                                  |

## Mimari

```
apps/api      Tek Worker (Hono). src/index.ts → fetch / scheduled / queue
  src/routes      REST uçları (/api/*), /webhooks/tiktok
  src/auth        Access JWT + Origin kontrolü
  src/publish     http.ts (tek dış istemci), orchestrator, publisher'lar (instagram, youtube, tiktok, dryrun)
  src/scheduler   cron tick, doldurma, reaper, günlük işler
  src/lib         db yardımcıları, kripto, R2 presign, log, bildirim
  migrations      D1 SQL
apps/web      React 19 + Vite + Tailwind v4 + TanStack Query + React Router + dnd-kit + Recharts
packages/shared Tipler, zod şemaları, durum makinesi, platform limit tablosu, saat yardımcıları
```

### Publisher sözleşmesi

```ts
step(ctx, state) → { kind:'continue', state, waitSeconds? }
                 | { kind:'done', externalId, url, visibility?, state? }
                 | { kind:'inbox', state }              // TikTok: taslağa gönderildi
                 | { kind:'error', class:'transient'|'permanent'|'action', code, message, retryAfterSec? }
validate(video, account) · reconcile(ctx, state) · classifyError · refreshToken · fetchMetrics
```

Her adım sonunda `platform_state` D1'e yazılır; sonraki adım `delaySeconds` ile yeni Queue mesajıdır. Worker içinde `sleep` yoktur.

### Durum makinesi

`draft → scheduled → processing → published`
`processing → inbox_sent → published` (TikTok)
`processing → needs_action | failed` · her yerden `cancelled` · `needs_action|failed → scheduled` (insan).
Tek kaynak: `packages/shared/src/stateMachine.ts`.

### Garantiler

- Kilit tek koşullu `UPDATE` (lease_owner + lease_until); `changes = 1` değilse bırak.
- Hata sınıfları: transient → 1/5/25 dk + jitter (Retry-After'a uy), 3. denemeden sonra `failed`; permanent → `failed`; action → `needs_action` + bildirim.
- Commit koruması: geri dönüşsüz çağrıdan önce `commit_started_at`; devamda doluysa `reconcile`, belirsizse `needs_action`, asla kör retry.
- `UNIQUE (video_id, account_id) WHERE status <> 'cancelled'` → aynı video aynı hesaba iki kez planlanamaz.
- Reaper: lease'i dolmuş `processing` post'ları yeniden kuyruğa alır.

### Zamanlama

- Marka başına FIFO kuyruk (`queue_position` kesirli sıralama).
- Slot tabanlı "Kuyruğu doldur" (N gün, tek `batch()`), günlük otomatik doldurma (marka ayarı), elle tarih-saat.
- Cron her dakika: due post'lar → kilit → Queue; paused/kill switch → atla; tolerans aşıldıysa `needs_action: missed_slot`; reaper; token yenileme; günlük işler (İstanbul 04:10): otomatik doldurma, kuyruk uyarısı, metrik, retention.

## Fazlar

| Faz | İçerik                                                                                                                                                    | Bitti kriteri                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 0   | İskelet: monorepo, wrangler config, migration, Access, Hono, panel kabuğu, CLAUDE.md, `pnpm check`                                                        | wrangler dev çalışır, panel açılır, Access'siz `/api` 401, RETURNING denemesi CLAUDE.md'de |
| 1   | Marka, video, kuyruk: CRUD, presigned multipart, doğrulama, thumbnail, sıralama, caption override                                                         | 10 video yüklenip sıralanabilir (yerel R2)                                                 |
| 2   | Zamanlayıcı: slot, doldurma, elle tarih, cron, Queue, durum makinesi, kilit, retry, kill switch, kaçırılan slot, DryRun, şimdi paylaş, post_events, liste | post'lar zamanında "yayınlandı (dry-run)"                                                  |
| 3   | Instagram                                                                                                                                                 | mock testleri; README'de gerçek deneme adımları                                            |
| 4   | TikTok (inbox)                                                                                                                                            | mock testleri                                                                              |
| 5   | YouTube                                                                                                                                                   | mock testleri; README'de audit başvurusu                                                   |
| 6   | Takvim paneli, detay paneli, liste                                                                                                                        | bir hafta panelden planlanabilir (DRY_RUN)                                                 |
| 7   | Metrikler ve analiz                                                                                                                                       | mock verilerle grafikler/ısı haritası                                                      |
| 8   | Sağlamlaştırma: bildirimler, audit ekranı, README, anahtar döndürme, yedek notu                                                                           | README ile sıfırdan kurulum                                                                |

İlk gerçek testler **tek marka ve tek hesapla** (`ALLOWED_ACCOUNT_IDS`) yapılır.

## Maliyet

API ücreti 0. Workers Paid $5/ay + R2 (~60 GB, 30 gün retention) ≈ $0.75 → **≈ $5–6/ay**. Free plan (10 ms CPU, 50 alt istek, R2 10 GB) yayın hattı için yetersiz kalma riski taşır.
