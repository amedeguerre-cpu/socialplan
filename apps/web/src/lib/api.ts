/** Panel → API istemcisi. Kimlik Cloudflare Access çerezinden gelir; token'lar asla panele gelmez. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`/api${path}`, { ...init, headers, body, credentials: 'same-origin' });
  if (!res.ok) {
    let code = 'http_error';
    let message = `İstek başarısız (${res.status})`;
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      code = j.error ?? code;
      message = j.message ?? message;
    } catch {
      /* gövde JSON değil */
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(p: string) => apiFetch<T>(p),
  post: <T>(p: string, json?: unknown) => apiFetch<T>(p, { method: 'POST', json: json ?? {} }),
  put: <T>(p: string, json?: unknown) => apiFetch<T>(p, { method: 'PUT', json: json ?? {} }),
  patch: <T>(p: string, json?: unknown) => apiFetch<T>(p, { method: 'PATCH', json: json ?? {} }),
  del: <T>(p: string) => apiFetch<T>(p, { method: 'DELETE' }),
};

export function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
