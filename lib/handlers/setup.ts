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
