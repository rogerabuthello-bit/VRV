import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from './supabase';
import { env } from './env';
import { AuthError, ForbiddenError } from './errors';

export interface Profile {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin' | 'superadmin';
  timezone: string;
  currency: string;
  disabled: boolean;
  created_at: string;
}

export interface Identity {
  /** auth.users id - also the primary key of public.users. */
  id: string;
  email: string;
  /** Null until the account has been claimed with an invite code. */
  profile: Profile | null;
}

/** Reads the bearer token off the request and resolves it with Supabase Auth. */
export async function identify(bearer: string | undefined): Promise<Identity> {
  const jwt = String(bearer || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new AuthError();

  const supabase: SupabaseClient = db();
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user) throw new AuthError();

  const authUser = data.user;
  const { data: rows, error: pErr } = await supabase
    .from('users')
    .select('*')
    .eq('id', authUser.id)
    .maybeSingle();
  if (pErr) throw new AuthError();

  const profile = (rows as Profile | null) ?? null;
  if (profile?.disabled) {
    throw new AuthError('AUTH: this account has been disabled. Contact the journal owner.');
  }

  return { id: authUser.id, email: (authUser.email || '').toLowerCase(), profile };
}

/** Like identify(), but insists the account has finished onboarding. */
export async function requireProfile(bearer: string | undefined): Promise<Identity & { profile: Profile }> {
  const who = await identify(bearer);
  if (!who.profile) {
    throw new AuthError('AUTH: finish setting up your account first.');
  }
  return who as Identity & { profile: Profile };
}

export async function requireAdmin(bearer: string | undefined) {
  const who = await requireProfile(bearer);
  if (who.profile.role !== 'admin' && who.profile.role !== 'superadmin') {
    throw new ForbiddenError('Only the journal owner can do that.');
  }
  return who;
}

export async function requireSuperadmin(bearer: string | undefined) {
  const who = await requireProfile(bearer);
  if (who.profile.role !== 'superadmin') {
    throw new ForbiddenError('Only the superadmin can do that.');
  }
  return who;
}

/**
 * Decides what role a brand-new profile gets.
 *
 * The bootstrap code from the environment works exactly once: it mints the
 * superadmin (username must match SUPERADMIN_USERNAME, and SUPERADMIN_EMAIL
 * when that is set). Everyone else needs a code the superadmin created in the
 * Admin tab.
 */
export function isBootstrapAttempt(invite: string): boolean {
  const boot = env.bootstrapInviteCode;
  return boot.length > 0 && invite === boot;
}
