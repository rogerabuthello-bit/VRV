import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * GET /api/health - setup checker.
 *
 * "It doesn't work" is almost always one of: a missing environment variable,
 * a Supabase project that is paused, a schema that was never migrated, or a
 * Google provider that was never switched on. This reports all of them at
 * once.
 *
 * It deliberately returns only booleans, counts and the project ref. No keys,
 * no user data. The project ref and anon key are already public by design -
 * /api/rpc serves them to the browser so it can talk to Supabase.
 */

type Check = { ok: boolean; detail: string };

const ok = (detail: string): Check => ({ ok: true, detail });
const bad = (detail: string): Check => ({ ok: false, detail });

/** Supabase issues legacy JWT keys and the newer sb_publishable_ / sb_secret_ pair. */
function kind(key: string): 'publishable' | 'secret' | 'legacy' | 'unknown' {
  if (key.startsWith('sb_publishable_')) return 'publishable';
  if (key.startsWith('sb_secret_')) return 'secret';
  if (key.startsWith('eyJ')) return 'legacy';
  return 'unknown';
}

function label(key: string): string {
  switch (kind(key)) {
    case 'publishable': return 'publishable key (new format)';
    case 'secret': return 'secret key (new format)';
    case 'legacy': return 'legacy JWT key';
    default: return 'unrecognised key format';
  }
}

/**
 * GoTrue packs the address it will return the user to into the `state` token.
 * Read only - this is a diagnostic, nothing is trusted from it.
 */
function readState(token: string): Record<string, unknown> | null {
  try {
    const body = token.split('.')[1];
    if (!body) return null;
    const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');

  const rawUrl = (process.env.SUPABASE_URL || '').trim();
  let url = '';
  let urlHadPath = false;
  try {
    const parsed = new URL(rawUrl);
    url = parsed.origin;
    urlHadPath = parsed.pathname.replace(/\/+$/, '') !== '';
  } catch { /* reported below */ }
  const anon = process.env.SUPABASE_ANON_KEY || '';
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const superadmin = (process.env.SUPERADMIN_USERNAME || 'ROGERB').trim();
  const bootstrap = (process.env.BOOTSTRAP_INVITE_CODE || '').trim();
  const bucket = process.env.SUPABASE_SCREENSHOT_BUCKET || 'screenshots';

  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const origin = host ? `https://${host}` : '';

  const checks: Record<string, Check> = {};
  const next: string[] = [];

  /* ---------------------------------------------------------- environment */
  checks.SUPABASE_URL = !rawUrl
    ? bad('missing - add it in Vercel > Settings > Environment Variables')
    : !url
      ? bad(`"${rawUrl}" is not a valid URL - it should be https://<ref>.supabase.co`)
      : urlHadPath
        ? ok(`${url} (a path was trimmed off "${rawUrl}" - set it to the origin only)`)
        : ok(url);

  checks.SUPABASE_ANON_KEY = !anon
    ? bad('missing - the page cannot start Supabase without it')
    : kind(anon) === 'secret'
      ? bad('this looks like a SECRET key. It is served to every visitor - swap it for '
            + 'the publishable/anon key and rotate the secret immediately.')
      : ok(`${label(anon)}, ${anon.length} chars`);

  checks.SUPABASE_SERVICE_ROLE_KEY = !service
    ? bad('missing - every signed-in request will fail')
    : kind(service) === 'publishable'
      ? bad('this is a publishable/anon key, not a secret one. It cannot bypass RLS, '
            + 'so every read returns nothing. Use the service_role or sb_secret_ key.')
      : ok(`${label(service)}, ${service.length} chars`);
  checks.SUPERADMIN_USERNAME = ok(superadmin);
  checks.BOOTSTRAP_INVITE_CODE = bootstrap
    ? ok('set - the owner account can still be claimed')
    : bad('not set - fine once ROGERB exists, required before that');

  const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co$/i.exec(url)?.[1] || '';
  checks.supabaseProjectRef = ref
    ? ok(ref)
    : bad(url ? 'SUPABASE_URL is not a https://<ref>.supabase.co address' : 'unknown');

  /* ------------------------------------------------- is the project awake */
  let awake = false;
  if (url && anon) {
    try {
      const r = await withTimeout(
        fetch(`${url}/auth/v1/settings`, { headers: { apikey: anon } }),
        8000,
      );
      if (r.ok) {
        awake = true;
        const settings = (await r.json()) as {
          external?: Record<string, boolean>;
          disable_signup?: boolean;
        };
        const providers = settings.external || {};
        checks.supabaseReachable = ok('project is awake and answering');
        checks.googleSignIn = providers.google
          ? ok('enabled')
          : bad('DISABLED - turn on Authentication > Providers > Google in Supabase');
        /*
         * Supabase's built-in SMTP "will refuse to deliver messages to
         * addresses that are not part of the project's team". So email signup
         * silently reaches nobody outside your Supabase org until a custom
         * SMTP server is configured - which looks exactly like a broken app.
         */
        checks.emailSignIn = providers.email
          ? ok('enabled - but see emailDelivery below')
          : ok('disabled - everyone signs in with Google, which needs no email');
        if (providers.email) {
          checks.emailDelivery = bad(
            'Supabase\'s built-in email only delivers to members of your Supabase '
            + 'organisation. Anyone else gets NO confirmation mail and cannot finish '
            + 'signing up. Either add custom SMTP under Authentication > Emails > SMTP '
            + 'Settings, or have people use "Continue with Google", which sends no email.',
          );
        }
        /*
         * Ask Supabase to start a Google sign-in and read back where it says
         * it will return the user. An address that is not on the allow list is
         * silently swapped for the Site URL - which defaults to localhost -
         * and the trader lands on a dead page having never reached the app.
         */
        if (providers.google && origin) {
          try {
            const back = `${origin}/`;
            const probe = await withTimeout(fetch(
              `${url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(back)}`,
              { redirect: 'manual', headers: { apikey: anon } },
            ), 8000);
            const loc = probe.headers.get('location') || '';

            if (/^https:\/\/accounts\.google\.com\//.test(loc)) {
              const state = new URL(loc).searchParams.get('state') || '';
              const lands = String(readState(state)?.referrer || '');
              checks.googleRedirect = lands.startsWith(origin)
                ? ok(`Google returns the user to ${lands}`)
                : bad(
                  `Google would return the user to "${lands || 'the Site URL'}", not ${origin}. `
                  + `That page is where sign-in dies. Add ${origin} as the Site URL AND under `
                  + 'Redirect URLs in Supabase > Authentication > URL Configuration.',
                );
            } else {
              checks.googleRedirect = bad(
                `Supabase did not hand off to Google (HTTP ${probe.status}`
                + `${loc ? `, sent to ${loc.slice(0, 200)}` : ''}). `
                + 'Check the client ID and secret under Authentication > Providers > Google.',
              );
            }
          } catch (e) {
            checks.googleRedirect = bad(`could not test the Google hand-off (${(e as Error).message})`);
          }
        }

        checks.signupsAllowed = settings.disable_signup
          ? bad('signups are disabled in Supabase, so nobody new can be created')
          : ok('allowed');
      } else {
        checks.supabaseReachable = bad(
          r.status === 404
            ? `auth endpoint returned 404 - SUPABASE_URL is pointing at "${rawUrl}". `
              + 'It must be the project origin, with no /rest/v1 or other path.'
            : r.status === 401
              ? 'auth endpoint returned 401 - the anon/publishable key does not match this project.'
              : `auth endpoint returned HTTP ${r.status}`,
        );
      }
    } catch (e) {
      checks.supabaseReachable = bad(
        `cannot reach the project (${(e as Error).message}) - it is probably PAUSED. `
        + 'Open the Supabase dashboard and restore it.',
      );
    }
  } else {
    checks.supabaseReachable = bad('skipped - URL or anon key missing');
  }

  /* --------------------------------------------------- schema and storage */
  if (awake && service) {
    const rest = async (path: string) => withTimeout(
      fetch(`${url}/rest/v1/${path}`, {
        headers: { apikey: service, Authorization: `Bearer ${service}`, Prefer: 'count=exact' },
      }),
      8000,
    );

    try {
      const r = await rest('users?select=id&limit=1');
      if (r.status === 404 || r.status === 400) {
        checks.schema = bad('tables are missing - run supabase/migrations/0001_init.sql in the SQL editor');
      } else if (!r.ok) {
        checks.schema = bad(`users table returned HTTP ${r.status} (is the service_role key correct?)`);
      } else {
        checks.schema = ok('tables exist');
        const range = r.headers.get('content-range') || '';
        const total = Number(range.split('/')[1]);
        checks.members = ok(Number.isFinite(total) ? `${total} account(s)` : 'unknown');

        const closed = await rest('trades?select=closed_utc&limit=1');
        checks.tradeCloseTime = closed.ok
          ? ok('recorded')
          : bad('migration 0002 not applied - run supabase/migrations/0002_trade_closed_at.sql. '
                + 'Trades still save, just without a close time.');

        const reason = await rest('trades?select=exit_reason&limit=1');
        checks.tradeExitReason = reason.ok
          ? ok('recorded')
          : bad('migration 0003 not applied - run supabase/migrations/0003_exit_reason.sql.');

        const sizing = await rest('trades?select=lots,risk_pct&limit=1');
        checks.positionSizing = sizing.ok
          ? ok('recorded')
          : bad('migration 0004 not applied - run supabase/migrations/0004_position_sizing.sql.');

        const psych = await rest('trades?select=mistakes,emotion,rules_followed&limit=1');
        checks.tradePsychology = psych.ok
          ? ok('recorded')
          : bad('migration 0005 not applied - run supabase/migrations/0005_psychology.sql.');

        const brokers = await rest('instruments?select=broker&limit=1');
        checks.brokers = brokers.ok
          ? ok('recorded')
          : bad('migration 0006 not applied - run supabase/migrations/0006_brokers.sql. '
                + 'Until then every instrument belongs to one unnamed broker.');

        const sa = await rest('users?select=username&role=eq.superadmin&limit=1');
        if (sa.ok) {
          const rows = (await sa.json()) as { username: string }[];
          checks.superadminClaimed = rows.length
            ? ok(`${rows[0].username} owns this journal`)
            : bad(`not claimed yet - sign in and enter "${superadmin}" with the bootstrap code`);
        }
      }
    } catch (e) {
      checks.schema = bad(`could not check (${(e as Error).message})`);
    }

    try {
      const r = await withTimeout(
        fetch(`${url}/storage/v1/bucket/${bucket}`, {
          headers: { apikey: service, Authorization: `Bearer ${service}` },
        }),
        8000,
      );
      checks.screenshotBucket = r.ok
        ? ok(`"${bucket}" exists`)
        : bad(`"${bucket}" missing (HTTP ${r.status}) - the migration creates it`);
    } catch (e) {
      checks.screenshotBucket = bad(`could not check (${(e as Error).message})`);
    }
  } else {
    checks.schema = bad('skipped - project unreachable or service key missing');
  }

  /* ----------------------------------------------------- redirect targets */
  checks.thisOrigin = ok(origin || 'unknown');

  for (const [name, c] of Object.entries(checks)) {
    if (!c.ok) next.push(`${name}: ${c.detail}`);
  }

  if (origin) {
    next.push(
      'In Supabase > Authentication > URL Configuration, Site URL and Redirect URLs '
      + `must include ${origin} (use your stable domain, not a per-deployment URL).`,
    );
    next.push(
      'In Vercel > Settings > Deployment Protection, Vercel Authentication must be OFF, '
      + 'or the Google redirect back from Supabase is intercepted by the Vercel login wall.',
    );
  }

  const healthy = Object.values(checks).every((c) => c.ok);
  res.status(200).json({
    ok: healthy,
    summary: healthy ? 'All checks passed.' : 'Setup is incomplete - see failing below.',
    failing: Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k),
    checks,
    next,
  });
}
