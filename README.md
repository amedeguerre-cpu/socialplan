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
