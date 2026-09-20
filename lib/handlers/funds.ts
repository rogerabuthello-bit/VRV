import { db } from '../supabase';
import { AppError } from '../errors';
import { requireProfile } from '../auth';
import { fetchAll, check } from '../query';
import { round, validCcy, isIsoDate, todayIn, uuid } from '../util';

/** Balance of ONE currency for a trader = deposits - withdrawals + trade PnL. */
async function balance(userId: string, ccy: string): Promise<number> {
  const supabase = db();
  const [funds, trades] = await Promise.all([
    fetchAll<{ type: string; amount: string }>(() =>
      supabase.from('funds').select('type, amount').eq('user_id', userId).eq('currency', ccy)),
    fetchAll<{ pnl: number | null }>(() =>
      supabase.from('trades').select('pnl').eq('user_id', userId).eq('currency', ccy)),
  ]);
  let b = 0;
  funds.forEach((f) => { b += (f.type === 'Deposit' ? 1 : -1) * (Number(f.amount) || 0); });
  trades.forEach((t) => { b += Number(t.pnl) || 0; });
  return b;
}

/** Record a deposit or withdrawal on MY account. */
export async function addFunds(bearer: string | undefined, raw: unknown) {
  const who = await requireProfile(bearer);
  const f = (raw || {}) as Record<string, unknown>;

  const type = f.type === 'Withdrawal' ? 'Withdrawal' : f.type === 'Deposit' ? 'Deposit' : '';
  if (!type) throw new AppError('Choose Deposit or Withdrawal.');

  const amount = round(Number(f.amount), 2);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError('Enter an amount greater than 0.');
  if (amount > 1e12) throw new AppError('That amount is too large.');

  const currency = validCcy(f.currency) || who.profile.currency || 'USD';
  const entry_date = isIsoDate(f.date) ? String(f.date) : todayIn(who.profile.timezone || 'UTC');

  if (type === 'Withdrawal') {
    const bal = await balance(who.id, currency);
    if (amount > bal + 0.005) {
      throw new AppError(
        `Withdrawal (${amount}) is more than your current ${currency} equity (${round(bal, 2)}).`,
      );
    }
  }

  const { data, error } = await db()
    .from('funds')
    .insert({
      user_id: who.id,
      entry_date,
      type,
      amount,
      currency,
      note: String(f.note || '').slice(0, 200),
    })
    .select('id')
    .single();
  if (error) throw new AppError(error.message, 500);

  return { id: data.id as string, type, amount, currency, date: entry_date };
}

/** Remove one of MY deposit/withdrawal entries (e.g. a typo). */
export async function deleteFunds(bearer: string | undefined, id: unknown) {
  const who = await requireProfile(bearer);
  const { data, error } = await db()
    .from('funds')
    .delete()
    .eq('id', uuid(id, 'entry'))
    .eq('user_id', who.id)
    .select('id');
  check({ error });
  return (data || []).length > 0;
}
