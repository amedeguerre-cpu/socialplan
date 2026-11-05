/** Yapılandırılmış JSON log. Sırlar maskelenir; token asla loglanmaz. */

const SECRET_KEYS =
  /^(authorization|access_token|refresh_token|code|client_secret|code_verifier|token|secret|password|id_token|x-upload-content-.*?)$/i;
const SECRET_QS =
  /([?&](?:access_token|refresh_token|code|client_secret|code_verifier|X-Amz-Signature|X-Amz-Credential|input_token|fb_exchange_token)=)[^&\s"]+/gi;
const BEARER = /(Bearer|OAuth)\s+[A-Za-z0-9._~+/=-]+/g;

export function maskString(s: string): string {
  return s.replace(SECRET_QS, '$1***').replace(BEARER, '$1 ***');
}

export function mask(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[derin]';
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map((v) => mask(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) && !/upload-content/i.test(k) ? '***' : mask(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LogFields {
  trace_id?: string;
  post_id?: string;
  platform?: string;
  step?: string;
  attempt?: number;
  [k: string]: unknown;
}

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(base: LogFields = {}): Logger {
  const emit = (level: string, msg: string, fields?: LogFields): void => {
    const line = JSON.stringify(
      mask({ level, msg, at: new Date().toISOString(), ...base, ...fields }),
    );
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger({ ...base, ...f }),
  };
}
