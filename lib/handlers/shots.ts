import { db } from '../supabase';
import { env } from '../env';
import { AppError } from '../errors';
import { requireProfile } from '../auth';
import { MAX_SHOTS } from '../util';

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Screenshots live at "<user id>/<random>.<ext>" so ownership is in the path. */
const PATH_RE = /^[0-9a-f-]{36}\/[0-9a-z]{10,40}\.(jpg|png|webp)$/;

export function ownsPath(userId: string, path: string): boolean {
  return PATH_RE.test(path) && path.startsWith(`${userId}/`);
}

/**
 * Hands the browser short-lived signed upload URLs so image bytes go straight
 * to Supabase Storage. Keeps big uploads out of the serverless function, which
 * has a much smaller request-body budget.
 */
export async function createUploadTickets(bearer: string | undefined, rawTypes: unknown) {
  const who = await requireProfile(bearer);
  const types = Array.isArray(rawTypes) ? rawTypes.map(String) : [];
  if (!types.length) throw new AppError('Nothing to upload.');
  if (types.length > MAX_SHOTS) throw new AppError(`Max ${MAX_SHOTS} screenshots per trade.`);

  const storage = db().storage.from(env.bucket);
  const tickets = [];
  for (const type of types) {
    const ext = EXT[type];
    if (!ext) throw new AppError('Screenshot must be a JPEG, PNG or WebP image.');
    const name = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const path = `${who.id}/${name}.${ext}`;
    const { data, error } = await storage.createSignedUploadUrl(path);
    if (error || !data) throw new AppError(error?.message || 'Could not start the upload.', 500);
    tickets.push({ path: data.path, signedUrl: data.signedUrl, token: data.token });
  }
  return tickets;
}

/** Confirms the objects really landed in storage before they are linked to a trade. */
export async function verifyUploaded(userId: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  if (paths.length > MAX_SHOTS) throw new AppError(`Max ${MAX_SHOTS} screenshots per trade.`);

  const storage = db().storage.from(env.bucket);
  for (const path of paths) {
    if (!ownsPath(userId, path)) throw new AppError('That screenshot could not be attached.');
    const file = path.slice(userId.length + 1);
    const { data, error } = await storage.list(userId, { search: file, limit: 1 });
    if (error) throw new AppError(error.message, 500);
    if (!data?.length) throw new AppError('A screenshot finished uploading but could not be found.');
  }
  return paths;
}

export async function removeObjects(paths: string[]) {
  const clean = (paths || []).filter(Boolean);
  if (!clean.length) return;
  // Best effort: a trade should still delete if its images are already gone.
  await db().storage.from(env.bucket).remove(clean).catch(() => undefined);
}

/**
 * Returns a signed URL for one screenshot. Only files attached to a logged
 * trade can be read, which matches the original journal's rule.
 */
export async function getScreenshot(bearer: string | undefined, rawPath: unknown) {
  await requireProfile(bearer);
  const path = String(rawPath || '');
  if (!PATH_RE.test(path)) throw new AppError('Screenshot not found.', 404);

  const { data: owner, error: ownErr } = await db()
    .from('trades').select('id').contains('screenshots', [path]).limit(1);
  if (ownErr) throw new AppError(ownErr.message, 500);
  if (!owner?.length) throw new AppError('Screenshot not found.', 404);

  const { data, error } = await db().storage.from(env.bucket).createSignedUrl(path, 3600);
  if (error || !data) throw new AppError('Screenshot not found.', 404);
  return data.signedUrl;
}
