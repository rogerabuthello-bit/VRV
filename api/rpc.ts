import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handlers, publicHandlers } from '../lib/handlers';
import { AppError } from '../lib/errors';

/**
 * Single JSON-RPC style endpoint: { fn, args }.
 *
 * Keeping one function means the whole backend fits in a single Vercel
 * serverless function and the browser keeps the "call a named function"
 * shape the Apps Script version used.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  let fn = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    fn = String(body.fn || '');
    const args: unknown[] = Array.isArray(body.args) ? body.args : [];

    const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

    if (own(publicHandlers, fn)) {
      res.status(200).json({ result: publicHandlers[fn]() });
      return;
    }

    const target = own(handlers, fn) ? handlers[fn] : undefined;
    if (!target) {
      res.status(404).json({ error: `Unknown action "${fn}".` });
      return;
    }

    const result = await target(req.headers.authorization, ...args);
    res.status(200).json({ result: result === undefined ? null : result });
  } catch (err) {
    const e = err as AppError;
    const status = typeof e?.status === 'number' ? e.status : 500;
    const message = e?.message || 'Something went wrong.';
    if (status >= 500) console.error(`[rpc:${fn}]`, err);
    res.status(status).json({ error: status >= 500 ? 'Server error. Please try again.' : message });
  }
}
