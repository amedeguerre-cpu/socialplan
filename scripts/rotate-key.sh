#!/usr/bin/env bash
# TOKEN_ENC_KEY döndürme. Kullanım: scripts/rotate-key.sh <yeni-sürüm-numarası>
# 1) Yeni 32 baytlık anahtar üretir, 2) eski anahtarı TOKEN_ENC_KEY_PREV yapar, 3) yeniyi TOKEN_ENC_KEY yapar.
# Ardından panelde Ayarlar → Bakım → "Token'ları yeniden şifrele" ve sonra TOKEN_ENC_KEY_PREV'i silin.
set -euo pipefail
VERSION="${1:?Yeni anahtar sürümünü verin (ör. 2)}"
cd "$(dirname "$0")/../apps/api"
NEW="${VERSION}:$(openssl rand -base64 32)"
echo "Mevcut TOKEN_ENC_KEY değerini yapıştırın (TOKEN_ENC_KEY_PREV olacak; ekranda görünmez):"
read -rs OLD
[ -n "$OLD" ] || { echo "Boş değer"; exit 1; }
printf '%s' "$OLD" | npx wrangler secret put TOKEN_ENC_KEY_PREV
printf '%s' "$NEW" | npx wrangler secret put TOKEN_ENC_KEY
unset OLD
echo
echo "Yeni anahtar (sürüm $VERSION) yüklendi. Bir parola yöneticisine kaydedin:"
echo "$NEW"
echo
echo "Sonraki adımlar:"
echo "  1. Panel → Ayarlar → Bakım → \"Token'ları yeniden şifrele\" (rotated = total olmalı)"
echo "  2. npx wrangler secret delete TOKEN_ENC_KEY_PREV"
