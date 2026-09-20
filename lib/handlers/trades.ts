import { db } from '../supabase';
import { AppError } from '../errors';
import { requireProfile } from '../auth';
import { check } from '../query';
import { verifyUploaded, removeObjects, ownsPath } from './shots';
import {
  QUALITY, SESSIONS, MAX_SHOTS, num, round, validTz, validCcy, offsetMin, sessionOf, uuid, isIsoDate,
} from '../util';

const DAY = 86400000;

/**
 * Works out when the trade was closed from the wall-clock time the trader
 * entered. With no explicit close date, a clock time at or before the entry
 * time means it closed after midnight, so roll forward a day; anything longer
 * needs the date spelled out.
 */
function closedAt(t: Record<string, unknown>, openDate: string, opened: Date, off: number): Date | null {
  const time = String(t.closeTime || '').trim();
  if (!time) return null;

  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || +m[1] > 23 || +m[2] > 59) throw new AppError('Enter the close time as HH:MM.');

  const explicit = String(t.closeDate || '').trim();
  if (explicit && !isIsoDate(explicit)) throw new AppError('Invalid close date.');
  const date = explicit || openDate;

  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!dm) throw new AppError('Invalid close date.');

  let closed = new Date(Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +m[1], +m[2]) - off * 60000);
  if (!explicit && closed.getTime() <= opened.getTime()) closed = new Date(closed.getTime() + DAY);

  if (closed.getTime() < opened.getTime()) {
    throw new AppError('The close time is before the entry time. Set a close date if it ran over.');
  }
  if (closed.getTime() - opened.getTime() > 365 * DAY) {
    throw new AppError('That trade would be open for over a year - check the close date.');
  }
  return closed;
}

/**
 * Lets the app keep saving trades on a database where migration 0002 has not
 * been applied yet, instead of failing every save outright.
 */
async function insertTrade(supabase: ReturnType<typeof db>, row: Record<string, unknown>) {
  const first = await supabase.from('trades').insert(row).select('id').single();
  if (first.error && /closed_utc/.test(first.error.message)) {
    const { closed_utc, ...legacy } = row;
    void closed_utc;
    return supabase.from('trades').insert(legacy).select('id').single();
  }
  return first;
}

/** Add a completed trade for the signed-in user. */
export async function addTrade(bearer: string | undefined, raw: unknown) {
  const who = await requireProfile(bearer);
  const t = (raw || {}) as Record<string, unknown>;
  const supabase = db();

  const instrument = String(t.instrument || '').trim().toUpperCase();
  if (!instrument) throw new AppError('Pick an instrument.');
  const strategy = String(t.strategy || '').trim();
  if (!strategy) throw new AppError('Pick a strategy.');

  const [{ data: haveInstr }, { data: haveStrat }] = await Promise.all([
    supabase.from('instruments').select('id').eq('user_id', who.id).eq('name', instrument).maybeSingle(),
    supabase.from('strategies').select('name').eq('user_id', who.id).eq('name', strategy).maybeSingle(),
  ]);
  if (!haveInstr) throw new AppError(`Add "${instrument}" in My Setup first.`);
  if (!haveStrat) throw new AppError(`Add the strategy "${strategy}" in My Setup first.`);

  const entry = num(t.entry);
  const sl = num(t.sl);
  const exit = num(t.exit);
  const tp = num(t.tp);
  let finalSl = num(t.finalSl);
  const risk = num(t.risk) || 0;
  const direction = t.direction === 'Short' ? 'Short' : 'Long';

  if (entry === null || sl === null || exit === null) {
    throw new AppError('Entry, Initial SL and Exit must be numbers.');
  }
  if (direction === 'Long' && sl >= entry) throw new AppError('Long: Initial SL must be below Entry.');
  if (direction === 'Short' && sl <= entry) throw new AppError('Short: Initial SL must be above Entry.');
  if (finalSl === null) finalSl = sl;
  const slTrailed = finalSl !== sl;

  // R is always measured against the INITIAL stop, even if the stop was trailed.
  const riskDist = entry - sl;
  const resultR = round((exit - entry) / riskDist, 2);
  const plannedRR = tp === null ? null : round(Math.abs(tp - entry) / Math.abs(riskDist), 2);
  const pnl = risk ? round(resultR * risk, 2) : null;
  const outcome = resultR > 0.05 ? 'Win' : resultR < -0.05 ? 'Loss' : 'BE';

  const quality = String(t.quality || '').trim();
  if (!(QUALITY as readonly string[]).includes(quality)) {
    throw new AppError('Select a trade quality (Good/Bad Win/Loss).');
  }
  if (outcome === 'Win' && !quality.includes('Win')) {
    throw new AppError('This trade was a win - choose Good Win or Bad Win.');
  }
  if (outcome === 'Loss' && !quality.includes('Loss')) {
    throw new AppError('This trade was a loss - choose Good Loss or Bad Loss.');
  }

  const confidence = Number(t.confidence);
  if (!(confidence >= 1 && confidence <= 5) || confidence % 1 !== 0) {
    throw new AppError('Select a confidence level (1-5).');
  }

  const timezone = validTz(t.timezone);
  if (!timezone) throw new AppError('Select the UTC/GMT offset you traded in.');
  if (!/^\d{2}:\d{2}$/.test(String(t.time || ''))) throw new AppError('Enter the time the trade was taken.');

  const off = offsetMin(timezone) as number;
  const date = String(t.date || new Date(Date.now() + off * 60000).toISOString().slice(0, 10));
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const [hh, mm] = String(t.time).split(':').map(Number);
  if (!dm || hh > 23 || mm > 59) throw new AppError('Invalid date or time.');

  const y = +dm[1];
  const mo = +dm[2] - 1;
  const d = +dm[3];
  const chk = new Date(Date.UTC(y, mo, d));
  if (chk.getUTCMonth() !== mo || chk.getUTCDate() !== d) throw new AppError('Invalid date or time.');

  const opened = new Date(Date.UTC(y, mo, d, hh, mm) - off * 60000);
  const closed = closedAt(t, date, opened, off);
  const currency = validCcy(t.currency) || who.profile.currency || 'USD';
  const session = (SESSIONS as readonly string[]).includes(String(t.session))
    ? String(t.session)
    : sessionOf(opened);

  const shots = Array.isArray(t.shots) ? t.shots.map(String).filter(Boolean) : [];
  const screenshots = await verifyUploaded(who.id, shots);

  const { data, error } = await insertTrade(supabase, {
      user_id: who.id,
      trade_date: date,
      instrument,
      direction,
      strategy: haveStrat.name as string,
      entry,
      initial_sl: sl,
      final_sl: finalSl,
      sl_trailed: slTrailed,
      initial_tp: tp,
      exit_price: exit,
      risk: risk || null,
      planned_rr: plannedRR,
      result_r: resultR,
      pnl,
      outcome,
      quality,
      notes: String(t.notes || '').slice(0, 2000),
      confidence,
      screenshots,
      timezone,
      opened_utc: opened.toISOString(),
      closed_utc: closed ? closed.toISOString() : null,
      session,
      currency,
  });
  if (error) {
    await removeObjects(screenshots);
    throw new AppError(error.message, 500);
  }

  return {
    id: data.id as string,
    r: resultR,
    plannedRR: plannedRR === null ? '' : plannedRR,
    pnl: pnl === null ? '' : pnl,
    outcome,
    trailed: slTrailed ? 'Yes' : 'No',
    session,
    heldMinutes: closed ? Math.round((closed.getTime() - opened.getTime()) / 60000) : '',
  };
}

/** Delete one of MY trades, along with its screenshots. */
export async function deleteTrade(bearer: string | undefined, rawId: unknown) {
  const who = await requireProfile(bearer);
  const id = uuid(rawId, 'trade');
  const supabase = db();

  const { data: trade, error } = await supabase
    .from('trades').select('id, user_id, screenshots').eq('id', id).maybeSingle();
  if (error) throw new AppError(error.message, 500);
  if (!trade) return false;
  if (trade.user_id !== who.id) throw new AppError('You can only delete your own trades.', 403);

  check(await supabase.from('trades').delete().eq('id', id));
  await removeObjects((trade.screenshots as string[]) || []);
  return true;
}

/** Attach more screenshots to one of MY existing trades. */
export async function addShots(bearer: string | undefined, rawId: unknown, rawPaths: unknown) {
  const who = await requireProfile(bearer);
  const id = uuid(rawId, 'trade');
  const supabase = db();

  const { data: trade, error } = await supabase
    .from('trades').select('id, user_id, screenshots').eq('id', id).maybeSingle();
  if (error) throw new AppError(error.message, 500);
  if (!trade) throw new AppError('Trade not found.', 404);
  if (trade.user_id !== who.id) throw new AppError('You can only edit your own trades.', 403);

  const have = ((trade.screenshots as string[]) || []).filter(Boolean);
  const incoming = (Array.isArray(rawPaths) ? rawPaths.map(String) : []).filter(Boolean);
  if (!incoming.length) throw new AppError('Nothing to add.');
  if (have.length + incoming.length > MAX_SHOTS) {
    throw new AppError(`Max ${MAX_SHOTS} screenshots per trade.`);
  }
  if (incoming.some((p) => !ownsPath(who.id, p))) {
    throw new AppError('That screenshot could not be attached.');
  }

  const added = await verifyUploaded(who.id, incoming);
  const screenshots = [...have, ...added];
  check(await supabase.from('trades').update({ screenshots }).eq('id', id));
  return screenshots;
}
