/** Domain errors. Gateway maps these to HTTP status codes; core never touches HTTP. */

export class RateLimiterError extends Error {
  override name = 'RateLimiterError';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends RateLimiterError {
  override name = 'ValidationError';
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export interface StoreErrorDetails {
  store: string;
  operation: string;
}

export class StoreError extends RateLimiterError {
  override name = 'StoreError';
  readonly store: string;
  readonly operation: string;

  constructor(message: string, details: StoreErrorDetails, options?: ErrorOptions) {
    super(`[${details.store}:${details.operation}] ${message}`, options);
    Object.setPrototypeOf(this, StoreError.prototype);
    this.store = details.store;
    this.operation = details.operation;
  }
}

export class RedisConnectionError extends StoreError {
  override name = 'RedisConnectionError';
  constructor(message: string, options?: ErrorOptions) {
    super(message, { store: 'redis', operation: 'connect' }, options);
    Object.setPrototypeOf(this, RedisConnectionError.prototype);
  }
}

export class StoreTimeoutError extends StoreError {
  override name = 'StoreTimeoutError';
  constructor(store: string, operation: string, timeoutMs: number) {
    super(`operation timed out after ${timeoutMs}ms`, { store, operation });
    Object.setPrototypeOf(this, StoreTimeoutError.prototype);
  }
}
