import HttpStatus from 'http-status-codes';
import type { Router } from 'express';
import Joi from 'joi';
import { ErrorModel } from './errors';

// Audit P0 #10. Path / query / body schemas applied at the route
// edge so routes downstream can assume their inputs are already
// shape-checked: a tx_id is 64 hex chars, a height is a non-negative
// uint32, a year is in 2008–2099, etc.
//
// Closes part of C1 (random-hex floods at /transactions/:tx_id/raw
// hammering RPC), all of L4 (block/hash regex check), L5 (search q
// length).

export const HEX64 = Joi.string().lowercase().length(64).pattern(/^[0-9a-f]+$/, 'hex');
export const HEX32 = Joi.string().lowercase().length(32).pattern(/^[0-9a-f]+$/, 'hex');
export const BASE58_ADDRESS = Joi.string()
  .min(26)
  .max(35)
  .pattern(/^[1-9A-HJ-NP-Za-km-z]+$/, 'base58');
export const UINT32 = Joi.number().integer().min(0).max(4_294_967_295);
export const POSITIVE_INT = Joi.number().integer().min(1);
export const YEAR = Joi.number().integer().min(2008).max(2099);
export const MONTH = Joi.number().integer().min(1).max(12);
export const DAY = Joi.number().integer().min(1).max(31);
export const SEARCH_QUERY = Joi.string().min(1).max(256);

// Path-parameter schemas keyed by the param name as it appears in
// route paths (`/transactions/:tx_id` → key `tx_id`). Centralised so a
// single `app.param(...)` loop wires every common path param to its
// validator in one place.
export const PATH_PARAM_SCHEMAS: Record<string, Joi.Schema> = {
  tx_id: HEX64,
  height: UINT32,
  hash: HEX64,
  cpid: HEX32,
  address: BASE58_ADDRESS,
  year: YEAR,
  month: MONTH,
  day: DAY,
  streamId: Joi.string().uuid({ version: ['uuidv4'] }),
};

// Express 4/5 quirk: `app.param(name, cb)` only fires for routes
// registered on the app itself, NOT for routes inside Routers nested
// via `app.use('/path', router)`. Every router that uses one of the
// `:name` params above must call `registerParamValidators(router)`
// after construction so the matching schema runs at route resolution
// time. Bad input → 400 at the router edge, route handlers get a
// guaranteed-shape value.
export function registerParamValidators(router: Router): void {
  for (const [name, schema] of Object.entries(PATH_PARAM_SCHEMAS)) {
    router.param(name, (req, res, next, value) => {
      const result = schema.validate(value, { convert: true });
      if (result.error) {
        res.status(HttpStatus.BAD_REQUEST).send({
          errors: [new ErrorModel(HttpStatus.BAD_REQUEST, `Bad ${name}`, result.error.message)],
        });
        return;
      }
      req.params[name] = String(result.value);
      next();
    });
  }
}
