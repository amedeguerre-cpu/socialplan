#!/usr/bin/env bash
# Kullanım: scripts/commit.sh "mesaj"  — biçimlendir, pnpm check (başarısızsa durur), commit, push (ağ hatasında 4 deneme).
set -euo pipefail
cd "$(dirname "$0")/.."
npx prettier --write . > /dev/null
pnpm check > /tmp/socialplan-check.log 2>&1 || { tail -40 /tmp/socialplan-check.log; echo "pnpm check BAŞARISIZ"; exit 1; }
grep -E "Tests " /tmp/socialplan-check.log || true
git add -A
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -q -m "$1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015rau2gRezc5XRFRgmbJAMQ"
for d in 0 2 4 8 16; do
  sleep "$d"
  if git push -q -u origin main; then git log --oneline -1; exit 0; fi
done
echo "push başarısız"; exit 1
