# CLAUDE.md — SocialPlan

Dahili sosyal video planlayıcı (Instagram Reels, YouTube Shorts, TikTok taslağa gönder). Plan: `PLAN.md`. Kurulum: `README.md`.
Kullanıcıyla ve dokümanda **Türkçe**; kod adları İngilizce.

## Değişmez kurallar

- Ücretli API yok; X/Twitter yok; resmi olmayan yollar (tarayıcı otomasyonu, şifreyle giriş, çerezli gizli API) yazılmaz.
- Gerçek platforma istek atılmaz; gerçek hesap/secret uydurulmaz. Geliştirme: `wrangler dev`, Miniflare/vitest, mock, `DRY_RUN`.
- Kesinleşmeyen platform davranışı kodda `TODO(doğrula)` ve aşağıdaki listede.
- Token'lar asla loglanmaz, asla panele gönderilmez (DTO testleri denetler).
- Worker'da dış istek yalnız `apps/api/src/publish/http.ts` üzerinden (ESLint `no-restricted-globals: fetch`).
- Durum geçişlerinin tek kaynağı `packages/shared/src/stateMachine.ts`.

## Komutlar

```bash
pnpm install
pnpm check                 # typecheck + lint + prettier --check + test (tüm paketler)
pnpm dev                   # paneli derler (apps/api/public) + wrangler dev :8787
pnpm dev:web               # Vite :5173 (/api → :8787 proxy)
pnpm --filter @socialplan/api db:migrate:local
pnpm --filter @socialplan/api test
pnpm format
```

Yerel: `apps/api/.dev.vars.example` → `.dev.vars` (ACCESS_DEV_BYPASS yalnız localhost'ta geçerli).

## Dosya yapısı

```
apps/api/            Tek Worker (Hono)
  wrangler.jsonc     D1 (DB), R2 (MEDIA), Queue (PUBLISH_QUEUE + DLQ), cron * * * * *, assets (SPA, run_worker_first /api/*, /webhooks/*)
  migrations/        D1 SQL (0001_init.sql)
  src/index.ts       fetch / scheduled / queue
  src/app.ts         Hono: güvenli yapılandırma denetimi → /api (Access + Origin) → ASSETS
  src/env.ts         Env tipi, DRY_RUN, ALLOWED_ACCOUNT_IDS, assertSafeConfig
  src/auth/access.ts Access JWT (jose, JWKS, iss+aud), Origin kontrolü
  src/lib/           db (ham SQL), crypto (AES-GCM), log (maske), settings, audit, errors
  src/publish/       http.ts (tek istemci), consumer, orchestrator, publisher'lar
  src/scheduler/     cron, doldurma, reaper
  test/              vitest (@cloudflare/vitest-plugin), helpers.ts (JWT imzalama, api())
apps/web/            React 19 + Vite 8 + Tailwind v4 + TanStack Query + React Router 7 (build → apps/api/public)
packages/shared/     platform limitleri, durum makinesi, saat, doğrulama, zod şemaları, DTO'lar, caption
```

## Mimari kararlar

- **Tek Worker**: API + statik panel + cron + Queue tüketicisi. Statik varlıklar Workers static assets (SPA).
- **Yayın hattı Cloudflare Queues**: her adım ayrı mesaj (`delaySeconds`), adım sonunda `platform_state` D1'e yazılır; Worker içinde sleep yok.
- **ORM yok**: `lib/db.ts` ince yardımcılar. D1 etkileşimli transaction yok → `batch()` (atomik) + koşullu UPDATE.
- **Saatler**: DB'de UTC ISO; slotlar marka saat diliminde `HH:MM` (`shared/time.ts`, Intl tabanlı, DST güvenli).
- **Kimlik**: Her `/api` isteğinde Access JWT; `ACCESS_DEV_BYPASS` yalnız `APP_BASE_URL` yerelken ve istek localhost'tan geliyorsa; aksi hâlde Worker 500 `misconfigured` döner (scheduled/queue de çalışmaz). Durum değiştiren isteklerde Origin = kendi origin veya APP_BASE_URL.
- **Token şifreleme**: AES-256-GCM, 12 bayt IV, biçim `v<sürüm>.<iv>.<ct>`; `TOKEN_ENC_KEY` "sürüm:base64" (ön eksiz = sürüm 1), çözmede `TOKEN_ENC_KEY_PREV` de denenir.
- **Testlerde** dış HTTP `setTransportForTesting`, JWKS `setJwksForTesting` ile verilir; `app.fetch` doğrudan çağrılır (aynı modül örneği).
- **Sürümler**: TypeScript 6.0 (typescript-eslint <6.1 desteği), ESLint 9, Vitest 4.1, @cloudflare/vitest-plugin 1.5.1, wrangler 4.157, Vite 8, React 19, React Router 7, zod 4.

## Faz 0 bulguları

- **D1 `UPDATE … RETURNING` çalışıyor** (Miniflare/workerd 2026-11; `test/d1.test.ts`). Yine de kilit için `meta.changes` kullanılıyor (belgeli davranış).
- `batch()` atomik: bir ifade düşerse hepsi geri alınıyor (test).
- Kısmi UNIQUE indeks (`WHERE status <> 'cancelled'`) D1'de çalışıyor (test).

## Secret / ortam değişkenleri

| Ad                                                               | Tür              | Not                                                |
| ---------------------------------------------------------------- | ---------------- | -------------------------------------------------- |
| ACCESS_TEAM_DOMAIN, ACCESS_AUD                                   | var              | Access takım alanı ve uygulama AUD etiketi         |
| APP_BASE_URL                                                     | var              | panel adresi (OAuth redirect tabanı)               |
| DRY_RUN                                                          | var              | `false` dışındaki her değer = açık                 |
| ALLOWED_ACCOUNT_IDS                                              | var              | virgüllü; iç id veya platform external_id          |
| R2_ACCOUNT_ID, R2_BUCKET                                         | var              | presigned URL için S3 uç noktası                   |
| GOOGLE_CLIENT_ID, IG_APP_ID, TIKTOK_CLIENT_KEY, TELEGRAM_CHAT_ID | var              |                                                    |
| ACCESS_DEV_BYPASS                                                | yalnız .dev.vars | production'da tanımlıysa Worker açılmaz            |
| TOKEN_ENC_KEY, TOKEN_ENC_KEY_PREV                                | secret           | 32 bayt base64, isteğe bağlı `N:` sürüm ön eki     |
| R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY                           | secret           | yoksa (yerel) yükleme Worker üzerinden yerel R2'ye |
| GOOGLE_CLIENT_SECRET, IG_APP_SECRET, TIKTOK_CLIENT_SECRET        | secret           |                                                    |
| SLACK_WEBHOOK_URL, TELEGRAM_BOT_TOKEN                            | secret           |                                                    |

## Tamamlanan fazlar

- [x] Faz 0 — iskelet
- [x] Faz 6 — Panel: haftalık takvim (saat satırları, hafta gezinme, arama, dnd-kit sürükle-bırak → PATCH scheduled_at; hata/işlem gerekli post taşınınca yeniden planlanır; boş slot kutusu → video ata; en iyi saatler pembe), detay paneli (platform sekmeleri, metin, Şimdi paylaş, İptal, Tekrar dene, Yayınladım, YouTube public yap, olay geçmişi), liste (filtre, sayfalama, toplu iptal/tekrar dene). Playwright ile uçtan uca denendi (yükleme → slot → doldur → takvim → sürükle-bırak)
- [x] Faz 5 — YouTube: OAuth (PKCE, offline, consent select_account, channels.list mine=true), kota defteri (Pasifik günü, uploads 100), audit bayrağı (false: private + yalnız beyaz liste), resumable upload (8 MiB, 308/Range, kesintide boş PUT, 404 → yeni oturum), reconcile (boş PUT / yüklemeler listesi), madeForKids + containsSyntheticMedia, audit sonrası "public yap"
- [x] Faz 4 — TikTok (inbox): OAuth (Login Kit, state), creator_info (scope yoksa atlanır), FILE_UPLOAD init + parçalı PUT (10 MiB, son parça kalanı emer, adım başına 4 parça, 403 → yeniden init), status/fetch, reconcile, webhook (imza + idempotent), "Yayınladım", hatırlatma, metin kopyala
- [x] Faz 3 — Instagram: OAuth (Instagram Login, kısa → uzun token), limit → container (video_url/resumable) → yoklama → media_publish (commit) → permalink, reconcile (container PUBLISHED + caption/zaman eşleşmesi), token yenileme, kapak + share_to_feed + AI etiketi, Hesaplar sayfası
- [x] Faz 2 — slotlar, doldurma (tek batch), elle tarih-saat, cron, Queue orkestratörü, durum makinesi, kilit, retry, kill switch, kaçırılan slot, DryRun, şimdi paylaş, post_events, liste görünümü, ayarlar sayfası, audit log
- [x] Faz 1 — marka CRUD, presigned multipart yükleme (S3 anahtarı yoksa yerel /api/uploads/local/*), doğrulama, thumbnail, kuyruk sıralama (kesirli), caption override, yinelenen içerik uyarısı, medya akışı (Range)

## Yayın hattı (Faz 2)

- Cron (`scheduler/cron.ts`): kill switch kapalıysa due post'ları (`scheduled_at <= now`, marka duraklatılmamış) kilitler (`lease_owner = cron:<uuid>`) ve `sendBatch`; tolerans (`missed_slot_grace_min`) aşıldıysa `needs_action: missed_slot`. Ardından reaper, TikTok hatırlatması, token yenileme; İstanbul 04:10'da günlük işler (`scheduler/daily.ts`).
- Mesaj: `{ postId, traceId, leaseOwner }`. Tüketici aynı sahiple kilidi yeniler (`acquireLease`), adımı yürütür, sonucu `WHERE status='processing' AND lease_owner=?` ile yazar.
- Geçici hata: post `processing` kalır, `attempt_count` artar, mesaj 1/5/25 dk (+%0–20 jitter, Retry-After) gecikmeyle yeniden gönderilir; 3 yeniden denemeden sonraki hata (`attempt_count > 3`) → `failed`.
- `AUTH_EXPIRED` kodu: orkestratör token'ı yeniler ve adımı bir kez tekrarlar; yenileme başarısızsa hesap `reconnect`, post `needs_action`.
- Commit koruması: publisher geri dönüşsüz çağrıdan önce `ctx.beginCommit(state)` (commit_started_at + `commitPending: true`) çağırır; devam eden mesajda `commitPending` ise `reconcile` çalışır.
- Kill switch: `guardedHttp` her dış çağrıdan önce D1'den okur → `KillSwitchError` → `needs_action: kill_switch`.
- Lease = adım beklemesi + 15 dk; reaper süresi dolanları `reaper:<uuid>` sahibiyle yeniden kuyruğa alır.
- DRY_RUN publisher: prepare → upload (1–4 parça) → processing → commit. Instagram/YouTube `published` (visibility `dry-run`, URL `https://dry-run.invalid/...`), TikTok gerçek akıştaki gibi `inbox_sent`.
- DRY_RUN'da `POST /api/accounts/demo` OAuth'suz demo hesap ekler (paneli denemek için).
- Yerel cron tetikleme: `wrangler dev --test-scheduled` + `curl "localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`. Elle günlük işler: `POST /api/system/run-daily`.
- Testlerde depolama dosya içi testler arasında paylaşımlı: testler kendi markalarının post'larını süzerek doğrular.

## OAuth (Faz 3+)

- `GET /api/oauth/:platform/start?brand_id=` → `oauth_states` (10 dk, tek kullanımlık, başlatan e-posta) → platform. Callback `GET /api/oauth/:platform/callback` (Access arkasında, aynı kullanıcı) → token takası → profil → `lib/accounts.ts upsertAccount` (marka × platform tek satır, yerinde güncelleme) → `/hesaplar?connected=` veya `?error=`.
- Redirect URI: `${APP_BASE_URL origin}/api/oauth/<platform>/callback`.
- DRY_RUN açıkken token takası http istemcisinde engellenir → bağlanmak için DRY_RUN=false gerekir (README'deki güvenli sıra).
- Platform modülleri `publish/<platform>.ts`: publisher + OAuth adaptörü; `publish/publishers.ts` kaydeder.

## Panel notları

- Marka seçimi `localStorage` (`socialplan.brand`); okunamazsa ilk marka.
- `?post=<id>` Planlama'da detay panelini açar (bildirim bağlantıları bunu kullanır).
- Yerel uçtan uca deneme: `ffmpeg` ile test videosu üret, `pnpm dev`, tarayıcıda http://localhost:8787 (ACCESS_DEV_BYPASS).
- mp4box'a kutular sırayla beslenir; mdat'ın yalnız 16 bayt başlığı (moov sonda olsa da tüm dosya okunmaz).

## Yükleme notları

- Parça boyu 16 MiB (`lib/r2.ts PART_SIZE`); tarayıcı 4 paralel PUT, parça başına 3 deneme (`apps/web/src/lib/upload.ts`).
- `content_hash` = SHA-256(boyut + baş/orta/son 4 MiB) — örneklemeli özet (çok GB'lık dosyada tam özet pahalı).
- Thumbnail tarayıcıda canvas ile JPEG (uzun kenar ≤ 720 px), presigned PUT.
- Video meta: mp4box (ftyp+moov kutuları beslenir), moov konumu en üst kutu taramasıyla, süre/en/boy video elementiyle.
- Sunucu meta veriyi yeniden doğrular (`validateVideo`), boyutu R2 nesnesinden alır.

## Bilinen sorunlar

- (yok)

## TODO(doğrula)

- YouTube `status.publishAt` ile zamanlı yayın (kullanılmıyor; cron saatinde yüklenir).
- Shorts'a API ile kapak (thumbnails.set) belgelenmemiş — kullanılmıyor.
- YouTube Haziran 2026 yükleme kovasının hata `reason` değeri (`uploadLimitExceeded`/`quotaExceeded` varsayıldı).
- Audit sonrası private videonun public yapılabilmesi (audit öncesi yüklenenler kilitli kalabilir).

- TikTok webhook imza biçimi (`TikTok-Signature: t=..,s=..`, HMAC-SHA256(client_secret, `t.gövde`)) ve olay adları (`post.publish.publicly_available`, `post.publish.failed`).
- TikTok inbox init'te `post_info` (caption) ve `is_aigc` kabul ediliyor mu? Şimdilik yalnız `source_info`; caption bildirimde ve panelde "Metni kopyala".
- TikTok `creator_info` yalnız video.publish scope'uyla mı çalışıyor? Scope hatasında süre denetimi atlanıyor.
- TikTok token ömürleri (yanıttaki expires_in / refresh_expires_in kullanılıyor).

- Instagram `is_ai_generated` parametresinin adı/geçerliliği.
- Instagram `/me` alanı: `/{ig-user-id}/media` için `user_id` mi `id` mi (user_id tercih edildi).
- Instagram resumable (rupload) kesintide `offset` ile devam; şimdilik baştan gönderilir.
- Instagram hata kodları eşlemesi (100/33 geçici, 9/2207042 limit, 190 token) — gerçek yanıtlarla doğrulanmalı.

- Instagram Standard Access ile kendi hesaplarımız için App Review gerekmemesi.
- Meta'nın presigned (query string'li, süreli) R2 URL'sini `video_url` olarak kabul etmesi.
- Instagram yayın limiti (50 / 100): sabit yazılmadı, `content_publishing_limit` ile okunur.
- YouTube Haziran 2026 ayrı yükleme kovası (100/gün) değerleri.
- TikTok süre üst sınırı: `creator_info.max_video_post_duration_sec`; tablodaki 10 dk varsayılan.
