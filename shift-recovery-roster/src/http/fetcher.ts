/**
 * The HTTP layer.
 *
 * One job: turn an authorized GET into either parsed JSON or a typed {@link RosterError}.
 * It never returns a partial or empty success for a failed call, because the whole point of
 * this Actor is that the decision layer can trust an empty dataset to mean "nothing
 * scheduled" rather than "the API was down".
 *
 * Credentials travel in the `Authorization` header and are never placed in a URL, so request
 * URLs are safe to log verbatim. Response bodies are redacted and truncated before they are
 * quoted in an error, in case an upstream error echoes a header back.
 */

import { log } from 'apify';

import {
    AuthenticationError,
    AuthorizationError,
    MalformedResponseError,
    NetworkError,
    RateLimitError,
    RosterError,
    UpstreamError,
    UpstreamTimeoutError,
    redact,
    toRosterError,
} from '../errors.js';

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export type SleepImpl = (ms: number) => Promise<void>;

export interface HttpClientOptions {
    /** Base URL, e.g. `https://api.cal.com/v2`. A trailing slash is tolerated. */
    baseUrl: string;
    /** Bearer credential. Never logged. */
    apiKey: string;
    timeoutMs: number;
    maxRetries: number;
    /** Injected in tests. Defaults to the global `fetch`. */
    fetchImpl?: FetchImpl;
    /** Injected in tests so retry backoff does not actually sleep. */
    sleepImpl?: SleepImpl;
    /** Base backoff in ms; doubled per attempt, capped at 30s, plus jitter. */
    backoffBaseMs?: number;
}

export interface RequestOptions {
    /** Value for the `cal-api-version` header. Cal.com pins behaviour per endpoint version. */
    apiVersion?: string;
    query?: Record<string, string | number | boolean | undefined | null>;
    /** Label used in logs and error context instead of the raw path. */
    label?: string;
}

export interface HttpStats {
    requests: number;
    retries: number;
    rateLimitHits: number;
    timeouts: number;
}

const MAX_BACKOFF_MS = 30_000;
const BODY_EXCERPT_CHARS = 300;

const defaultSleep: SleepImpl = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

export class HttpClient {
    readonly stats: HttpStats = { requests: 0, retries: 0, rateLimitHits: 0, timeouts: 0 };

    private readonly baseUrl: string;

    private readonly apiKey: string;

    private readonly timeoutMs: number;

    private readonly maxRetries: number;

    private readonly fetchImpl: FetchImpl;

    private readonly sleepImpl: SleepImpl;

    private readonly backoffBaseMs: number;

    constructor(options: HttpClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.apiKey = options.apiKey;
        this.timeoutMs = options.timeoutMs;
        this.maxRetries = options.maxRetries;
        this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
        this.sleepImpl = options.sleepImpl ?? defaultSleep;
        this.backoffBaseMs = options.backoffBaseMs ?? 500;
    }

    /** GETs a JSON document, retrying transient failures. Throws a typed error otherwise. */
    async getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
        const url = this.buildUrl(path, options.query);
        const label = options.label ?? path;

        let lastError: RosterError | undefined;
        for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
            if (attempt > 0) {
                this.stats.retries += 1;
                const waitMs = this.backoffFor(attempt, lastError);
                log.warning(
                    `Retrying ${label} (attempt ${attempt + 1}/${this.maxRetries + 1}) in ${waitMs} ms ` +
                        `after ${lastError?.code ?? 'unknown error'}`,
                );
                await this.sleepImpl(waitMs);
            }

            try {
                return await this.attempt<T>(url, label, options.apiVersion);
            } catch (err) {
                const error = toRosterError(err);
                if (!error.retryable) throw error;
                lastError = error;
            }
        }

        throw (
            lastError ??
            new RosterError('UNEXPECTED_ERROR', `Request to ${label} failed without producing an error object.`)
        );
    }

    private async attempt<T>(url: string, label: string, apiVersion: string | undefined): Promise<T> {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.timeoutMs);

        this.stats.requests += 1;
        log.debug(`GET ${url}`, { label, apiVersion: apiVersion ?? null });

        let response: Response;
        try {
            response = await this.fetchImpl(url, {
                method: 'GET',
                // The credential lives here and nowhere else. Headers are never logged.
                headers: this.buildHeaders(apiVersion),
                signal: controller.signal,
                redirect: 'follow',
            });
        } catch (err) {
            if (timedOut) {
                this.stats.timeouts += 1;
                throw new UpstreamTimeoutError(`${label} timed out after ${this.timeoutMs} ms.`, { url });
            }
            const message = err instanceof Error ? err.message : String(err);
            throw new NetworkError(`Network error calling ${label}: ${message}`, { url });
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) throw await this.toHttpError(response, label, url);

        const raw = await this.readBody(response, label);
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new MalformedResponseError(
                `${label} returned a ${response.status} response that is not valid JSON. ` +
                    `First ${BODY_EXCERPT_CHARS} characters: ${excerpt(raw)}`,
                { url, contentType: response.headers.get('content-type') },
            );
        }

        if (parsed === null || typeof parsed !== 'object') {
            throw new MalformedResponseError(`${label} returned JSON that is not an object: ${excerpt(raw)}`, { url });
        }

        return parsed as T;
    }

    private buildHeaders(apiVersion: string | undefined): Record<string, string> {
        const headers: Record<string, string> = {
            authorization: `Bearer ${this.apiKey}`,
            accept: 'application/json',
            'user-agent': 'apify-shift-recovery-roster/1.0',
        };
        if (apiVersion !== undefined) headers['cal-api-version'] = apiVersion;
        return headers;
    }

    private buildUrl(path: string, query: RequestOptions['query']): string {
        const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`);
        for (const [key, value] of Object.entries(query ?? {})) {
            if (value === undefined || value === null || value === '') continue;
            url.searchParams.set(key, String(value));
        }
        return url.toString();
    }

    private async toHttpError(response: Response, label: string, url: string): Promise<RosterError> {
        const body = excerpt(await this.readBody(response, label).catch(() => ''));
        const context = { url, status: response.status, body };

        if (response.status === 401) {
            return new AuthenticationError(
                `${label} rejected the credential (HTTP 401). The Cal.com API key is missing, malformed, revoked or ` +
                    `expired. Generate a new key under Settings > Developer > API keys. Response: ${body}`,
                context,
            );
        }
        if (response.status === 403) {
            return new AuthorizationError(
                `${label} returned HTTP 403. The credential is valid but not permitted to read this resource - check ` +
                    `the key's scopes and the team membership role. Response: ${body}`,
                context,
            );
        }
        if (response.status === 429) {
            const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
            this.stats.rateLimitHits += 1;
            return new RateLimitError(
                `${label} was rate limited (HTTP 429)${retryAfterMs === null ? '' : `, Retry-After ${retryAfterMs} ms`}.`,
                retryAfterMs,
                context,
            );
        }
        return new UpstreamError(
            response.status,
            `${label} returned HTTP ${response.status}. Response: ${body}`,
            context,
        );
    }

    private async readBody(response: Response, label: string): Promise<string> {
        try {
            return await response.text();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new NetworkError(`Failed to read the response body of ${label}: ${message}`);
        }
    }

    /** Exponential backoff with jitter; an explicit `Retry-After` always wins. */
    private backoffFor(attempt: number, lastError: RosterError | undefined): number {
        if (lastError instanceof RateLimitError && lastError.retryAfterMs !== null) {
            return Math.min(lastError.retryAfterMs, MAX_BACKOFF_MS);
        }
        const exponential = Math.min(this.backoffBaseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        const jitter = Math.floor(Math.random() * Math.min(250, exponential));
        return exponential + jitter;
    }
}

/** Parses `Retry-After`, which may be seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number | null {
    if (value === null) return null;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
    const asDate = Date.parse(trimmed);
    if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
    return null;
}

function excerpt(body: string): string {
    const clean = redact(body).replace(/\s+/g, ' ').trim();
    return clean.length > BODY_EXCERPT_CHARS ? `${clean.slice(0, BODY_EXCERPT_CHARS)}...` : clean;
}
