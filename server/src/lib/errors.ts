import { t } from '../i18n/index.ts';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = t('err.unauthorized')) => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = t('err.forbidden')) => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = t('err.notFound')) => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
export const paymentRequired = (message = t('err.insufficientBalance')) => new AppError(402, 'INSUFFICIENT_BALANCE', message);

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
