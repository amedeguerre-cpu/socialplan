import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodType } from 'zod';

/** zod doğrulayıcı — hata mesajı Türkçe ve tek satır. */
export const v = <T extends ZodType, K extends keyof ValidationTargets>(target: K, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue?.path.join('.') ?? '';
      return c.json(
        {
          error: 'validation',
          message: `Geçersiz veri${path ? ` (${path})` : ''}: ${issue?.message ?? ''}`,
        },
        400,
      );
    }
    return undefined;
  });
