import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach } from 'vitest';
import { setTransportForTesting } from '../src/publish/http';
import { setJwksForTesting } from '../src/auth/access';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

afterEach(() => {
  setTransportForTesting(null);
  setJwksForTesting(null);
});
