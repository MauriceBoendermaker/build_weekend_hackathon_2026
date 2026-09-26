import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { log } from 'apify';

import {
    AuthenticationError,
    AuthorizationError,
    MalformedResponseError,
    NetworkError,
    RateLimitError,
    UpstreamError,
    UpstreamTimeoutError,
    redact,
} from '../src/errors.js';
import { HttpClient, parseRetryAfter } from '../src/http/fetcher.js';
import { instantSleep, mockHttp } from './fixtures/mock-http.js';

log.setLevel(log.LEVELS.OFF);

const API_KEY = 'cal_test_supersecretvalue123';

function client(
    routes: Parameters<typeof mockHttp>[0],
    options: { maxRetries?: number; timeoutMs?: number } = {},
): { http: HttpClient; mock: ReturnType<typeof mockHttp>; waits: number[] } {
    const mock = mockHttp(routes);
    const sleep = instantSleep();
    const http = new HttpClient({
        baseUrl: 'https://api.cal.com/v2',
        apiKey: API_KEY,
        timeoutMs: options.timeoutMs ?? 5000,
        maxRetries: options.maxRetries ?? 3,
        fetchImpl: mock.fetchImpl,
        sleepImpl: sleep.sleepImpl,
        backoffBaseMs: 10,
    });
    return { http, mock, waits: sleep.waits };
}

describe('HttpClient - successful retrieval', () => {
    it('parses a JSON body and sends the credential as a bearer header', async () => {
        const { http, mock } = client([[/\/v2\/me$/, () => ({ body: { status: 'success', data: { id: 7 } } })]]);

        const body = await http.getJson<{ data: { id: number } }>('/me', { label: 'GET /v2/me' });

        assert.deepEqual(body.data, { id: 7 });
        assert.equal(mock.authHeaders[0], `Bearer ${API_KEY}`);
        assert.equal(http.stats.requests, 1);
        assert.equal(http.stats.retries, 0);
    });

    it('sends the endpoint-specific cal-api-version header', async () => {
        const { http, mock } = client([[/\/v2\/bookings$/, () => ({ body: { status: 'success', data: [] } })]]);

        await http.getJson('/bookings', { apiVersion: '2026-05-01' });

        assert.equal(mock.versionHeaders[0], '2026-05-01');
    });

    it('builds the query string and omits empty values', async () => {
        const { http, mock } = client([[/\/v2\/bookings$/, () => ({ body: { status: 'success', data: [] } })]]);

        await http.getJson('/bookings', {
            query: { limit: 100, cursor: undefined, status: 'upcoming', teamId: null, blank: '' },
        });

        const url = new URL(mock.calls[0] as string);
        assert.equal(url.searchParams.get('limit'), '100');
        assert.equal(url.searchParams.get('status'), 'upcoming');
        assert.equal(url.searchParams.has('cursor'), false);
        assert.equal(url.searchParams.has('teamId'), false);
        assert.equal(url.searchParams.has('blank'), false);
    });

    it('never puts the credential in the URL', async () => {
        const { http, mock } = client([[/\/v2\/me$/, () => ({ body: { status: 'success', data: {} } })]]);

        await http.getJson('/me');

        assert.equal(
            mock.calls.some((call) => call.includes('cal_test')),
            false,
        );
    });
});

describe('HttpClient - authentication failures', () => {
    it('raises a non-retryable AuthenticationError on HTTP 401', async () => {
        const { http } = client([
            [/\/v2\/me$/, () => ({ status: 401, body: { error: { message: 'Invalid API key' } } })],
        ]);

        await assert.rejects(http.getJson('/me', { label: 'GET /v2/me' }), (err: unknown) => {
            assert.ok(err instanceof AuthenticationError);
            assert.equal(err.code, 'CREDENTIALS_INVALID');
            assert.equal(err.retryable, false);
            assert.match(err.message, /revoked or expired/);
            return true;
        });
        // A bad credential is never retried.
        assert.equal(http.stats.requests, 1);
    });

    it('raises AuthorizationError on HTTP 403 and does not retry', async () => {
        const { http } = client([[/\/v2\/teams$/, () => ({ status: 403, body: { error: 'forbidden' } })]]);

        await assert.rejects(http.getJson('/teams'), AuthorizationError);
        assert.equal(http.stats.requests, 1);
    });

    it('scrubs a credential echoed back in an error body', async () => {
        const { http } = client([
            [/\/v2\/me$/, () => ({ status: 401, body: { error: `token cal_live_leakedvalue999 rejected` } })],
        ]);

        await assert.rejects(http.getJson('/me'), (err: unknown) => {
            assert.ok(err instanceof AuthenticationError);
            assert.equal(err.message.includes('cal_live_leakedvalue999'), false);
            assert.equal(err.message.includes('leakedvalue'), false);
            assert.match(err.message, /\*\*\*/);
            return true;
        });
    });
});

describe('HttpClient - rate limiting', () => {
    it('retries a 429 and honours Retry-After', async () => {
        const { http, waits } = client([
            [
                /\/v2\/bookings$/,
                (_url, call) =>
                    call === 0
                        ? { status: 429, headers: { 'retry-after': '2' }, body: { error: 'slow down' } }
                        : { body: { status: 'success', data: [{ id: 1 }] } },
            ],
        ]);

        const body = await http.getJson<{ data: unknown[] }>('/bookings');

        assert.equal(body.data.length, 1);
        assert.equal(http.stats.requests, 2);
        assert.equal(http.stats.retries, 1);
        assert.equal(http.stats.rateLimitHits, 1);
        assert.deepEqual(waits, [2000]);
    });

    it('falls back to exponential backoff when Retry-After is absent', async () => {
        const { http, waits } = client([
            [
                /\/v2\/bookings$/,
                (_url, call) => (call < 2 ? { status: 429, body: {} } : { body: { status: 'success', data: [] } }),
            ],
        ]);

        await http.getJson('/bookings');

        assert.equal(waits.length, 2);
        assert.ok((waits[0] as number) >= 10, 'first backoff uses the base delay');
        assert.ok((waits[1] as number) >= 20, 'second backoff is longer than the first');
    });

    it('gives up with a RateLimitError once retries are exhausted', async () => {
        const { http } = client([[/\/v2\/bookings$/, () => ({ status: 429, body: {} })]], { maxRetries: 2 });

        await assert.rejects(http.getJson('/bookings'), (err: unknown) => {
            assert.ok(err instanceof RateLimitError);
            assert.equal(err.code, 'RATE_LIMITED');
            return true;
        });
        assert.equal(http.stats.requests, 3);
    });
});

describe('HttpClient - transient failures', () => {
    it('retries HTTP 500 and then succeeds', async () => {
        const { http } = client([
            [
                /\/v2\/teams$/,
                (_url, call) =>
                    call === 0 ? { status: 500, text: 'boom' } : { body: { status: 'success', data: [] } },
            ],
        ]);

        await http.getJson('/teams');
        assert.equal(http.stats.retries, 1);
    });

    it('surfaces an UpstreamError with the status once retries run out', async () => {
        const { http } = client([[/\/v2\/teams$/, () => ({ status: 503, text: 'unavailable' })]], { maxRetries: 1 });

        await assert.rejects(http.getJson('/teams', { label: 'GET /v2/teams' }), (err: unknown) => {
            assert.ok(err instanceof UpstreamError);
            assert.equal(err.statusCode, 503);
            assert.match(err.message, /HTTP 503/);
            return true;
        });
    });

    it('does not retry a 4xx that is not 429', async () => {
        const { http } = client([[/\/v2\/bookings$/, () => ({ status: 400, body: { error: 'bad filter' } })]]);

        await assert.rejects(http.getJson('/bookings'), (err: unknown) => {
            assert.ok(err instanceof UpstreamError);
            assert.equal(err.retryable, false);
            return true;
        });
        assert.equal(http.stats.requests, 1);
    });

    it('retries a network error and reports it when it persists', async () => {
        const { http } = client([[/\/v2\/me$/, () => ({ networkError: 'ECONNRESET' })]], { maxRetries: 1 });

        await assert.rejects(http.getJson('/me', { label: 'GET /v2/me' }), (err: unknown) => {
            assert.ok(err instanceof NetworkError);
            assert.equal(err.code, 'NETWORK_ERROR');
            assert.match(err.message, /ECONNRESET/);
            return true;
        });
        assert.equal(http.stats.requests, 2);
    });

    it('times out a hanging request and reports a timeout, not an empty result', async () => {
        const { http } = client([[/\/v2\/me$/, () => ({ hang: true })]], { maxRetries: 0, timeoutMs: 25 });

        await assert.rejects(http.getJson('/me', { label: 'GET /v2/me' }), (err: unknown) => {
            assert.ok(err instanceof UpstreamTimeoutError);
            assert.equal(err.code, 'UPSTREAM_TIMEOUT');
            assert.match(err.message, /timed out after 25 ms/);
            return true;
        });
        assert.equal(http.stats.timeouts, 1);
    });
});

describe('HttpClient - malformed responses', () => {
    it('rejects a body that is not JSON', async () => {
        const { http } = client([[/\/v2\/me$/, () => ({ text: '<html><body>Gateway timeout</body></html>' })]]);

        await assert.rejects(http.getJson('/me', { label: 'GET /v2/me' }), (err: unknown) => {
            assert.ok(err instanceof MalformedResponseError);
            assert.match(err.message, /not valid JSON/);
            return true;
        });
    });

    it('rejects a JSON body that is not an object', async () => {
        const { http } = client([[/\/v2\/me$/, () => ({ text: '"just a string"' })]]);

        await assert.rejects(http.getJson('/me'), MalformedResponseError);
    });

    it('does not retry a malformed response', async () => {
        const { http } = client([[/\/v2\/me$/, () => ({ text: 'nope' })]]);

        await assert.rejects(http.getJson('/me'), MalformedResponseError);
        assert.equal(http.stats.requests, 1);
    });
});

describe('parseRetryAfter', () => {
    it('reads a delay in seconds', () => {
        assert.equal(parseRetryAfter('30'), 30_000);
    });

    it('reads an HTTP date', () => {
        const future = new Date(Date.now() + 5000).toUTCString();
        const parsed = parseRetryAfter(future);
        assert.ok(parsed !== null && parsed > 3000 && parsed <= 6000);
    });

    it('returns null for a missing or unparseable value', () => {
        assert.equal(parseRetryAfter(null), null);
        assert.equal(parseRetryAfter('soon'), null);
    });
});

describe('redact', () => {
    it('scrubs Cal.com keys, Apify tokens and bearer headers', () => {
        assert.equal(redact('key=cal_live_abc123def'), 'key=cal_***');
        assert.equal(redact('cal_test_xyz789'), 'cal_***');
        assert.match(redact('Authorization: Bearer abc.def.ghi'), /\*\*\*/);
        assert.match(redact('apify_api_abcdefghijklmnop'), /apify_\*\*\*/);
    });

    it('scrubs credentials in JSON-ish text', () => {
        assert.match(redact('{"apiKey": "sk-1234567890"}'), /\*\*\*/);
        assert.equal(redact('{"apiKey": "sk-1234567890"}').includes('sk-1234567890'), false);
    });

    it('leaves ordinary text alone', () => {
        assert.equal(redact('12 workers retrieved from ICU rota'), '12 workers retrieved from ICU rota');
    });
});
