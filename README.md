# SocialPlan

Ekibimizin kendi "Buffer"ı: kısa dikey videoları marka bazında kuyruğa alır, haftalık slotlara veya elle seçilen tarih-saate dağıtır ve saati gelince **Instagram Reels**, **YouTube Shorts** ve **TikTok (taslağa gönder)** hesaplarına gönderir. Tek Cloudflare Worker (API + panel + cron + Queue tüketicisi) üzerinde çalışır; **hiçbir ücretli API kullanmaz**. X/Twitter kapsam dışıdır.

- Panel (Türkçe): Analiz · Planlama (haftalık takvim + liste) · Videolar · Hesaplar · Ayarlar
- Güvenlik: Cloudflare Access, token'lar AES-256-GCM ile şifreli, `DRY_RUN`, `ALLOWED_ACCOUNT_IDS`, kill switch
- Garantiler: lease kilidi, 3 deneme + geri çekilme, geri dönüşsüz adımda commit koruması ve reconcile ("iki kez yayın olmaz")

Geliştirici notları ve mimari kararlar: [`CLAUDE.md`](CLAUDE.md) · Plan: [`PLAN.md`](PLAN.md)

## İçindekiler

1. [Maliyet](#maliyet)
2. [Yerel geliştirme](#yerel-geliştirme)
3. [Cloudflare kurulumu](#cloudflare-kurulumu)
4. [İlk canlı deneme: tek marka, tek hesap](#ilk-canlı-deneme-tek-marka-tek-hesap)
5. [Instagram](#instagram-test-hesabıyla-ilk-gerçek-deneme) · [TikTok](#tiktok-geliştirici-uygulaması-ve-taslağa-gönder) · [YouTube](#youtube-google-cloud-projesi-consent-ekranı-ve-audit)
6. [Bildirimler (Slack / Telegram)](#bildirimler-slack--telegram)
7. [İşletim: durumlar, kill switch, anahtar döndürme, yedek](#işletim)

## Maliyet

| Kalem                                                                          | Tutar         |
| ------------------------------------------------------------------------------ | ------------- |
| Platform API'leri (Instagram, YouTube Data API v3, TikTok Content Posting API) | **0**         |
| Cloudflare Workers Paid (barındırma; D1, Queues, cron dahil kullanım payları)  | $5/ay         |
| R2 depolama: 30 gün saklama ile ~60 GB × $0.015/GB (çıkış ücretsiz)            | ≈ $0.75/ay    |
| **Toplam**                                                                     | **≈ $5–6/ay** |

**Free plan riski:** Workers Free'de istek başına 10 ms CPU ve 50 alt istek sınırı var; parçalı video yükleme (YouTube 8 MiB, TikTok 10 MiB parçalar) ve uzun adımlar bu sınırlara takılır, R2 ücretsiz katmanı 10 GB'tır. Free plan yalnız panel denemesi için uygundur; yayın hattı için Workers Paid önerilir (`wrangler.jsonc` → `limits.cpu_ms = 300000`).

## Yerel geliştirme

Gereksinim: Node 22, pnpm 10. Gerçek hesap/secret gerekmez.

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
# .dev.vars içinde TOKEN_ENC_KEY'i değiştirin:  openssl rand -base64 32
pnpm --filter @socialplan/api db:migrate:local
pnpm dev            # paneli derler ve wrangler dev'i başlatır → http://localhost:8787
pnpm check          # typecheck + lint + prettier + tüm testler
```

- `ACCESS_DEV_BYPASS` yalnız `APP_BASE_URL` localhost iken ve istek localhost'tan geliyorsa geçerlidir; production'da tanımlıysa Worker hiç açılmaz.
- `DRY_RUN=true` (varsayılan): platformlara hiçbir istek gitmez. Hesaplar ekranında **Demo bağla** ile OAuth'suz demo hesap ekleyip tüm akışı deneyin; Analiz'de **Demo veri üret** sahte metrik üretir.
- R2 S3 anahtarı yokken tarayıcı yüklemesi Worker'ın imzalı `/api/uploads/local/*` uçları üzerinden yerel R2'ye gider.
- Cron'u elle tetiklemek: `cd apps/api && npx wrangler dev --test-scheduled` ve `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`.
- Panel geliştirme (sıcak yenileme): bir terminalde `pnpm --filter @socialplan/api dev`, diğerinde `pnpm dev:web` → http://localhost:5173.
- Test videosu: `ffmpeg -f lavfi -i testsrc2=size=1080x1920:rate=30:duration=8 -f lavfi -i sine=duration=8 -c:v libx264 -pix_fmt yuv420p -c:a aac -movflags +faststart -shortest test.mp4`

## Cloudflare kurulumu

Komutlar `apps/api` klasöründe çalıştırılır (`cd apps/api`). Önce `npx wrangler login`.

1. **Workers Paid** planına geçin (_Dashboard → Workers & Pages → Plans_).
2. **D1**:
   ```bash
   npx wrangler d1 create socialplan
   # çıktıdaki database_id'yi wrangler.jsonc → d1_databases[0].database_id alanına yazın
   npx wrangler d1 migrations apply socialplan --remote
   ```
3. **Queues** (yayın hattı + ölü mektup kuyruğu):
   ```bash
   npx wrangler queues create socialplan-publish
   npx wrangler queues create socialplan-publish-dlq
   ```
4. **R2 bucket**:
   ```bash
   npx wrangler r2 bucket create socialplan-media
   ```
   - **Yarım kalan multipart yüklemeler**: _R2 → socialplan-media → Settings → Object lifecycle rules_ → "Abort incomplete multipart uploads after **2 days**" kuralı ekleyin (veya `npx wrangler r2 bucket lifecycle add socialplan-media` ile).
   - **S3 API anahtarı** (presigned URL için; binding presign yapamaz): _R2 → Manage R2 API Tokens → Create API token_ → izin _Object Read & Write_, yalnız `socialplan-media`. Access Key ID / Secret Access Key'i not edin; hesap kimliği (Account ID) R2 sayfasında görünür.
   - **CORS** (tarayıcı doğrudan R2'ye PUT eder ve ETag okur): `infra/r2-cors.json` içindeki `origins` değerini panel adresinizle değiştirin, sonra
     ```bash
     npx wrangler r2 bucket cors set socialplan-media --file ../../infra/r2-cors.json
     ```
5. **Değişkenler** — `wrangler.jsonc` → `vars`:
   | Değişken                                                                 | Değer                                                                 |
   | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
   | `APP_BASE_URL`                                                           | panel adresi, ör. `https://plan.ornek.com`                            |
   | `ACCESS_TEAM_DOMAIN`                                                     | `<takım>.cloudflareaccess.com`                                        |
   | `ACCESS_AUD`                                                             | Access uygulamasının _Application Audience (AUD) Tag_ değeri (adım 7) |
   | `DRY_RUN`                                                                | ilk deploy'da `"true"` bırakın                                        |
   | `ALLOWED_ACCOUNT_IDS`                                                    | boş; ilk canlı denemede tek hesap kimliği                             |
   | `R2_ACCOUNT_ID`, `R2_BUCKET`                                             | Cloudflare hesap kimliği, `socialplan-media`                          |
   | `IG_APP_ID`, `GOOGLE_CLIENT_ID`, `TIKTOK_CLIENT_KEY`, `TELEGRAM_CHAT_ID` | platform bölümlerinde                                                 |
6. **Secret'lar** (değerler asla repoya yazılmaz):
   ```bash
   openssl rand -base64 32 | npx wrangler secret put TOKEN_ENC_KEY     # parola yöneticisine de kaydedin!
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   npx wrangler secret put IG_APP_SECRET
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put TIKTOK_CLIENT_SECRET
   npx wrangler secret put SLACK_WEBHOOK_URL       # isteğe bağlı
   npx wrangler secret put TELEGRAM_BOT_TOKEN      # isteğe bağlı
   ```
   `ACCESS_DEV_BYPASS`'ı production'a **asla** eklemeyin (eklenirse Worker 500 döner ve cron/kuyruk çalışmaz).
7. **Cloudflare Zero Trust + Access**:
   - _Zero Trust → Settings → Custom pages / General_: takım alanınız (`<takım>.cloudflareaccess.com`) → `ACCESS_TEAM_DOMAIN`.
   - _Access → Applications → Add an application → Self-hosted_: alan = panel adresi (özel alan adı veya `socialplan.<alt-alan>.workers.dev`), oturum süresi ör. 24 sa.
   - Politika: _Allow_ → _Emails_ (ekip üyelerinin e-postaları) veya _Emails ending in_ `@sirketiniz.com`.
   - Uygulamanın _Overview_ sekmesindeki **Application Audience (AUD) Tag** → `ACCESS_AUD`.
   - **TikTok webhook** kullanacaksanız aynı uygulamaya ikinci bir yol için politika: _Add application_ → aynı alan, yol `webhooks/*` → politika eylemi **Bypass** (Everyone). Worker bu yolu Access JWT'siz kabul eder ve TikTok imzasını doğrular.
   - Worker her `/api` isteğinde `Cf-Access-Jwt-Assertion` başlığını takımın JWKS'i ile (iss + aud) doğrular; başlıksız istek 401'dir.
8. **Derle ve yayınla** (kök klasörde):
   ```bash
   pnpm deploy
   ```
   Özel alan adı: _Workers & Pages → socialplan → Settings → Domains & Routes → Add custom domain_. `APP_BASE_URL` bu adres olmalı (OAuth redirect URI'leri buradan türetilir).
9. Panele girin (Access girişi), Ayarlar'da slotları tanımlayın, Videolar'dan yükleyin. `DRY_RUN=true` iken her şey "yayınlandı (dry-run)" olur.

## İlk canlı deneme: tek marka, tek hesap

Gerçek paylaşıma geçerken **tek marka ve tek hesapla** başlayın:

1. Panel → Ayarlar → **Tüm paylaşımları durdur** (kill switch açık).
2. `wrangler.jsonc` → `DRY_RUN: "false"` → `pnpm deploy`. (OAuth token takası platforma istek attığı için hesap bağlamak DRY_RUN kapalıyken yapılır.)
3. Hesaplar → yalnız **bir** hesabı bağlayın; kartta görünen **Kimlik** değerini `ALLOWED_ACCOUNT_IDS`'e yazın → `pnpm deploy`. Beyaz liste doluyken listede olmayan hesaplara hiçbir gerçek istek gitmez.
4. Kill switch'i kapatın; bir videoyu 5 dk sonrasına elle planlayın, Planlama'da izleyin.
5. Sorun yoksa diğer hesapları ekleyip `ALLOWED_ACCOUNT_IDS`'i genişletin (veya boşaltın = tümü). YouTube için audit onayına kadar beyaz liste zorunludur.

## Instagram: test hesabıyla ilk gerçek deneme

Önkoşul: Instagram hesabı **Business** veya **Creator** olmalı.

1. [Meta for Developers](https://developers.facebook.com/apps) → **Uygulama oluştur** → tür: _Business_ → ürün olarak **Instagram** → **API setup with Instagram login**.
2. _Instagram Login_ ayarlarında **Valid OAuth Redirect URIs**: `https://<panel-adresi>/api/oauth/instagram/callback`.
3. İzinler: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`. Kendi hesaplarımız için Standard Access yeterli olmalı (App Review beklenmiyor — **doğrulanacak**).
4. _App roles → Roles → Instagram Testers_: test hesabını ekleyin; hesabın Instagram ayarlarından (Web: _Ayarlar → Uygulamalar ve web siteleri → Tester davetleri_) daveti kabul edin.
5. Uygulama kimliği ve gizli anahtarı: _Instagram → API setup with Instagram login → Business login settings_ bölümündeki **Instagram App ID / Secret**.
   ```bash
   # wrangler.jsonc → vars.IG_APP_ID = "<Instagram App ID>"
   pnpm --filter @socialplan/api exec wrangler secret put IG_APP_SECRET
   ```
6. Instagram video dosyasını Meta'nın sunucusu indirir: `video_url` olarak R2 S3 uç noktasından **süreli presigned URL** verilir (R2 S3 anahtarı gerekli). Meta bu URL'yi reddederse hesabın meta alanına `"ig_upload_mode": "resumable"` yazın (yükleme rupload.facebook.com'a akışla yapılır):
   ```bash
   wrangler d1 execute socialplan --remote --command "UPDATE accounts SET meta = json_set(meta, '$.ig_upload_mode', 'resumable') WHERE platform = 'instagram' AND username = '<kullanıcı>'"
   ```
7. **Tek marka, tek hesap**: Ayarlar'da kill switch'i açın → `DRY_RUN=false` ile deploy → Hesaplar → Instagram **Bağla** → hesap kartındaki kimliği `ALLOWED_ACCOUNT_IDS`'e yazıp deploy → kill switch'i kapatın.
8. Bir videoyu Videolar ekranından birkaç dakika sonrasına planlayın; Planlama → Liste'de durumu izleyin (Yayınlandı + "Platformda aç").

Token 60 gün geçerlidir; bitişe 10 gün kala cron otomatik yeniler (token en az 24 saat yaşında olmalı).

## TikTok: geliştirici uygulaması ve "taslağa gönder"

TikTok, audit'ten geçmemiş istemcilerin yalnız `SELF_ONLY` paylaşmasına izin verir ve kendi hesaplarına yükleme aracını audit için uygun saymaz. Bu yüzden SocialPlan TikTok'ta **taslağa gönder (Upload / inbox)** modunda çalışır: saat gelince video hesabın TikTok gelen kutusuna düşer, uygulamadan tek dokunuşla yayınlarsınız.

1. [developers.tiktok.com](https://developers.tiktok.com/) → **Manage apps → Connect an app**.
2. Ürünler: **Login Kit** ve **Content Posting API** (yalnız _Upload_ / `video.upload`; _Direct Post_ gerekmez). Ayrıca metrikler için `video.list`.
3. Login Kit → **Redirect URI**: `https://<panel-adresi>/api/oauth/tiktok/callback`.
4. Uygulamayı **Sandbox**'ta tutun; _Sandbox → Target users_ bölümüne kendi TikTok hesabınızı ekleyin (sandbox'ta yalnız bu hesaplar bağlanabilir).
5. Değişkenler:
   ```bash
   # wrangler.jsonc → vars.TIKTOK_CLIENT_KEY = "<client key>"
   pnpm --filter @socialplan/api exec wrangler secret put TIKTOK_CLIENT_SECRET
   ```
6. (İsteğe bağlı) **Webhook**: _Webhooks → Callback URL_ = `https://<panel-adresi>/webhooks/tiktok`. Cloudflare Access'te bu yol için **Bypass** politikası ekleyin (aşağıda). Webhook gelirse TikTok'ta herkese açık olan paylaşım panelde kendiliğinden "Yayınlandı" olur; gelmezse panelden **Yayınladım** deyin.
7. Hesaplar → TikTok **Bağla**. Paylaşım saati gelince bildirim ("TikTok'ta yayınla") gelir; 1 saat içinde yayınlanmazsa bir kez daha hatırlatılır.

Not: 24 saatte gelen kutusunda bekleyen taslak sayısı sınırlıdır (`spam_risk_too_many_pending_share` → "İşlem gerekli"). Bekleyen taslakları uygulamadan yayınlayın veya silin.

## YouTube: Google Cloud projesi, consent ekranı ve audit

YouTube Data API v3 ücretsizdir ama kotalıdır: Haziran 2026'dan beri `videos.insert` ayrı bir kovada **proje başına günde 100 yükleme**, diğer çağrılar günde 10.000 birim; sıfırlanma Pasifik gece yarısı. SocialPlan kota defteri tutar, dolarsa paylaşımı ertesi Pasifik gününe erteler.

1. [Google Cloud Console](https://console.cloud.google.com/) → yeni proje → **APIs & Services → Library** → **YouTube Data API v3** ve **YouTube Analytics API**'yi etkinleştirin.
2. **OAuth consent screen** (Google Auth Platform): User type _External_ → uygulama adı, destek e-postası → **Scopes**: `youtube.upload`, `youtube.readonly`, `yt-analytics.readonly`, `youtube.force-ssl` → **Test users**: kanal sahibi Google hesapları.
3. **Credentials → Create credentials → OAuth client ID** → _Web application_ → **Authorized redirect URI**: `https://<panel-adresi>/api/oauth/youtube/callback`.
   ```bash
   # wrangler.jsonc → vars.GOOGLE_CLIENT_ID = "<client id>"
   pnpm --filter @socialplan/api exec wrangler secret put GOOGLE_CLIENT_SECRET
   ```
4. **Consent ekranını "In production"a alın** (_Publishing status → Publish app_). "Testing" modunda refresh token **7 günde düşer** ve hesap her hafta yeniden bağlanmak zorunda kalır. Hassas scope'lar için Google doğrulaması istenebilir; doğrulanana kadar "Google bu uygulamayı doğrulamadı" uyarısını _Gelişmiş → devam et_ ile geçebilirsiniz (yalnız iç kullanım).
5. Hesaplar → YouTube **Bağla**: Google hesabı ve (marka hesabı varsa) kanal seçilir. Refresh token gelmezse Google hesabınızda (_Güvenlik → Üçüncü taraf erişimi_) uygulamayı kaldırıp yeniden bağlayın.

### Audit (public yükleme için zorunlu)

**Audit'ten geçmemiş bir projeden API ile yüklenen video kalıcı olarak private kilitlenir; sonradan public yapılamaz.** Bu yüzden:

- Ayarlar'daki **"YouTube API audit onayı alındı"** kapalıyken (varsayılan) videolar `private` yüklenir ve yalnız `ALLOWED_ACCOUNT_IDS` listesindeki **test kanalına** izin verilir. Panelde "Audit onayı yok: video private kalacak" uyarısı görünür.
- Audit başvurusu: [YouTube API Services – Audit and Quota Extension Form](https://support.google.com/youtube/contact/yt_api_form). Form, uygulamanın **uçtan uca ekran kaydını** (OAuth bağlantısı → video planlama → yükleme → YouTube'da görünmesi), kullanım amacını (kendi kanallarımıza iç planlama aracı) ve gizlilik politikası/şartlar bağlantılarını ister. Süre belgelenmemiştir.
- Onay gelince Ayarlar'da bayrağı açın: yeni yüklemeler `public` olur. Audit sonrası private yüklenmiş bir video için paylaşım detayındaki **"YouTube'da public yap"** düğmesi `videos.update` çağırır (audit öncesi yüklenenler kilitli kalabilir).
- Shorts için API bayrağı yoktur: dikey/kare ve ≤ 3 dk videolar Shorts olarak sınıflanır; başlığa `#Shorts` eklenir. Shorts kapağı API ile ayarlanamıyor (belgelenmemiş).
- Her yüklemede `selfDeclaredMadeForKids` (video ayarı) ve `containsSyntheticMedia` (yükleme sırasındaki "yapay zekâ ile üretildi" seçimi) açıkça gönderilir.

## Bildirimler (Slack / Telegram)

Bildirim türleri: yayın hatası, işlem gerekli, token düşmesi / yaklaşan bitiş, kuyruk 3 günden az, kill switch, **TikTok taslağı gönderildi** ("TikTok'ta yayınla"; 1 saat içinde yayınlanmazsa bir kez daha). Her bildirim `dedupe_key` ile bir kez gönderilir; mesajlarda token veya sır bulunmaz.

- **Slack**: _api.slack.com/apps → Create New App → Incoming Webhooks → Add New Webhook to Workspace_ → kanal seçin → URL'yi `npx wrangler secret put SLACK_WEBHOOK_URL`.
- **Telegram**: [@BotFather](https://t.me/BotFather) → `/newbot` → token'ı `npx wrangler secret put TELEGRAM_BOT_TOKEN`. Botu gruba ekleyin, gruba bir mesaj yazın, `https://api.telegram.org/bot<TOKEN>/getUpdates` çıktısındaki `chat.id` değerini `TELEGRAM_CHAT_ID` değişkenine yazın.
- Panel → Ayarlar → Bildirimler: kanalları açın, **Deneme mesajı gönder**.

## İşletim

**Durumlar:** Taslak → Planlandı → İşleniyor → Yayınlandı; TikTok'ta İşleniyor → Taslağa gönderildi → (siz yayınlayınca) Yayınlandı. Geçici hatalar (ağ, 5xx, 429) 1 / 5 / 25 dk (+ rastgele pay, Retry-After'a uyarak) yeniden denenir; 3 yeniden denemeden sonra **Hata**. **İşlem gerekli**: token iptali, hesap kısıtı, kaçırılan slot (varsayılan 30 dk tolerans), kill switch veya sonucu belirsiz son adım — otomatik tekrar yoktur; detay panelindeki açıklamaya göre "Tekrar dene" ya da "Yayınlandı olarak işaretle".

**İki kez yayın olmaz:** her post tek koşullu UPDATE ile kilitlenir (lease); geri dönüşsüz çağrıdan (Instagram `media_publish`, YouTube son parça, TikTok son parça) önce `commit_started_at` yazılır ve yanıt kaybolursa platformda durum sorgulanır (reconcile). Belirsizse kör tekrar yapılmaz.

**Kill switch:** Ayarlar → "Tüm paylaşımları durdur". Cron yeni iş başlatmaz, devam eden adımlar bir sonraki dış çağrıdan önce durur; panelde kırmızı bant görünür, audit log'a yazılır.

**Loglar:** `cd apps/api && npx wrangler tail` (yapılandırılmış JSON: `trace_id`, `post_id`, `platform`, `step`, `attempt`; token'lar maskelenir).

**Anahtar döndürme (TOKEN_ENC_KEY):**

```bash
scripts/rotate-key.sh 2      # yeni anahtar "2:<base64>" olur, eskisi TOKEN_ENC_KEY_PREV
# Panel → Ayarlar → Bakım → "Token'ları yeniden şifrele" (rotated = total)
cd apps/api && npx wrangler secret delete TOKEN_ENC_KEY_PREV
```

**Yedek:** D1 **Time Travel** son 30 günün herhangi bir dakikasına geri dönmeyi sağlar:

```bash
npx wrangler d1 time-travel info socialplan
npx wrangler d1 time-travel restore socialplan --timestamp=2026-11-05T09:00:00Z
npx wrangler d1 export socialplan --remote --output=yedek.sql     # ek dışa aktarma
```

Videolar R2'de `retention_days` (varsayılan 30) gün sonra silinir (tüm platformlarda yayınlandıktan sonra); kapaklar kalır.

**Sağlık ekranı:** başlıktaki renkli nokta veya `/saglik` — cron'un son çalışması, geciken/takılan paylaşımlar, işlem gerekli, son 24 sa hatalar, ölü mektuplar ve token durumları tek sayfada.

**Haftalık özet:** her pazartesi 09:05 (İstanbul) her marka için Slack/Telegram'a: son 7 günün görüntülenme/etkileşimi (önceki haftaya göre %), en iyi 3 video, gelecek haftanın slot doluluğu, kuyruk durumu. Ayarlar → Bildirimler'den kapatılabilir, önizlenebilir veya hemen gönderilebilir.

**Metin şablonları:** Ayarlar → Metin şablonları ve hashtag setleri; video detayında platform sekmesinden uygulanır. Marka ayarlarındaki **imza** her paylaşım metninin sonuna eklenir.

**Ölü mektup kuyruğu:** `socialplan-publish-dlq`'ya düşen mesajlar yalnız beklenmeyen hatalarda oluşur; DLQ tüketicisi ilgili paylaşımı "İşlem gerekli" yapar ve bildirim gönderir (sağlık ekranında kırmızı görünür). `npx wrangler queues info socialplan-publish-dlq` ile izleyin.

**Günlük işler** İstanbul saatiyle 04:10'da çalışır (otomatik doldurma, kuyruk uyarısı, metrik çekme, saklama temizliği); Ayarlar → Bakım'dan elle de çalıştırılabilir.

## Doğrulanmamış platform davranışları

Resmi doküman siteleri geliştirme ortamından erişilemediği için bazı ayrıntılar arama özetleriyle doğrulandı. Kesinleşmeyenler kodda `TODO(doğrula)` olarak işaretli ve [`CLAUDE.md`](CLAUDE.md) içinde listelidir (ör. Meta'nın presigned R2 URL'sini kabul etmesi, TikTok webhook imzası, YouTube yükleme kovası hata kodu). İlk canlı denemede bu maddeleri kontrol edin.
