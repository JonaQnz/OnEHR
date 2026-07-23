import { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
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
  const message = error instanceof Error ? error.message : 'Unexpected server error';
  if (status >= 500) console.error(error);
  res.status(status).json({ error: message });
};
