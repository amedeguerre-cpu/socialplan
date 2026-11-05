import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

export class HttpError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Kayıt'): HttpError =>
  new HttpError(404, 'not_found', `${what} bulunamadı`);
export const badRequest = (msg: string, code = 'bad_request'): HttpError =>
  new HttpError(400, code, msg);
export const conflict = (msg: string, code = 'conflict'): HttpError =>
  new HttpError(409, code, msg);

export function errorResponse(c: Context, e: unknown): Response {
  if (e instanceof HttpError) return c.json({ error: e.code, message: e.message }, e.status);
  if (e instanceof HTTPException)
    return c.json({ error: 'bad_request', message: e.message || 'Geçersiz istek' }, e.status);
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'unhandled',
      err: e instanceof Error ? e.message : String(e),
    }),
  );
  return c.json({ error: 'internal', message: 'Beklenmeyen sunucu hatası' }, 500);
}
