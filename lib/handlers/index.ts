import * as account from './account';
import * as setup from './setup';
import * as funds from './funds';
import * as trades from './trades';
import * as shots from './shots';
import * as admin from './admin';

type Handler = (bearer: string | undefined, ...args: unknown[]) => unknown | Promise<unknown>;

/**
 * The browser calls these by name, exactly like the original
 * `google.script.run.<fn>(...)` did. Every handler takes the caller's bearer
 * token first and is responsible for its own authorisation.
 */
export const handlers: Record<string, Handler> = {
  // account + data
  getBootstrap: account.getBootstrap,
  completeOnboarding: account.completeOnboarding as Handler,
  saveCurrency: account.saveCurrency as Handler,
  saveTimezone: account.saveTimezone as Handler,
  saveUsername: account.saveUsername as Handler,

  // my setup
  addInstrument: setup.addInstrument as Handler,
  removeInstrument: setup.removeInstrument as Handler,
  saveStrategy: setup.saveStrategy as Handler,
  removeStrategy: setup.removeStrategy as Handler,

  // equity log
  addFunds: funds.addFunds as Handler,
  deleteFunds: funds.deleteFunds as Handler,

  // journal
  addTrade: trades.addTrade as Handler,
  deleteTrade: trades.deleteTrade as Handler,
  addShots: trades.addShots as Handler,

  // screenshots
  createUploadTickets: shots.createUploadTickets as Handler,
  getScreenshot: shots.getScreenshot as Handler,

  // admin
  adminListInvites: admin.adminListInvites as Handler,
  adminCreateInvite: admin.adminCreateInvite as Handler,
  adminSetInviteActive: admin.adminSetInviteActive as Handler,
  adminDeleteInvite: admin.adminDeleteInvite as Handler,
  adminListUsers: admin.adminListUsers as Handler,
  adminSetRole: admin.adminSetRole as Handler,
  adminSetDisabled: admin.adminSetDisabled as Handler,
  adminDeleteUser: admin.adminDeleteUser as Handler,
};

/** Callable without a session - used to bootstrap the Supabase browser client. */
export const publicHandlers: Record<string, () => unknown> = {
  config: account.config,
};
