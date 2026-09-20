import { db } from '../supabase';
import { AppError } from '../errors';
import { requireProfile } from '../auth';
import { check } from '../query';
import { verifyUploaded, removeObjects, ownsPath } from './shots';
import {
  QUALITY, SESSIONS, MAX_SHOTS, EXIT_REASONS, MISTAKES, EMOTIONS,
  detectExitReason, riskOfPosition, pickFrom,
  num, round, validTz, validCcy, offsetMin, sessionOf, uuid, isIsoDate,
} from '../util';
import type { Profile } from '../auth';
import { equityOf } from './funds';

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

/** Columns added by later migrations; a database missing one still works. */
const OPTIONAL_COLUMNS = [
  'closed_utc', 'exit_reason', 'lots', 'risk_pct', 'mistakes', 'emotion',
  'rules_followed', 'rules_total',
];

/**
 * Saves the trade, and if the database has not had a later migration applied
 * it drops that column and retries rather than failing the save outright. The
 * trader loses one field, not the trade.
 */
async function insertTrade(supabase: ReturnType<typeof db>, row: Record<string, unknown>) {
  const attempt = { ...row };
  for (let i = 0; i <= OPTIONAL_COLUMNS.length; i += 1) {
    const res = await supabase.from('trades').insert(attempt).select('id').single();
    if (!res.error) return res;
    const missing = OPTIONAL_COLUMNS.find(
      (c) => c in attempt && res.error!.message.includes(c),
    );
    if (!missing) return res;
    delete attempt[missing];
  }
  return supabase.from('trades').insert(attempt).select('id').single();
}

/**
 * Validates one trade and works out everything derived from it. Shared by
 * adding and editing so an edited trade is held to exactly the same rules as
 * a new one.
 *
 * `equityAdjust` is subtracted from equity before working out the risk share,
 * so editing a trade measures against the account as it stood without that
 * trade's own result.
 */
async function buildTradeRow(
  who: { id: string; profile: Profile },
  raw: unknown,
  equityAdjust = 0,
) {
  const t = (raw || {}) as Record<string, unknown>;
  const supabase = db();

  const instrument = String(t.instrument || '').trim().toUpperCase();
  if (!instrument) throw new AppError('Pick an instrument.');
  const strategy = String(t.strategy || '').trim();
  if (!strategy) throw new AppError('Pick a strategy.');

  const [{ data: haveInstr }, { data: haveStrat }] = await Promise.all([
    supabase.from('instruments').select('id, pip_size, value_per_pip')
      .eq('user_id', who.id).eq('name', instrument).maybeSingle(),
    supabase.from('strategies').select('name, rules').eq('user_id', who.id).eq('name', strategy).maybeSingle(),
  ]);
  if (!haveInstr) throw new AppError(`Add "${instrument}" in My Setup first.`);
  if (!haveStrat) throw new AppError(`Add the strategy "${strategy}" in My Setup first.`);

  const entry = num(t.entry);
  const sl = num(t.sl);
  const exit = num(t.exit);
  const tp = num(t.tp);
  let finalSl = num(t.finalSl);
  const direction = t.direction === 'Short' ? 'Short' : 'Long';

  if (entry === null || sl === null || exit === null) {
    throw new AppError('Entry, Initial SL and Exit must be numbers.');
  }
  if (direction === 'Long' && sl >= entry) throw new AppError('Long: Initial SL must be below Entry.');
  if (direction === 'Short' && sl <= entry) throw new AppError('Short: Initial SL must be above Entry.');
  if (finalSl === null) finalSl = sl;
  const slTrailed = finalSl !== sl;

  /*
   * Money at risk comes from the position itself when the instrument has a
   * contract spec, which makes PnL exact instead of an estimate. Traders
   * without a spec keep typing the amount by hand, as before.
   */
  const lots = num(t.lots);
  if (lots !== null && lots <= 0) throw new AppError('Lot size must be greater than 0.');
  const spec = haveInstr as { pip_size: number | null; value_per_pip: number | null };
  const sized = lots === null ? null : riskOfPosition({
    entry, sl, lots,
    pipSize: spec?.pip_size ?? 0,
    valuePerPip: spec?.value_per_pip ?? 0,
  });
  if (lots !== null && sized === null && num(t.risk) === null) {
    throw new AppError(
      `Set the pip size and value per pip for ${instrument} in My Setup, or type the risk amount.`,
    );
  }
  const risk = sized ?? num(t.risk) ?? 0;

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

  // Derived from the prices unless the trader corrected it themselves.
  const chosen = String(t.exitReason || '').trim();
  const exitReason = (EXIT_REASONS as readonly string[]).includes(chosen)
    ? chosen
    : detectExitReason({ entry, sl, finalSl, tp, exit });

  // Share of equity actually put at risk - the number that exposes sizing up
  // after a loss, which the R figure alone hides.
  let riskPct: number | null = null;
  if (risk > 0) {
    const equity = await equityOf(who.id, currency) - equityAdjust;
    if (equity > 0) riskPct = round((risk / equity) * 100, 2);
  }

  // Fixed taxonomies, so anything unrecognised is dropped rather than stored.
  const mistakes = pickFrom(t.mistakes, MISTAKES);
  const rawEmotion = String(t.emotion || '').trim();
  const emotion = (EMOTIONS as readonly string[]).includes(rawEmotion) ? rawEmotion : null;

  // The strategy's rules are frozen onto the trade: editing the strategy later
  // must not rewrite what past trades were measured against.
  const stratRules: string[] = Array.isArray((haveStrat as { rules?: string[] }).rules)
    ? (haveStrat as { rules: string[] }).rules
    : [];
  const rulesFollowed = pickFrom(t.rulesFollowed, stratRules);

  const row: Record<string, unknown> = {
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
      lots,
      planned_rr: plannedRR,
      result_r: resultR,
      pnl,
      outcome,
      quality,
      notes: String(t.notes || '').slice(0, 2000),
      confidence,
      timezone,
      opened_utc: opened.toISOString(),
      closed_utc: closed ? closed.toISOString() : null,
      exit_reason: exitReason,
      risk_pct: riskPct,
      mistakes,
      emotion,
      rules_followed: rulesFollowed,
      rules_total: stratRules.length,
      session,
      currency,
  };

  const summary = {
    r: resultR,
    plannedRR: plannedRR === null ? '' : plannedRR,
    pnl: pnl === null ? '' : pnl,
    outcome,
    trailed: slTrailed ? 'Yes' : 'No',
    session,
    exitReason,
    risk: risk || '',
    lots: lots ?? '',
    riskPct: riskPct ?? '',
    mistakes,
    emotion: emotion ?? '',
    heldMinutes: closed ? Math.round((closed.getTime() - opened.getTime()) / 60000) : '',
  };

  return { row, summary, screenshotInput: t.shots };
}

/** Add a completed trade for the signed-in user. */
export async function addTrade(bearer: string | undefined, raw: unknown) {
  const who = await requireProfile(bearer);
  const { row, summary, screenshotInput } = await buildTradeRow(who, raw);

  const shots = Array.isArray(screenshotInput) ? screenshotInput.map(String).filter(Boolean) : [];
  const screenshots = await verifyUploaded(who.id, shots);

  const { data, error } = await insertTrade(db(), { ...row, user_id: who.id, screenshots });
  if (error) {
    await removeObjects(screenshots);
    throw new AppError(error.message, 500);
  }
  return { id: data.id as string, ...summary };
}

/**
 * Correct one of MY trades in place. Screenshots are deliberately untouched -
 * fixing a typo should never cost you the chart you attached.
 */
export async function updateTrade(bearer: string | undefined, rawId: unknown, raw: unknown) {
  const who = await requireProfile(bearer);
  const id = uuid(rawId, 'trade');
  const supabase = db();

  const { data: existing, error: findErr } = await supabase
    .from('trades').select('id, user_id, pnl').eq('id', id).maybeSingle();
  if (findErr) throw new AppError(findErr.message, 500);
  if (!existing) throw new AppError('Trade not found.', 404);
  if (existing.user_id !== who.id) throw new AppError('You can only edit your own trades.', 403);

  // Equity already contains this trade's result; take it back out so the risk
  // share is measured against the account as it stood before the trade.
  const { row, summary } = await buildTradeRow(who, raw, Number(existing.pnl) || 0);

  const attempt = { ...row };
  for (let i = 0; i <= OPTIONAL_COLUMNS.length; i += 1) {
    const res = await supabase.from('trades').update(attempt).eq('id', id).eq('user_id', who.id);
    if (!res.error) return { id, ...summary };
    const missing = OPTIONAL_COLUMNS.find((c) => c in attempt && res.error!.message.includes(c));
    if (!missing) throw new AppError(res.error.message, 500);
    delete attempt[missing];
  }
  throw new AppError('Could not save those changes.', 500);
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
