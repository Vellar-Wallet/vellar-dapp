// Typed errors for marketplace-service. Every route funnels failures through
// these so the HTTP surface is uniform: one `{ error, message }` body shape and
// one status mapping, rather than per-route ad-hoc replies.

export class MarketplaceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceError";
  }

  /** The JSON body sent to the client. Deliberately excludes stack/cause. */
  toBody(): { error: string; message: string } {
    return { error: this.code, message: this.message };
  }
}

export class NotFoundError extends MarketplaceError {
  constructor(message = "Not found", code = "not_found") {
    super(404, code, message);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends MarketplaceError {
  constructor(message = "Invalid request", code = "invalid_request") {
    super(400, code, message);
    this.name = "ValidationError";
  }
}

/**
 * An upstream failure from vellar-facilitator. `upstreamStatus` is the status
 * the facilitator returned (0 for a transport/timeout failure); `status` is what
 * WE return to the client. A facilitator 4xx is a bad gateway from our side —
 * the client's request to us was well-formed — so anything that isn't a 5xx or
 * a transport error still surfaces as 502 unless explicitly overridden.
 */
export class FacilitatorError extends MarketplaceError {
  constructor(
    readonly upstreamStatus: number,
    message: string,
    status = 502,
    code = "facilitator_error",
  ) {
    super(status, code, message);
    this.name = "FacilitatorError";
  }
}

export class SignatureError extends MarketplaceError {
  constructor(message = "Signature verification failed", code = "invalid_signature") {
    super(401, code, message);
    this.name = "SignatureError";
  }
}

/** Invalid, expired, already-used, or wrong-address nonce. Deliberately 400 and
 * deliberately one class: the response must not tell a caller WHICH of those it
 * was, or it becomes an oracle for probing live nonces. */
export class NonceError extends MarketplaceError {
  constructor(message = "Invalid or expired nonce", code = "invalid_nonce") {
    super(400, code, message);
    this.name = "NonceError";
  }
}
