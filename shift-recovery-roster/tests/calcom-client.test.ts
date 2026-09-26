import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { log } from 'apify';

import { MalformedResponseError, UpstreamError } from '../src/errors.js';
import { HttpClient } from '../src/http/fetcher.js';
import { CAL_API_VERSIONS, CalComClient } from '../src/sources/calcom/client.js';
import { calOk, instantSleep, mockHttp } from './fixtures/mock-http.js';

log.setLevel(log.LEVELS.OFF);

function makeClient(
    routes: Parameters<typeof mockHttp>[0],
    guards: { pageSize?: number; maxPages?: number; maxRecords?: number } = {},
): { client: CalComClient; mock: ReturnType<typeof mockHttp> } {
    const mock = mockHttp(routes);
    const sleep = instantSleep();
    const http = new HttpClient({
        baseUrl: 'https://api.cal.com/v2',
        apiKey: 'cal_test_0123456789abcdef',
        timeoutMs: 5000,
        maxRetries: 2,
        fetchImpl: mock.fetchImpl,
        sleepImpl: sleep.sleepImpl,
        backoffBaseMs: 1,
    });
    const client = new CalComClient(http, {
        pageSize: guards.pageSize ?? 100,
        maxPages: guards.maxPages ?? 100,
        maxRecords: guards.maxRecords ?? 5000,
    });
    return { client, mock };
}

const bookingsQuery = { afterStart: '2026-09-26T00:00:00.000Z', beforeEnd: '2026-10-03T00:00:00.000Z' };

describe('CalComClient - cursor pagination', () => {
    it('walks every page and concatenates the results in order', async () => {
        const pages = [
            { data: [{ id: 1 }, { id: 2 }], pagination: { nextCursor: 'c2', hasMore: true } },
            { data: [{ id: 3 }, { id: 4 }], pagination: { nextCursor: 'c3', hasMore: true } },
            { data: [{ id: 5 }], pagination: { nextCursor: null, hasMore: false } },
        ];
        const { client, mock } = makeClient([
            [/\/v2\/bookings$/, (_url, call) => ({ body: { status: 'success', ...pages[call] } })],
        ]);

        const result = await client.listBookings(bookingsQuery);

        assert.deepEqual(
            result.items.map((item) => (item as { id: number }).id),
            [1, 2, 3, 4, 5],
        );
        assert.equal(result.stats.pages, 3);
        assert.equal(result.stats.records, 5);
        assert.equal(result.stats.truncated, false);

        // Page 1 carries no cursor; later pages carry the previous nextCursor.
        const calls = mock.callsTo(/\/v2\/bookings$/);
        assert.equal(calls[0]?.searchParams.has('cursor'), false);
        assert.equal(calls[1]?.searchParams.get('cursor'), 'c2');
        assert.equal(calls[2]?.searchParams.get('cursor'), 'c3');
    });

    it('sends the documented date filters, sort order and page size', async () => {
        const { client, mock } = makeClient(
            [[/\/v2\/bookings$/, () => ({ body: calOk([], { nextCursor: null, hasMore: false }) })]],
            { pageSize: 25 },
        );

        await client.listBookings({ ...bookingsQuery, status: 'upcoming', eventTypeIds: [900, 901], teamId: 31 });

        const url = mock.callsTo(/\/v2\/bookings$/)[0];
        assert.equal(url?.searchParams.get('afterStart'), '2026-09-26T00:00:00.000Z');
        assert.equal(url?.searchParams.get('beforeEnd'), '2026-10-03T00:00:00.000Z');
        assert.equal(url?.searchParams.get('status'), 'upcoming');
        assert.equal(url?.searchParams.get('eventTypeIds'), '900,901');
        assert.equal(url?.searchParams.get('teamId'), '31');
        assert.equal(url?.searchParams.get('limit'), '25');
        assert.equal(url?.searchParams.get('sortStart'), 'asc');
        assert.equal(mock.versionHeaders[0], CAL_API_VERSIONS.bookings);
    });

    it('stops on a repeated cursor instead of looping forever', async () => {
        const { client } = makeClient([
            // A server bug: the same cursor comes back every time.
            [/\/v2\/bookings$/, () => ({ body: calOk([{ id: 1 }], { nextCursor: 'stuck', hasMore: true }) })],
        ]);

        const result = await client.listBookings(bookingsQuery);

        assert.equal(result.stats.pages, 2, 'stops on the second sighting of the cursor');
        assert.equal(result.stats.truncated, true);
        assert.match(result.warnings.join(' '), /repeated a pagination cursor/);
    });

    it('stops at the page cap and says the snapshot is incomplete', async () => {
        const { client } = makeClient(
            [
                [
                    /\/v2\/bookings$/,
                    (_url, call) => ({ body: calOk([{ id: call }], { nextCursor: `c${call}`, hasMore: true }) }),
                ],
            ],
            { maxPages: 3 },
        );

        const result = await client.listBookings(bookingsQuery);

        assert.equal(result.stats.pages, 3);
        assert.equal(result.stats.truncated, true);
        assert.match(result.warnings.join(' '), /maxPagesPerResource cap of 3/);
    });

    it('stops at the record cap and truncates to exactly that many records', async () => {
        const { client } = makeClient(
            [
                [
                    /\/v2\/bookings$/,
                    (_url, call) => ({
                        body: calOk([{ id: call * 2 }, { id: call * 2 + 1 }], {
                            nextCursor: `c${call}`,
                            hasMore: true,
                        }),
                    }),
                ],
            ],
            { maxRecords: 3 },
        );

        const result = await client.listBookings(bookingsQuery);

        assert.equal(result.items.length, 3);
        assert.equal(result.stats.truncated, true);
        assert.match(result.warnings.join(' '), /maxRecordsPerResource cap of 3/);
    });

    it('treats an empty first page as a complete, successful, empty result', async () => {
        const { client } = makeClient([
            [/\/v2\/bookings$/, () => ({ body: calOk([], { nextCursor: null, hasMore: false }) })],
        ]);

        const result = await client.listBookings(bookingsQuery);

        assert.deepEqual(result.items, []);
        assert.equal(result.stats.pages, 1);
        assert.equal(result.stats.truncated, false, 'an empty result is complete, not truncated');
        assert.deepEqual(result.warnings, []);
    });

    it('stops when hasMore is true but no cursor is supplied', async () => {
        const { client } = makeClient([
            [/\/v2\/bookings$/, () => ({ body: calOk([{ id: 1 }], { nextCursor: null, hasMore: true }) })],
        ]);

        const result = await client.listBookings(bookingsQuery);
        assert.equal(result.stats.pages, 1);
    });
});

describe('CalComClient - offset pagination', () => {
    it('walks take/skip pages until a short page arrives', async () => {
        const { client, mock } = makeClient(
            [
                [
                    /\/v2\/teams\/31\/memberships$/,
                    (_url, call) =>
                        call === 0 ? { body: calOk([{ id: 1 }, { id: 2 }]) } : { body: calOk([{ id: 3 }]) },
                ],
            ],
            { pageSize: 2 },
        );

        const result = await client.listTeamMemberships(31);

        assert.equal(result.items.length, 3);
        assert.equal(result.stats.pages, 2);
        const calls = mock.callsTo(/memberships$/);
        assert.equal(calls[0]?.searchParams.get('skip'), '0');
        assert.equal(calls[0]?.searchParams.get('take'), '2');
        assert.equal(calls[1]?.searchParams.get('skip'), '2');
    });

    it('stops after one page when the first page is short', async () => {
        const { client } = makeClient([[/memberships$/, () => ({ body: calOk([{ id: 1 }]) })]], { pageSize: 50 });

        const result = await client.listTeamMemberships(31);
        assert.equal(result.stats.pages, 1);
        assert.equal(result.items.length, 1);
    });
});

describe('CalComClient - envelope handling', () => {
    it('raises an UpstreamError when a 200 response carries status "error"', async () => {
        const { client } = makeClient([
            [/\/v2\/me$/, () => ({ body: { status: 'error', error: { message: 'internal' } } })],
        ]);

        await assert.rejects(client.getMe(), (err: unknown) => {
            assert.ok(err instanceof UpstreamError);
            assert.match(err.message, /status "error"/);
            return true;
        });
    });

    it('raises MalformedResponseError when the envelope has no data', async () => {
        const { client } = makeClient([[/\/v2\/teams$/, () => ({ body: { status: 'success' } })]]);

        await assert.rejects(client.listTeams(), (err: unknown) => {
            assert.ok(err instanceof MalformedResponseError);
            assert.match(err.message, /without a "data" property/);
            return true;
        });
    });

    it('raises MalformedResponseError on an unexpected envelope status', async () => {
        const { client } = makeClient([[/\/v2\/teams$/, () => ({ body: { status: 'weird', data: [] } })]]);

        await assert.rejects(client.listTeams(), MalformedResponseError);
    });

    it('raises MalformedResponseError when a list endpoint returns a scalar', async () => {
        const { client } = makeClient([[/\/v2\/teams$/, () => ({ body: { status: 'success', data: 42 } })]]);

        await assert.rejects(client.listTeams(), /an array of records was expected/);
    });

    it('tolerates a single object where the spec says a list', async () => {
        // The published spec types GET /v2/teams/{id}/memberships as returning one object.
        const { client } = makeClient([[/memberships$/, () => ({ body: calOk({ id: 1, userId: 9 }) })]]);

        const result = await client.listTeamMemberships(31);
        assert.equal(result.items.length, 1);
    });

    it('raises MalformedResponseError when /v2/me returns an array', async () => {
        const { client } = makeClient([[/\/v2\/me$/, () => ({ body: calOk([{ id: 1 }]) })]]);

        await assert.rejects(client.getMe(), MalformedResponseError);
    });
});

describe('CalComClient - endpoint versions', () => {
    it('pins the documented version per endpoint', async () => {
        const { client, mock } = makeClient([
            [/\/v2\/event-types$/, () => ({ body: calOk([]) })],
            [/\/v2\/schedules$/, () => ({ body: calOk([]) })],
        ]);

        await client.listEventTypes();
        await client.listSchedules();

        assert.equal(mock.versionHeaders[0], CAL_API_VERSIONS.eventTypes);
        assert.equal(mock.versionHeaders[1], CAL_API_VERSIONS.schedules);
    });

    it('passes a username filter through to /v2/event-types', async () => {
        const { client, mock } = makeClient([[/\/v2\/event-types$/, () => ({ body: calOk([]) })]]);

        await client.listEventTypes('sarah-v');

        assert.equal(mock.callsTo(/event-types$/)[0]?.searchParams.get('username'), 'sarah-v');
    });
});
