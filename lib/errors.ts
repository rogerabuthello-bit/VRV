/** An error whose message is safe to show to the user. */
export class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

/**
 * Messages that start with "AUTH" tell the browser to drop its session and
 * show the login screen again, so keep that prefix for anything the user can
 * only fix by signing in.
 */
export class AuthError extends AppError {
  constructor(message = 'AUTH: please log in again.') {
    super(message.startsWith('AUTH') ? message : `AUTH: ${message}`, 401);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to that.') {
    super(message, 403);
    this.name = 'ForbiddenError';
  }
}
