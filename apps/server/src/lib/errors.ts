import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      void reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
      return;
    }

    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'The request did not match the expected format.',
          requestId: request.id,
          details: error.flatten(),
        },
      });
      return;
    }

    const candidateStatus =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? (error as { statusCode?: unknown }).statusCode
        : undefined;
    const statusCode = typeof candidateStatus === 'number' ? candidateStatus : 500;
    const message = error instanceof Error ? error.message : 'Request failed.';
    if (statusCode >= 500) request.log.error({ err: error }, 'request failed');

    void reply.status(statusCode).send({
      error: {
        code: statusCode >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR',
        message: statusCode >= 500 ? 'An unexpected error occurred.' : message,
        requestId: request.id,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource does not exist.',
        requestId: request.id,
      },
    });
  });
}
