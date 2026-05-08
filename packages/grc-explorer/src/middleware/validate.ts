import HttpStatus from 'http-status-codes';
import type { Request, Response, NextFunction } from 'express';
import type Joi from 'joi';
import { ErrorModel } from '../lib/errors';

// Per-route validator. Use for query / body shapes that don't fit the
// `app.param(...)` slot. Each schema is optional; if provided, runs
// against `req.{params,query,body}` and writes the cleaned value back
// (Joi `.value` strips unknown keys when configured + coerces types).
//
// Path params are usually handled by `app.param(name, ...)` in api.ts
// which fires for every route that mentions `:name` — use this
// middleware when a route needs a more elaborate path schema (e.g.,
// cross-field constraints) or for query/body validation.
export function validate(schemas: {
  params?: Joi.Schema;
  query?: Joi.Schema;
  body?: Joi.Schema;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    for (const [key, schema] of Object.entries(schemas)) {
      if (!schema) continue;
      const target = (req as unknown as Record<string, unknown>)[key];
      const result = (schema as Joi.Schema).validate(target, { stripUnknown: true, convert: true });
      if (result.error) {
        res.status(HttpStatus.BAD_REQUEST).send({
          errors: [new ErrorModel(
            HttpStatus.BAD_REQUEST,
            `Invalid ${key}`,
            result.error.message,
          )],
        });
        return;
      }
      (req as unknown as Record<string, unknown>)[key] = result.value;
    }
    next();
  };
}
