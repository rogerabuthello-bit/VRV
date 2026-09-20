import { db } from '../supabase';
import { AppError } from '../errors';
import { requireProfile } from '../auth';
import { check } from '../query';

/** Add one or several (comma separated) instruments to MY list. */
export async function addInstrument(bearer: string | undefined, names: unknown) {
  const who = await requireProfile(bearer);
  const list = [...new Set(
    String(names || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  )].slice(0, 50);
  if (!list.length) throw new AppError('Instrument name is required.');
  if (list.some((n) => n.length > 24)) throw new AppError('Instrument names are max 24 characters.');

  check(await db()
    .from('instruments')
    .upsert(list.map((name) => ({ user_id: who.id, name })), { onConflict: 'user_id,name', ignoreDuplicates: true }));
  return list;
}

/**
 * Store what one pip is worth on one lot. Entered once per instrument, then
 * every trade's risk and the size calculator fall out of it.
 */
export async function saveInstrumentSpec(bearer: string | undefined, rawName: unknown, raw: unknown) {
  const who = await requireProfile(bearer);
  const name = String(rawName || '').trim().toUpperCase();
  if (!name) throw new AppError('Instrument name is required.');
  const o = (raw || {}) as Record<string, unknown>;

  const positive = (v: unknown, label: string): number | null => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new AppError(`${label} must be a number greater than 0.`);
    return n;
  };

  const pip_size = positive(o.pipSize, 'Pip size');
  const value_per_pip = positive(o.valuePerPip, 'Value per pip');
  const lot_step = positive(o.lotStep, 'Lot step') ?? 0.01;
  if ((pip_size === null) !== (value_per_pip === null)) {
    throw new AppError('Set both pip size and value per pip, or neither.');
  }

  const { data, error } = await db()
    .from('instruments')
    .update({ pip_size, value_per_pip, lot_step })
    .eq('user_id', who.id)
    .eq('name', name)
    .select('name');
  if (error) {
    if (/pip_size|value_per_pip|lot_step/.test(error.message)) {
      throw new AppError('Run migration 0004 in Supabase to store instrument specs.');
    }
    throw new AppError(error.message, 500);
  }
  if (!data?.length) throw new AppError(`"${name}" is not in your instrument list.`);
  return { name, pipSize: pip_size, valuePerPip: value_per_pip, lotStep: lot_step };
}

export async function removeInstrument(bearer: string | undefined, name: unknown) {
  const who = await requireProfile(bearer);
  check(await db().from('instruments').delete().eq('user_id', who.id).eq('name', String(name || '')));
  return true;
}

/** Create or update (by name) one of MY strategies. */
export async function saveStrategy(bearer: string | undefined, rawName: unknown, rawDesc: unknown) {
  const who = await requireProfile(bearer);
  const name = String(rawName || '').trim().slice(0, 80);
  if (!name) throw new AppError('Strategy name is required.');
  const description = String(rawDesc || '').trim().slice(0, 2000);
  const supabase = db();

  const { data: existing, error } = await supabase
    .from('strategies')
    .select('id, name')
    .eq('user_id', who.id)
    .ilike('name', name)
    .maybeSingle();
  if (error) throw new AppError(error.message, 500);

  if (existing) {
    // Keep the stored spelling - logged trades reference it by name.
    check(await supabase
      .from('strategies')
      .update({ description, updated_at: new Date().toISOString() })
      .eq('id', existing.id));
    return existing.name as string;
  }

  const { error: insErr } = await supabase
    .from('strategies')
    .insert({ user_id: who.id, name, description });
  if (insErr) {
    if (/strategies_user_name_key/.test(insErr.message)) throw new AppError('You already have a strategy with that name.');
    throw new AppError(insErr.message, 500);
  }
  return name;
}

export async function removeStrategy(bearer: string | undefined, name: unknown) {
  const who = await requireProfile(bearer);
  check(await db().from('strategies').delete().eq('user_id', who.id).eq('name', String(name || '')));
  return true;
}
