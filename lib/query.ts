import type { PostgrestFilterBuilder } from '@supabase/postgrest-js';
import { AppError } from './errors';

const PAGE = 1000;

/**
 * PostgREST caps a single response, so walk the table in pages. Everything in
 * this journal is small enough to hold in memory and the dashboard needs the
 * whole history to draw its curves.
 */
export async function fetchAll<T>(
  build: () => PostgrestFilterBuilder<any, any, any, any, any>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw new AppError(error.message, 500);
    const rows = (data || []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export function must<T>(res: { data: T | null; error: { message: string } | null }, fallback = 'Database error.'): T {
  if (res.error) throw new AppError(res.error.message || fallback, 500);
  if (res.data === null) throw new AppError(fallback, 500);
  return res.data;
}

export function check(res: { error: { message: string } | null }): void {
  if (res.error) throw new AppError(res.error.message || 'Database error.', 500);
}
