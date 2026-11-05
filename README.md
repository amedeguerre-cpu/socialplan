# SocialPlan

Ekibimizin kendi "Buffer"ı: kısa dikey videoları marka bazında kuyruğa alır, haftalık slotlara veya elle seçilen tarih-saate dağıtır ve saati gelince **Instagram Reels**, **YouTube Shorts** ve **TikTok (taslağa gönder)** hesaplarına gönderir. Tek Cloudflare Worker (API + panel + cron + Queue) üzerinde çalışır; ücretli API kullanmaz.

> Bu belge kurulum sırasıyla ilerler. Bölümler fazlar tamamlandıkça genişletilir.

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
