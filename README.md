# VRV Trading Journal

A multi-user trading journal: log completed trades, score each one on discipline
(Good/Bad Win/Loss) and confidence, and track R, expectancy, profit factor,
drawdown and equity across the whole team.

This is the Google Sheets + Apps Script journal rebuilt to run for real:

| Before (Apps Script) | Now |
| --- | --- |
| Google Sheet tabs | Supabase Postgres |
| Screenshots in Google Drive | Supabase Storage (private bucket) |
| Username + password in a sheet | Supabase Auth — **Google sign-in** or email + password |
| `INVITE_CODE` constant in `Code.gs` | Invite codes created in the **Admin** tab |
| `google.script.run` | `POST /api/rpc` on Vercel |

The dashboard, stats and charts are the same ones you already use.

---

## How accounts work

1. Anyone can *sign in* with Google or an email address — but signing in alone
   gives them nothing.
2. To get a journal they must enter an **invite code**, which only the owner
   (superadmin) or an admin can create.
3. `ROGERB` is the superadmin. That account is created once, with the
   `BOOTSTRAP_INVITE_CODE` from the environment, and from then on it is the only
   account that can promote admins, disable members or delete them. The database
   enforces that exactly one superadmin exists.

---

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run each file in `supabase/migrations/` in order.
   `0001_init.sql` creates the tables, locks them with RLS, and creates the
   private `screenshots` bucket; later files are additive and safe to re-run.
   `/api/health` tells you if one is still pending.
3. **Authentication → Providers → Google**: enable it, and paste in a Google
   OAuth client ID and secret (see below).
4. **Authentication → URL Configuration**: set *Site URL* to your Vercel domain
   and add it under *Redirect URLs* too (plus `http://localhost:3000` if you want
   to run it locally).
5. **Authentication → Providers → Email**: keep it on if you want email +
   password as well. Leave "Confirm email" on for real use — the sign-up screen
   tells people to check their inbox.

#### Google OAuth client

In the [Google Cloud console](https://console.cloud.google.com/apis/credentials):

1. **Create credentials → OAuth client ID → Web application**.
2. Authorised redirect URI:
   `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
3. Copy the client ID and secret into Supabase's Google provider settings.

### 2. Vercel

1. Import this repository at [vercel.com/new](https://vercel.com/new). No build
   step or framework preset is needed — it is a static page plus one serverless
   function.
2. Add the environment variables from [`.env.example`](.env.example) under
   **Settings → Environment Variables**:

   | Variable | Where it comes from |
   | --- | --- |
   | `SUPABASE_URL` | Supabase → Project Settings → API. **The origin only** — `https://<ref>.supabase.co`, with no `/rest/v1` on the end |
   | `SUPABASE_ANON_KEY` | the *anon / publishable* key (`sb_publishable_…`, or a legacy `eyJ…` JWT) |
   | `SUPABASE_SERVICE_ROLE_KEY` | the *service_role / secret* key (`sb_secret_…`, or a legacy `eyJ…` JWT) — **never the publishable one** |
   | `SUPERADMIN_USERNAME` | `ROGERB` |
   | `BOOTSTRAP_INVITE_CODE` | a long random string you invent |
   | `SUPERADMIN_EMAIL` | *(optional)* pins the owner to one Google account |

3. Deploy, then go back to Supabase and make sure the deployed URL is the
   *Site URL* / a *Redirect URL*.

### Position sizing

Each instrument carries what **one pip is worth on one lot** (My Setup →
Instruments). That single number, which your broker publishes, drives
everything else:

```
stop in pips  = |entry - stop| / pip size
money at risk = stop in pips x value per pip x lots
lots          = (equity x risk %) / (stop in pips x value per pip)
```

One formula covers FX, metals, indices and crypto — only the spec changes —
and it holds for shorts, because the stop distance is an absolute value.
Suggested sizes round **down** to your broker's lot step, so the calculator
never proposes more risk than you asked for.

With a spec set, the risk amount on a trade is derived from the lot size
rather than typed, which makes PnL exact instead of an estimate. Without one,
you type the risk amount as before.

### The psychology layer

Performance numbers say *what* happened. These say *why*, which is the part you
can actually change.

- **Mistake tags** — a fixed list (chased entry, moved stop, revenge trade,
  oversized…) ticked per trade. The dashboard ranks them by what each one
  costs: how far that mistake's average R sits below your overall average,
  across every trade you tagged it on. A mistake's own total R would be
  misleading, because some of those trades still win.
- **Feeling at entry** — calm, FOMO, frustrated, tilted… grouped like any
  other dimension, so you can see which states you trade well in.
- **Rule checklists** — a strategy's rules become tick-boxes at entry. The
  dashboard then shows, per rule, your average R when you kept it against when
  you broke it. `rules_total` is frozen onto each trade, so editing a strategy
  later cannot rewrite what past trades were measured against.

Trades can be **edited** in place (screenshots are never touched) and the
current filtered view **exports to CSV**.

### Stuck? Open `/api/health`

Visit `https://your-app.vercel.app/api/health`. It checks every environment
variable, whether the Supabase project is awake, whether the schema was
migrated, whether the Google provider is on, and whether the owner account has
been claimed — and lists what to fix. It returns booleans and counts only, never
a key or any user data.

Two things it cannot see, which break sign-in most often:

- **Vercel Authentication must be OFF** (Vercel → Settings → Deployment
  Protection). While it is on, every `*.vercel.app` URL sits behind a Vercel
  login wall, and the Google redirect coming back from Supabase is intercepted
  before the page can read the `?code=` it needs.
- **Supabase Site URL / Redirect URLs must list your stable domain** — the one
  that does not change per deployment.

### 3. Claim the owner account

1. Open the site, click **Continue with Google**, sign in with your Gmail.
2. On the setup screen enter username `ROGERB` and your `BOOTSTRAP_INVITE_CODE`.
3. You are now superadmin. The **Admin** tab appears.
4. Remove `BOOTSTRAP_INVITE_CODE` from Vercel — it is spent and cannot create a
   second superadmin anyway.

### 4. Invite your traders

Admin tab → **Create an invite code** → send the code to the person. They sign in
with Google, paste the code, pick a handle, and they are in.

Codes can be single-use or shared, can expire, can be revoked, and the table
shows who redeemed each one.

---

## Running locally

```bash
npm install
cp .env.example .env            # fill in real values
npx vercel dev                  # serves index.html + /api/rpc on :3000
```

Add `http://localhost:3000` to Supabase's redirect URLs first, or Google sign-in
will bounce back to production.

```bash
npm run typecheck               # tsc over api/ and lib/
npm run vendor                  # rebuild assets/vendor/supabase.js after an upgrade
```

---

## Layout

```
index.html                 the whole UI (markup + styles)
assets/app.js              dashboard, charts, stats, auth, admin tab
assets/vendor/supabase.js  the Supabase client, bundled and committed so
                           sign-in never depends on a CDN (npm run vendor)
api/rpc.ts                 the single serverless function: { fn, args } -> JSON
lib/
  auth.ts                  verifies the Supabase JWT, loads the profile, role gates
  env.ts, supabase.ts      config and the service-role client
  util.ts                  sessions, UTC offsets, currencies, trade validation
  query.ts                 paged reads and error mapping
  handlers/                one module per area; index.ts is the name -> function map
supabase/migrations/       the schema
```

### Security model

- The browser only ever talks to `/api/rpc`. It sends the Supabase access token
  as a bearer token; the function verifies it before doing anything.
- Every table has RLS enabled with **no policies**, so the anon key cannot read
  or write a single row directly. Only the service-role key — which stays in the
  serverless function — reaches the data.
- Screenshots live in a private bucket. Uploads use short-lived signed upload
  URLs scoped to a path that starts with the uploader's user id; reads go through
  signed URLs that are only issued for images attached to a logged trade.
- Trades, instruments and strategies are visible to every member (that is the
  point of the team dashboard). Deposits and withdrawals stay private to the
  member who recorded them.
