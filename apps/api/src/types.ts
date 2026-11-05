import type { Env } from './env';
import type { Logger } from './lib/log';

export interface AppEnv {
  Bindings: Env;
  Variables: {
    actor: string;
    devBypass: boolean;
    log: Logger;
  };
}
