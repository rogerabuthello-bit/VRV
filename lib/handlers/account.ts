import { db } from '../supabase';
import { env } from '../env';
import { AppError } from '../errors';
import { identify, requireProfile, isBootstrapAttempt, type Identity } from '../auth';
import { fetchAll, check } from '../query';
import {
  validUsername, validTz, validCcy, dateOnly, isoOrEmpty, orBlank, POI_PRESETS,
} from '../util';

interface TradeRow {
  id: string; logged_at: string; trade_date: string; instrument: string; direction: string;
  strategy: string; entry: number; initial_sl: number; final_sl: number; sl_trailed: boolean;
  initial_tp: number | null; exit_price: number; risk: number | null; planned_rr: number | null;
  result_r: number; pnl: number | null; outcome: string; quality: string; notes: string;
  confidence: number; screenshots: string[]; timezone: string; opened_utc: string;
  session: string; currency: string; closed_utc: string | null; exit_reason: string | null;
  lots: number | null; risk_pct: number | null; broker: string | null; commission: number | null;
  mistakes: string[] | null; emotion: string | null;
  rules_followed: string[] | null; rules_total: number | null; poi: string | null;
  trader: { username: string } | null;
}

/** Public: what the browser needs before it can talk to Supabase Auth. */
export function config() {
  return {
    supabaseUrl: env.supabaseUrl,
    supabaseAnonKey: env.anonKey,
  };
}

/**
 * Everything the UI needs in one round trip. All signed-in members see the
 * team's trades, instruments and strategies; deposits stay private.
 */
export async function getBootstrap(bearer: string | undefined) {
  const who: Identity = await identify(bearer);
  if (!who.profile) {
    return { needsOnboarding: true, email: who.email, suggestedUsername: suggest(who.email) };
  }
  const me = who.profile;
  const supabase = db();

  /*
   * Only the owner and admins see the desk. An ordinary member's payload
   * carries nobody else's trades at all, rather than being filtered in the
   * browser - hiding another trader's record behind a UI flag would leave it
   * one devtools tab away.
   */
  const canSeeTeam = me.role === 'admin' || me.role === 'superadmin';
  const mine = <T extends { eq: (c: string, v: string) => T }>(q: T) => (canSeeTeam ? q : q.eq('user_id', me.id));

  const [tradeRows, instrRows, stratRows, memberRows, fundRows] = await Promise.all([
    fetchAll<TradeRow>(() =>
      mine(supabase.from('trades').select('*, trader:users!inner(username)').order('trade_date', { ascending: true }))),
    fetchAll<{
      name: string; broker: string | null; pip_size: number | null; value_per_pip: number | null;
      lot_step: number | null; commission_per_lot: number | null; trader: { username: string } | null;
    }>(() => mine(supabase
      .from('instruments')
      .select('name, broker, pip_size, value_per_pip, lot_step, commission_per_lot, trader:users!inner(username)'))),
    fetchAll<{
      name: string; description: string; rules: string[] | null; pois: string[] | null;
      trader: { username: string } | null;
    }>(() => mine(supabase
      .from('strategies').select('name, description, rules, pois, trader:users!inner(username)'))),
    fetchAll<{ username: string }>(() => {
      const q = supabase.from('users').select('username').eq('disabled', false);
      return canSeeTeam ? q : q.eq('id', me.id);
    }),
    fetchAll<{ id: string; entry_date: string; type: string; amount: string; currency: string; note: string }>(() =>
      supabase.from('funds').select('id, entry_date, type, amount, currency, note').eq('user_id', me.id)),
  ]);

  return {
    me: me.username,
    role: me.role,
    canSeeTeam,
    email: me.email,
    tz: me.timezone || '',
    ccy: me.currency || '',
    riskPct: (me as unknown as { default_risk_pct?: number }).default_risk_pct ?? 1,
    broker: (me as unknown as { active_broker?: string }).active_broker || '',
    brokers: (me as unknown as { brokers?: string[] }).brokers || [],
    pois: (me as unknown as { pois?: string[] }).pois || [],
    members: memberRows.map((r) => r.username).filter(Boolean).sort(),
    funds: fundRows.map((f) => ({
      id: f.id,
      date: dateOnly(f.entry_date),
      type: f.type,
      amount: Number(f.amount),
      currency: f.currency,
      note: f.note,
    })),
    instruments: instrRows.map((r) => ({
      trader: r.trader?.username || '',
      name: r.name,
      broker: r.broker || '',
      pipSize: r.pip_size,
      valuePerPip: r.value_per_pip,
      lotStep: r.lot_step || 0.01,
      commissionPerLot: r.commission_per_lot || 0,
    })),
    strategies: stratRows.map((r) => ({
      trader: r.trader?.username || '', name: r.name, description: r.description || '',
      rules: r.rules || [],
      pois: r.pois || [],
    })),
    trades: tradeRows.map((t) => ({
      id: t.id,
      loggedAt: isoOrEmpty(t.logged_at),
      trader: t.trader?.username || '',
      date: dateOnly(t.trade_date),
      instrument: t.instrument,
      direction: t.direction,
      strategy: t.strategy,
      entry: t.entry,
      sl: t.initial_sl,
      finalSl: t.final_sl,
      trailed: t.sl_trailed ? 'Yes' : 'No',
      tp: orBlank(t.initial_tp),
      exit: t.exit_price,
      risk: orBlank(t.risk),
      plannedRR: orBlank(t.planned_rr),
      r: t.result_r,
      pnl: orBlank(t.pnl),
      outcome: t.outcome,
      quality: t.quality,
      notes: t.notes || '',
      confidence: t.confidence,
      shots: t.screenshots || [],
      timezone: t.timezone || '',
      openedUtc: isoOrEmpty(t.opened_utc),
      closedUtc: isoOrEmpty(t.closed_utc),
      exitReason: t.exit_reason || '',
      lots: orBlank(t.lots),
      commission: t.commission || 0,
      riskPct: orBlank(t.risk_pct),
      broker: t.broker || '',
      mistakes: t.mistakes || [],
      emotion: t.emotion || '',
      rulesFollowed: t.rules_followed || [],
      rulesTotal: t.rules_total || 0,
      poi: t.poi || '',
      session: t.session || '',
      currency: t.currency || '',
    })),
  };
}

function suggest(email: string): string {
  const base = (email.split('@')[0] || '').replace(/[^A-Za-z0-9_]/g, '');
  return base.length >= 3 ? base.slice(0, 20) : '';
}

/**
 * Turns a freshly authenticated Google/email identity into a journal account.
 * This is the only place a profile row is created, and it always costs an
 * invite code.
 */
export async function completeOnboarding(
  bearer: string | undefined,
  rawUsername: unknown,
  rawInvite: unknown,
  rawTz: unknown,
  rawCcy: unknown,
) {
  const who = await identify(bearer);
  if (who.profile) return { username: who.profile.username, role: who.profile.role };

  const username = validUsername(rawUsername);
  const invite = String(rawInvite || '').trim();
  if (!invite) throw new AppError('An invite code is required.');

  const supabase = db();
  const timezone = validTz(rawTz) || 'UTC';
  const currency = validCcy(rawCcy) || 'USD';

  const bootstrap = isBootstrapAttempt(invite);
  let inviteId: string | null = null;
  let role: 'user' | 'superadmin' = 'user';

  if (bootstrap) {
    const { count, error } = await supabase
      .from('users').select('id', { count: 'exact', head: true }).eq('role', 'superadmin');
    if (error) throw new AppError(error.message, 500);
    if ((count || 0) > 0) throw new AppError('Wrong invite code.');

    if (username.toLowerCase() !== env.superadminUsername.toLowerCase()) {
      throw new AppError(`The setup code only works for the username "${env.superadminUsername}".`);
    }
    if (env.superadminEmail && who.email !== env.superadminEmail) {
      throw new AppError('The setup code is reserved for the owner account.');
    }
    role = 'superadmin';
  } else {
    inviteId = await redeemableInviteId(invite);
    if (username.toLowerCase() === env.superadminUsername.toLowerCase()) {
      throw new AppError('That username is reserved.');
    }
  }

  const { error: insErr } = await supabase.from('users').insert({
    id: who.id,
    username,
    email: who.email,
    role,
    timezone,
    currency,
  });
  if (insErr) {
    if (/users_username_lower_key/.test(insErr.message)) throw new AppError('That username is taken.');
    if (/users_single_superadmin_idx/.test(insErr.message)) throw new AppError('Wrong invite code.');
    if (/users_pkey/.test(insErr.message)) throw new AppError('This account is already set up. Reload the page.');
    throw new AppError(insErr.message, 500);
  }

  if (inviteId) await consumeInvite(inviteId, who.id);

  return { username, role };
}

/** Finds a code that is active, unexpired and still has uses left. */
async function redeemableInviteId(code: string): Promise<string> {
  const supabase = db();
  const { data, error } = await supabase
    .from('invite_codes')
    .select('id, max_uses, uses, expires_at, active')
    .eq('code_upper', code.toUpperCase())
    .maybeSingle();
  if (error) throw new AppError(error.message, 500);
  if (!data) throw new AppError('Wrong invite code.');
  if (!data.active) throw new AppError('That invite code has been revoked.');
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    throw new AppError('That invite code has expired.');
  }
  if (data.uses >= data.max_uses) throw new AppError('That invite code has already been used.');
  return data.id as string;
}

async function consumeInvite(inviteId: string, userId: string) {
  const supabase = db();
  const { data } = await supabase.from('invite_codes').select('uses').eq('id', inviteId).maybeSingle();
  check(await supabase
    .from('invite_codes')
    .update({ uses: (data?.uses || 0) + 1 })
    .eq('id', inviteId));
  check(await supabase.from('invite_redemptions').insert({ invite_id: inviteId, user_id: userId }));
}

/** Save MY default base currency (e.g. "CAD"). */
export async function saveCurrency(bearer: string | undefined, raw: unknown) {
  const who = await requireProfile(bearer);
  const ccy = validCcy(raw);
  if (!ccy) throw new AppError('Unknown currency.');
  check(await db().from('users').update({ currency: ccy }).eq('id', who.id));
  return ccy;
}

/** Save MY default timezone as a UTC/GMT offset, e.g. "UTC-05:00". */
export async function saveTimezone(bearer: string | undefined, raw: unknown) {
  const who = await requireProfile(bearer);
  const tz = validTz(raw);
  if (!tz) throw new AppError('Unknown timezone.');
  check(await db().from('users').update({ timezone: tz }).eq('id', who.id));
  return tz;
}

/** The risk-per-trade plan every trade is then measured against. */
export async function saveRiskPct(bearer: string | undefined, raw: unknown) {
  const who = await requireProfile(bearer);
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    throw new AppError('Risk per trade must be between 0 and 100 percent.');
  }
  const { error } = await db().from('users').update({ default_risk_pct: pct }).eq('id', who.id);
  if (error) {
    if (/default_risk_pct/.test(error.message)) {
      throw new AppError('Run migration 0004 in Supabase to save a risk plan.');
    }
    throw new AppError(error.message, 500);
  }
  return pct;
}

const cleanBrokerName = (v: unknown) => String(v || '').trim().slice(0, 60);

async function brokerList(userId: string): Promise<string[]> {
  const { data } = await db().from('users').select('brokers').eq('id', userId).maybeSingle();
  return ((data as { brokers?: string[] } | null)?.brokers) || [];
}

function brokerColumnError(message: string): AppError | null {
  return /brokers|active_broker/.test(message)
    ? new AppError('Run migrations 0006 and 0007 in Supabase to use brokers.')
    : null;
}

/** Which broker's settings the journal is working with right now. */
export async function saveBroker(bearer: string | undefined, raw: unknown) {
  const who = await requireProfile(bearer);
  const broker = cleanBrokerName(raw);
  const { error } = await db().from('users').update({ active_broker: broker }).eq('id', who.id);
  if (error) throw brokerColumnError(error.message) || new AppError(error.message, 500);
  return broker;
}

/** Add a broker to my list and switch to it. */
export async function addBroker(bearer: string | undefined, raw: unknown) {
  const who = await requireProfile(bearer);
  const name = cleanBrokerName(raw);
  if (!name) throw new AppError('Give the broker a name.');

  const list = await brokerList(who.id);
  if (list.some((b) => b.toLowerCase() === name.toLowerCase())) {
    throw new AppError(`"${name}" is already in your list.`);
  }
  if (list.length >= 20) throw new AppError('That is as many brokers as the journal tracks.');

  const brokers = [...list, name].sort((a, b) => a.localeCompare(b));
  const { error } = await db().from('users')
    .update({ brokers, active_broker: name }).eq('id', who.id);
  if (error) throw brokerColumnError(error.message) || new AppError(error.message, 500);
  return { brokers, active: name };
}

/**
 * Remove a broker. Refuses while instruments still hang off it, because the
 * pip values set up there are exactly what the broker exists to hold.
 */
export async function removeBroker(bearer: string | undefined, raw: unknown) {
  const who = await requireProfile(bearer);
  const name = cleanBrokerName(raw);
  const supabase = db();

  const { count, error: cErr } = await supabase
    .from('instruments').select('id', { count: 'exact', head: true })
    .eq('user_id', who.id).eq('broker', name);
  if (cErr) throw new AppError(cErr.message, 500);
  if ((count || 0) > 0) {
    throw new AppError(
      `"${name}" still has ${count} instrument${count === 1 ? '' : 's'}. Remove those first.`,
    );
  }

  const brokers = (await brokerList(who.id)).filter((b) => b !== name);
  const active = (who.profile as unknown as { active_broker?: string }).active_broker;
  const patch: Record<string, unknown> = { brokers };
  if (active === name) patch.active_broker = brokers[0] || '';

  const { error } = await supabase.from('users').update(patch).eq('id', who.id);
  if (error) throw brokerColumnError(error.message) || new AppError(error.message, 500);
  return { brokers, active: (patch.active_broker as string) ?? active ?? '' };
}

/**
 * The points of interest this trader watches. Kept on the trader rather than
 * the strategy: the same level gets read by several models, and which POI
 * works with which strategy is only answerable once the two vary separately.
 */
export async function addPoi(bearer: string | undefined, raw: unknown) {
  const who = await requireProfile(bearer);
  const name = String(raw || '').trim().slice(0, 80);
  if (!name) throw new AppError('Give the point of interest a name.');

  const list = await poiList(who.id);
  if (list.some((v) => v.toLowerCase() === name.toLowerCase())) {
    throw new AppError(`"${name}" is already in your list.`);
  }
  if (list.length >= 40) throw new AppError('That is as many points of interest as the journal tracks.');

  const pois = [...list, name].sort((a, b) => a.localeCompare(b));
  const { error } = await db().from('users').update({ pois }).eq('id', who.id);
  if (error) throw poiColumnError(error.message) || new AppError(error.message, 500);
  return pois;
}

/** Fills the library with a starting vocabulary, skipping anything already there. */
export async function addPoiPreset(bearer: string | undefined) {
  const who = await requireProfile(bearer);
  const list = await poiList(who.id);
  const lower = new Set(list.map((v) => v.toLowerCase()));
  const fresh = POI_PRESETS.filter((v) => !lower.has(v.toLowerCase()));
  if (!fresh.length) return list;

  const pois = [...list, ...fresh].sort((a, b) => a.localeCompare(b));
  const { error } = await db().from('users').update({ pois }).eq('id', who.id);
  if (error) throw poiColumnError(error.message) || new AppError(error.message, 500);
  return pois;
}

export async function removePoi(bearer: string | undefined, raw: unknown) {
  const who = await requireProfile(bearer);
  const name = String(raw || '').trim();
  const pois = (await poiList(who.id)).filter((v) => v !== name);
  const { error } = await db().from('users').update({ pois }).eq('id', who.id);
  if (error) throw poiColumnError(error.message) || new AppError(error.message, 500);
  return pois;
}

async function poiList(userId: string): Promise<string[]> {
  const { data } = await db().from('users').select('pois').eq('id', userId).maybeSingle();
  return ((data as { pois?: string[] } | null)?.pois) || [];
}

function poiColumnError(message: string): AppError | null {
  return /pois/.test(message)
    ? new AppError('Run migration 0009 in Supabase to use points of interest.')
    : null;
}

/** Lets a member rename their own handle. */
export async function saveUsername(bearer: string | undefined, raw: unknown) {
  const who = await requireProfile(bearer);
  const username = validUsername(raw);
  if (username.toLowerCase() !== who.profile.username.toLowerCase()
    && username.toLowerCase() === env.superadminUsername.toLowerCase()) {
    throw new AppError('That username is reserved.');
  }
  const { error } = await db().from('users').update({ username }).eq('id', who.id);
  if (error) {
    if (/users_username_lower_key/.test(error.message)) throw new AppError('That username is taken.');
    throw new AppError(error.message, 500);
  }
  return username;
}
