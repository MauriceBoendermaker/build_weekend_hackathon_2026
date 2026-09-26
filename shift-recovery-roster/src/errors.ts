/**
 * Error taxonomy.
 *
 * Every failure carries a stable `code` so the n8n workflow can branch on it without
 * parsing prose, and a `retryable` hint so the HTTP layer knows what to do. Messages are
 * passed through {@link redact} before they reach a log or the dataset, because API
 * responses and URLs occasionally echo the credential back at us.
 */

/** Stable machine-readable failure codes. Referenced from the README. */
export type ErrorCode =
    | 'INPUT_INVALID'
    | 'CREDENTIALS_MISSING'
    | 'CREDENTIALS_INVALID'
    | 'UNAUTHORIZED'
    | 'RATE_LIMITED'
    | 'UPSTREAM_ERROR'
    | 'UPSTREAM_TIMEOUT'
    | 'NETWORK_ERROR'
    | 'MALFORMED_RESPONSE'
    | 'METADATA_SOURCE_ERROR'
    | 'EMPTY_RESULT'
    | 'UNEXPECTED_ERROR';

/**
 * Strips anything that looks like a credential out of a string.
 *
 * Cal.com keys are `cal_<env>_<random>`; we also scrub bearer tokens and Apify tokens so
 * that an upstream error body echoing a header can never land in a log line.
 */
export function redact(value: string): string {
    return value
        .replace(/cal_[A-Za-z0-9]*_[A-Za-z0-9]+/g, 'cal_***')
        .replace(/apify_[A-Za-z0-9_]{10,}/g, 'apify_***')
        .replace(/(bearer\s+)\S+/gi, '$1***')
        .replace(/((?:api[-_]?key|token|authorization|secret)["'\s:=]+)[^\s"',}]+/gi, '$1***');
}

export class RosterError extends Error {
    readonly code: ErrorCode;

    readonly retryable: boolean;

    /** Credential-free structured context for logs and the run report. */
    readonly context: Record<string, unknown>;

    constructor(
        code: ErrorCode,
        message: string,
        options: { retryable?: boolean; context?: Record<string, unknown>; cause?: unknown } = {},
    ) {
        super(redact(message), options.cause === undefined ? undefined : { cause: options.cause });
        this.name = new.target.name;
        this.code = code;
        this.retryable = options.retryable ?? false;
        this.context = options.context ?? {};
    }
}

export class InputError extends RosterError {
    constructor(message: string, context?: Record<string, unknown>) {
        super('INPUT_INVALID', message, { context });
    }
}

export class CredentialsMissingError extends RosterError {
    constructor(message: string) {
        super('CREDENTIALS_MISSING', message);
    }
}

/** HTTP 401: the key is absent, malformed, revoked or expired. Never retried. */
export class AuthenticationError extends RosterError {
    constructor(message: string, context?: Record<string, unknown>) {
        super('CREDENTIALS_INVALID', message, { context });
    }
}

/** HTTP 403: the key is valid but not allowed to read this resource. Never retried. */
export class AuthorizationError extends RosterError {
    constructor(message: string, context?: Record<string, unknown>) {
        super('UNAUTHORIZED', message, { context });
    }
}

/** HTTP 429. Retried with `Retry-After` when the header is present. */
export class RateLimitError extends RosterError {
    readonly retryAfterMs: number | null;

    constructor(message: string, retryAfterMs: number | null, context?: Record<string, unknown>) {
        super('RATE_LIMITED', message, { retryable: true, context });
        this.retryAfterMs = retryAfterMs;
    }
}

/** Any other non-2xx response. 5xx is retryable, 4xx is not. */
export class UpstreamError extends RosterError {
    readonly statusCode: number;

    constructor(statusCode: number, message: string, context?: Record<string, unknown>) {
        super('UPSTREAM_ERROR', message, { retryable: statusCode >= 500, context });
        this.statusCode = statusCode;
    }
}

export class UpstreamTimeoutError extends RosterError {
    constructor(message: string, context?: Record<string, unknown>) {
        super('UPSTREAM_TIMEOUT', message, { retryable: true, context });
    }
}

export class NetworkError extends RosterError {
    constructor(message: string, context?: Record<string, unknown>) {
        super('NETWORK_ERROR', message, { retryable: true, context });
    }
}

/**
 * The response parsed as JSON but did not have the documented shape, or was not JSON at all.
 * Not retryable: replaying the same request returns the same broken body.
 */
export class MalformedResponseError extends RosterError {
    constructor(message: string, context?: Record<string, unknown>) {
        super('MALFORMED_RESPONSE', message, { context });
    }
}

export class MetadataSourceError extends RosterError {
    constructor(message: string, context?: Record<string, unknown>) {
        super('METADATA_SOURCE_ERROR', message, { context });
    }
}

/** Raised only when `failOnEmptyResult` is enabled. */
export class EmptyResultError extends RosterError {
    constructor(message: string, context?: Record<string, unknown>) {
        super('EMPTY_RESULT', message, { context });
    }
}

/** Narrows anything thrown into a RosterError so the failure path is uniform. */
export function toRosterError(err: unknown): RosterError {
    if (err instanceof RosterError) return err;
    if (err instanceof Error) {
        return new RosterError('UNEXPECTED_ERROR', `${err.name}: ${err.message}`, { cause: err });
    }
    return new RosterError('UNEXPECTED_ERROR', `Non-error thrown: ${redact(String(err))}`);
}
