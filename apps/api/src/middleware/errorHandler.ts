import { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: { messages?: Array<{ severity: 'info' | 'warning' | 'error'; code?: string; path?: string; message: string }>; code?: string }) {
    super(message);
    this.name = 'HttpError';
  }
}

export const asyncHandler = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

export const errorHandler = (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500;
  const details = error instanceof HttpError ? error.details : undefined;
  // QA review finding: only an HttpError's message is actually meant to be
  // client-facing - it's a deliberately thrown, operational error with a
  // clear, safe message. Anything else (a Prisma constraint violation, an
  // axios/EHRbase network failure, a genuine bug) is an *unexpected*
  // internal error whose raw .message could leak internal details (DB
  // constraint/column names, internal URLs, stack-adjacent text) to any
  // authenticated caller who happens to trigger it. The real message is
  // still logged in full below - just never echoed back in the response.
  const clientMessage = error instanceof HttpError ? error.message : 'Unexpected server error';
  const logMessage = error instanceof Error ? error.message : String(error);
  console.error('[HTTP ERROR]', JSON.stringify({ status, message: logMessage, ...(details || {}) }));
  res.status(status).json({ error: clientMessage, ...(details || {}) });
};
