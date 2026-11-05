import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TOKEN_ENC_KEY: '1:' + Buffer.alloc(32, 7).toString('base64'),
            ACCESS_AUD: 'test-aud',
            ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com',
            APP_BASE_URL: 'https://plan.example.com',
            DRY_RUN: 'true',
            // .dev.vars testlere sızmasın
            ACCESS_DEV_BYPASS: '',
            R2_ACCESS_KEY_ID: '',
            R2_SECRET_ACCESS_KEY: '',
            SLACK_WEBHOOK_URL: '',
            TELEGRAM_BOT_TOKEN: '',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
    },
  };
});
