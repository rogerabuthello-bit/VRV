import { db } from '../supabase';
import { AppError } from '../errors';
import { requireProfile } from '../auth';
import { check } from '../query';
import { INSTRUMENT_PRESETS } from '../util';

/** Broker names are free text, trimmed and capped; '' means "no broker set". */
export function cleanBroker(v: unknown): string {
  return String(v || '').trim().slice(0, 60);
}

/** Add one or several (comma separated) instruments to MY list. */
export async function addInstrument(bearer: string | undefined, names: unknown, rawBroker?: unknown) {
  const who = await requireProfile(bearer);
  const broker = rawBroker === undefined
    ? (who.profile as unknown as { active_broker?: string }).active_broker || ''
    : cleanBroker(rawBroker);
  const list = [...new Set(
    String(names || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  )].slice(0, 50);
  if (!list.length) throw new AppError('Instrument name is required.');
  if (list.some((n) => n.length > 24)) throw new AppError('Instrument names are max 24 characters.');

  check(await db()
    .from('instruments')
    .upsert(
      list.map((name) => ({ user_id: who.id, name, broker })),
      { onConflict: 'user_id,broker,name', ignoreDuplicates: true },
    ));
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
  const broker = o.broker === undefined
    ? (who.profile as unknown as { active_broker?: string }).active_broker || ''
    : cleanBroker(o.broker);

  const positive = (v: unknown, label: string): number | null => {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new AppError(`${label} must be a number greater than 0.`);
    return n;
  };

  const pip_size = positive(o.pipSize, 'Pip size');
  const value_per_pip = positive(o.valuePerPip, 'Value per pip');
  const lot_step = positive(o.lotStep, 'Lot step') ?? 0.01;
  const rawCommission = Number(o.commissionPerLot);
  const commission_per_lot = Number.isFinite(rawCommission) && rawCommission >= 0 ? rawCommission : 0;
  if ((pip_size === null) !== (value_per_pip === null)) {
    throw new AppError('Set both pip size and value per pip, or neither.');
  }

  const { data, error } = await db()
    .from('instruments')
    .update({ pip_size, value_per_pip, lot_step, commission_per_lot })
    .eq('user_id', who.id)
    .eq('name', name)
    .eq('broker', broker)
    .select('name');
  if (error) {
    if (/commission_per_lot/.test(error.message)) {
      throw new AppError('Run migration 0010 in Supabase to store commission.');
    }
    if (/pip_size|value_per_pip|lot_step/.test(error.message)) {
      throw new AppError('Run migration 0004 in Supabase to store instrument specs.');
    }
    throw new AppError(error.message, 500);
  }
  if (!data?.length) throw new AppError(`"${name}" is not in your instrument list.`);
  return { name, broker, pipSize: pip_size, valuePerPip: value_per_pip, lotStep: lot_step, commissionPerLot: commission_per_lot };
}

export async function removeInstrument(bearer: string | undefined, name: unknown, rawBroker?: unknown) {
  const who = await requireProfile(bearer);
  const broker = rawBroker === undefined
    ? (who.profile as unknown as { active_broker?: string }).active_broker || ''
    : cleanBroker(rawBroker);
  check(await db().from('instruments').delete()
    .eq('user_id', who.id).eq('name', String(name || '')).eq('broker', broker));
  return true;
}

/**
 * Adds a named group of instruments with conventional specs already filled in.
 * Existing rows are left alone, so this never overwrites a spec the trader has
 * already tuned to their broker.
 */
export async function addInstrumentPreset(bearer: string | undefined, rawGroup: unknown, rawBroker?: unknown) {
  const who = await requireProfile(bearer);
  const group = String(rawGroup || '');
  const rows = INSTRUMENT_PRESETS[group];
  if (!rows) throw new AppError('Unknown instrument group.');

  const broker = rawBroker === undefined
    ? (who.profile as unknown as { active_broker?: string }).active_broker || ''
    : cleanBroker(rawBroker);

  const supabase = db();
  const { data: existing } = await supabase
    .from('instruments').select('name').eq('user_id', who.id).eq('broker', broker);
  const have = new Set(((existing as { name: string }[] | null) || []).map((r) => r.name));
  const fresh = rows.filter((r) => !have.has(r.name));
  if (!fresh.length) return { added: [], skipped: rows.map((r) => r.name) };

  const payload = fresh.map((r) => ({
    user_id: who.id,
    broker,
    name: r.name,
    pip_size: r.pipSize,
    value_per_pip: r.valuePerPip,
    lot_step: r.lotStep,
  }));
  let err = (await supabase.from('instruments').insert(payload)).error;
  if (err && /pip_size|value_per_pip|lot_step/.test(err.message)) {
    err = (await supabase.from('instruments')
      .insert(payload.map(({ user_id, broker: b, name }) => ({ user_id, broker: b, name })))).error;
  }
  if (err) throw new AppError(err.message, 500);

  return { added: fresh.map((r) => r.name), skipped: rows.filter((r) => have.has(r.name)).map((r) => r.name) };
}

/** Create or update (by name) one of MY strategies. */
export async function saveStrategy(
  bearer: string | undefined, rawName: unknown, rawDesc: unknown,
  rawRules?: unknown, rawPois?: unknown,
) {
  const who = await requireProfile(bearer);
  const name = String(rawName || '').trim().slice(0, 80);
  if (!name) throw new AppError('Strategy name is required.');
  const description = String(rawDesc || '').trim().slice(0, 2000);
  // One rule per line, trimmed and capped so the entry checklist stays usable.
  const lines = (raw: unknown, max: number, len: number) => String(raw || '')
    .split('\n').map((r) => r.trim()).filter(Boolean).slice(0, max).map((r) => r.slice(0, len));
  const rules = rawRules === undefined ? null : lines(rawRules, 20, 160);
  const pois = rawPois === undefined ? null : lines(rawPois, 24, 80);
  const supabase = db();

  const { data: existing, error } = await supabase
    .from('strategies')
    .select('id, name, rules, pois')
    .eq('user_id', who.id)
    .ilike('name', name)
    .maybeSingle();
  if (error) throw new AppError(error.message, 500);

  if (existing) {
    // Keep the stored spelling - logged trades reference it by name.
    const patch: Record<string, unknown> = { description, updated_at: new Date().toISOString() };
    if (rules !== null) patch.rules = rules;
    if (pois !== null) patch.pois = pois;
    const upd = await supabase.from('strategies').update(patch).eq('id', existing.id);
    if (upd.error) {
      if (/pois/.test(upd.error.message)) {
        throw new AppError('Run migration 0008 in Supabase to save points of interest.');
      }
      if (/rules/.test(upd.error.message)) {
        throw new AppError('Run migration 0005 in Supabase to save strategy rules.');
      }
      throw new AppError(upd.error.message, 500);
    }
    return existing.name as string;
  }

  const insert: Record<string, unknown> = { user_id: who.id, name, description };
  if (rules !== null) insert.rules = rules;
  if (pois !== null) insert.pois = pois;
  let insErr = (await supabase.from('strategies').insert(insert)).error;
  for (const col of ['pois', 'rules']) {       // drop whatever a pending migration lacks
    if (insErr && new RegExp(col).test(insErr.message)) {
      delete insert[col];
      insErr = (await supabase.from('strategies').insert(insert)).error;
    }
  }
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
