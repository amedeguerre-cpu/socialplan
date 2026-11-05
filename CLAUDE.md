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
- [x] Faz 1 — marka CRUD, presigned multipart yükleme (S3 anahtarı yoksa yerel /api/uploads/local/*), doğrulama, thumbnail, kuyruk sıralama (kesirli), caption override, yinelenen içerik uyarısı, medya akışı (Range)

## Yükleme notları

- Parça boyu 16 MiB (`lib/r2.ts PART_SIZE`); tarayıcı 4 paralel PUT, parça başına 3 deneme (`apps/web/src/lib/upload.ts`).
- `content_hash` = SHA-256(boyut + baş/orta/son 4 MiB) — örneklemeli özet (çok GB'lık dosyada tam özet pahalı).
- Thumbnail tarayıcıda canvas ile JPEG (uzun kenar ≤ 720 px), presigned PUT.
- Video meta: mp4box (ftyp+moov kutuları beslenir), moov konumu en üst kutu taramasıyla, süre/en/boy video elementiyle.
- Sunucu meta veriyi yeniden doğrular (`validateVideo`), boyutu R2 nesnesinden alır.

## Bilinen sorunlar

- (yok)

## TODO(doğrula)

- Instagram Standard Access ile kendi hesaplarımız için App Review gerekmemesi.
- Meta'nın presigned (query string'li, süreli) R2 URL'sini `video_url` olarak kabul etmesi.
- Instagram yayın limiti (50 / 100): sabit yazılmadı, `content_publishing_limit` ile okunur.
- YouTube Haziran 2026 ayrı yükleme kovası (100/gün) değerleri.
- TikTok süre üst sınırı: `creator_info.max_video_post_duration_sec`; tablodaki 10 dk varsayılan.
