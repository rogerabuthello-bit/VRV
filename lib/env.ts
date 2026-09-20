import { AppError } from './errors';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new AppError(`Server is not configured: ${name} is missing.`, 500);
  return v;
}

export const env = {
  /**
   * Normalised to the project origin. The Supabase dashboard shows several
   * URLs and it is easy to copy the REST one ("…supabase.co/rest/v1"); taking
   * the origin means either value works instead of 404-ing every auth call.
   */
  get supabaseUrl() {
    const raw = required('SUPABASE_URL').trim();
    try {
      return new URL(raw).origin;
    } catch {
      throw new AppError('SUPABASE_URL is not a valid URL (expected https://<ref>.supabase.co).', 500);
    }
  },
  get serviceRoleKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },
  /** Safe to hand to the browser: the anon key is designed to be public. */
  get anonKey() {
    return required('SUPABASE_ANON_KEY');
  },
  /** Whoever claims this handle with the bootstrap code becomes superadmin. */
  get superadminUsername() {
    return (process.env.SUPERADMIN_USERNAME || 'ROGERB').trim();
  },
  /** Optional: pin the superadmin to one Google/email account. */
  get superadminEmail() {
    return (process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  },
  /** One-time code that mints the very first (superadmin) account. */
  get bootstrapInviteCode() {
    return (process.env.BOOTSTRAP_INVITE_CODE || '').trim();
  },
  get bucket() {
    return process.env.SUPABASE_SCREENSHOT_BUCKET || 'screenshots';
  },
};
