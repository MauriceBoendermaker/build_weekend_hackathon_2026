/**
 * A tiny routed fetch double.
 *
 * Tests describe what the API returns per path and the helper records what was asked for, so
 * assertions can cover both the response handling and the request that produced it (page size,
 * cursor, date filters). No test in this suite touches the network or needs a credential.
 */

import type { FetchImpl } from '../../src/http/fetcher.js';

export interface MockReply {
    status?: number;
    /** Serialized as JSON. Mutually exclusive with `text`. */
    body?: unknown;
    /** Raw body, for testing non-JSON responses. */
    text?: string;
    headers?: Record<string, string>;
    /** Simulates a transport-level failure such as ECONNRESET. */
    networkError?: string;
    /** Simulates a request that never answers, so the client's timeout fires. */
    hang?: boolean;
}

export type MockHandler = (url: URL, callIndex: number) => MockReply;

export type MockRoute = [RegExp, MockHandler];

/**
 * Replaces the handler of whichever route mentions `needle` in its pattern, leaving the rest of
 * a happy-path route table intact. Lets a test say "same run, but bookings return a 500".
 */
export function overrideRoute(routes: MockRoute[], needle: string, handler: MockHandler): MockRoute[] {
    let replaced = false;
    const updated = routes.map<MockRoute>(([pattern, existing]) => {
        if (!pattern.source.includes(needle)) return [pattern, existing];
        replaced = true;
        return [pattern, handler];
    });
    if (!replaced) throw new Error(`overrideRoute: no route pattern contains ${JSON.stringify(needle)}`);
    return updated;
}

export interface MockHttp {
    fetchImpl: FetchImpl;
    /** Every requested URL, in order. */
    calls: string[];
    /** Calls whose pathname matches, as parsed URLs. */
    callsTo(pattern: RegExp): URL[];
    /** Records every `Authorization` header seen, so tests can assert it is set - never logged. */
    authHeaders: (string | null)[];
    versionHeaders: (string | null)[];
}

export function mockHttp(routes: [RegExp, MockHandler][]): MockHttp {
    const calls: string[] = [];
    const authHeaders: (string | null)[] = [];
    const versionHeaders: (string | null)[] = [];
    const perRouteCounts = new Map<RegExp, number>();

    const fetchImpl: FetchImpl = async (rawUrl, init) => {
        const url = new URL(rawUrl);
        calls.push(url.toString());

        const headers = normalizeHeaders(init.headers);
        authHeaders.push(headers.authorization ?? null);
        versionHeaders.push(headers['cal-api-version'] ?? null);

        const route = routes.find(([pattern]) => pattern.test(url.pathname));
        if (route === undefined) {
            throw new Error(`mockHttp: no route matches ${url.pathname} (full URL ${url.toString()})`);
        }
        const [pattern, handler] = route;
        const callIndex = perRouteCounts.get(pattern) ?? 0;
        perRouteCounts.set(pattern, callIndex + 1);

        const reply = handler(url, callIndex);

        if (reply.networkError !== undefined) throw new TypeError(`fetch failed: ${reply.networkError}`);
        if (reply.hang === true) {
            await new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
        }

        const bodyText = reply.text ?? JSON.stringify(reply.body ?? {});
        return new Response(bodyText, {
            status: reply.status ?? 200,
            headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
        });
    };

    return {
        fetchImpl,
        calls,
        callsTo: (pattern) => calls.map((call) => new URL(call)).filter((url) => pattern.test(url.pathname)),
        authHeaders,
        versionHeaders,
    };
}

function normalizeHeaders(headers: RequestInit['headers']): Record<string, string> {
    const result: Record<string, string> = {};
    if (headers === undefined) return result;
    if (headers instanceof Headers) {
        headers.forEach((value, key) => {
            result[key.toLowerCase()] = value;
        });
        return result;
    }
    if (Array.isArray(headers)) {
        for (const [key, value] of headers) {
            if (key !== undefined && value !== undefined) result[key.toLowerCase()] = value;
        }
        return result;
    }
    for (const [key, value] of Object.entries(headers)) result[key.toLowerCase()] = String(value);
    return result;
}

/** Wraps a payload in the Cal.com v2 success envelope. */
export function calOk<T>(data: T, pagination?: { nextCursor: string | null; hasMore: boolean }): unknown {
    return pagination === undefined ? { status: 'success', data } : { status: 'success', data, pagination };
}

/** A sleep double, so retry backoff does not slow the suite down. */
export function instantSleep(): { sleepImpl: (ms: number) => Promise<void>; waits: number[] } {
    const waits: number[] = [];
    return {
        sleepImpl: async (ms: number) => {
            waits.push(ms);
        },
        waits,
    };
}
