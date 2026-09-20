import { randomBytes } from 'node:crypto';
import { db } from '../supabase';
import { env } from '../env';
import { AppError } from '../errors';
import { requireAdmin, requireSuperadmin } from '../auth';
import { fetchAll, check } from '../query';
import { uuid } from '../util';

/** Human-friendly code: no 0/O/1/I, grouped for reading aloud. */
function generateCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `VRV-${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}`;
}

/* ------------------------------------------------------------ invites */

export async function adminListInvites(bearer: string | undefined) {
  await requireAdmin(bearer);
  const supabase = db();

  const [invites, redemptions, users] = await Promise.all([
    fetchAll<any>(() => supabase.from('invite_codes').select('*').order('created_at', { ascending: false })),
    fetchAll<{ invite_id: string; user_id: string; redeemed_at: string }>(() =>
      supabase.from('invite_redemptions').select('invite_id, user_id, redeemed_at')),
    fetchAll<{ id: string; username: string }>(() => supabase.from('users').select('id, username')),
  ]);

  const nameOf = new Map(users.map((u) => [u.id, u.username]));
  const usedBy = new Map<string, string[]>();
  redemptions.forEach((r) => {
    const list = usedBy.get(r.invite_id) || [];
    list.push(nameOf.get(r.user_id) || 'deleted user');
    usedBy.set(r.invite_id, list);
  });

  return invites.map((i) => ({
    id: i.id,
    code: i.code,
    note: i.note || '',
    maxUses: i.max_uses,
    uses: i.uses,
    expiresAt: i.expires_at || '',
    active: i.active,
    createdBy: nameOf.get(i.created_by) || '',
    createdAt: i.created_at,
    usedBy: usedBy.get(i.id) || [],
    spent: !i.active
      || i.uses >= i.max_uses
      || (!!i.expires_at && new Date(i.expires_at).getTime() < Date.now()),
  }));
}

export async function adminCreateInvite(bearer: string | undefined, raw: unknown) {
  const who = await requireAdmin(bearer);
  const o = (raw || {}) as Record<string, unknown>;

  const custom = String(o.code || '').trim().toUpperCase();
  if (custom && !/^[A-Z0-9-]{6,64}$/.test(custom)) {
    throw new AppError('A custom code may use 6-64 letters, numbers or dashes.');
  }

  const maxUses = Math.min(Math.max(Math.floor(Number(o.maxUses) || 1), 1), 500);
  const days = Number(o.expiresInDays);
  const expires_at = Number.isFinite(days) && days > 0
    ? new Date(Date.now() + Math.min(days, 3650) * 86400000).toISOString()
    : null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = custom || generateCode();
    const { data, error } = await db()
      .from('invite_codes')
      .insert({
        code,
        note: String(o.note || '').slice(0, 200),
        max_uses: maxUses,
        expires_at,
        created_by: who.id,
      })
      .select('id, code')
      .single();

    if (!error) return { id: data.id as string, code: data.code as string, maxUses, expiresAt: expires_at };
    if (/invite_codes_code_upper_key/.test(error.message)) {
      if (custom) throw new AppError('That code already exists.');
      continue;                                   // generated collision - try again
    }
    throw new AppError(error.message, 500);
  }
  throw new AppError('Could not generate a unique code. Try again.', 500);
}

export async function adminSetInviteActive(bearer: string | undefined, id: unknown, active: unknown) {
  await requireAdmin(bearer);
  check(await db().from('invite_codes').update({ active: !!active }).eq('id', uuid(id, 'invite code')));
  return true;
}

export async function adminDeleteInvite(bearer: string | undefined, id: unknown) {
  await requireAdmin(bearer);
  check(await db().from('invite_codes').delete().eq('id', uuid(id, 'invite code')));
  return true;
}

/* -------------------------------------------------------------- users */

export async function adminListUsers(bearer: string | undefined) {
  await requireAdmin(bearer);
  const supabase = db();

  const [users, trades] = await Promise.all([
    fetchAll<any>(() => supabase.from('users').select('*').order('created_at', { ascending: true })),
    fetchAll<{ user_id: string; trade_date: string }>(() => supabase.from('trades').select('user_id, trade_date')),
  ]);

  const stats = new Map<string, { n: number; last: string }>();
  trades.forEach((t) => {
    const s = stats.get(t.user_id) || { n: 0, last: '' };
    s.n += 1;
    if (t.trade_date > s.last) s.last = t.trade_date;
    stats.set(t.user_id, s);
  });

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email || '',
    role: u.role,
    disabled: u.disabled,
    timezone: u.timezone,
    currency: u.currency,
    createdAt: u.created_at,
    trades: stats.get(u.id)?.n || 0,
    lastTrade: stats.get(u.id)?.last || '',
  }));
}

export async function adminSetRole(bearer: string | undefined, id: unknown, role: unknown) {
  const who = await requireSuperadmin(bearer);
  const userId = uuid(id, 'member');
  const next = String(role || '');

  if (!['user', 'admin'].includes(next)) {
    throw new AppError('Role must be "user" or "admin". The superadmin cannot be reassigned here.');
  }
  if (userId === who.id) throw new AppError('You cannot change your own role.');

  const { data: target } = await db().from('users').select('role').eq('id', userId).maybeSingle();
  if (!target) throw new AppError('Member not found.', 404);
  if (target.role === 'superadmin') throw new AppError('The superadmin role cannot be removed.');

  check(await db().from('users').update({ role: next }).eq('id', userId));
  return next;
}

export async function adminSetDisabled(bearer: string | undefined, id: unknown, disabled: unknown) {
  const who = await requireSuperadmin(bearer);
  const userId = uuid(id, 'member');
  if (userId === who.id) throw new AppError('You cannot disable your own account.');

  const { data: target } = await db().from('users').select('role').eq('id', userId).maybeSingle();
  if (!target) throw new AppError('Member not found.', 404);
  if (target.role === 'superadmin') throw new AppError('The superadmin cannot be disabled.');

  check(await db().from('users').update({ disabled: !!disabled }).eq('id', userId));
  return !!disabled;
}

/**
 * Removes the member, their trades, setup and equity log, and the screenshots
 * they uploaded. Deleting the auth user cascades to public.users.
 */
export async function adminDeleteUser(bearer: string | undefined, id: unknown) {
  const who = await requireSuperadmin(bearer);
  const userId = uuid(id, 'member');
  if (userId === who.id) throw new AppError('You cannot delete your own account.');

  const supabase = db();
  const { data: target } = await supabase.from('users').select('role, username').eq('id', userId).maybeSingle();
  if (!target) throw new AppError('Member not found.', 404);
  if (target.role === 'superadmin') throw new AppError('The superadmin cannot be deleted.');

  const { data: objects } = await supabase.storage.from(env.bucket).list(userId, { limit: 1000 });
  if (objects?.length) {
    await supabase.storage.from(env.bucket).remove(objects.map((o) => `${userId}/${o.name}`));
  }

  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) throw new AppError(error.message, 500);
  return true;
}
