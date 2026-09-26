import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { log } from 'apify';

import { AuthenticationError } from '../src/errors.js';
import { HttpClient } from '../src/http/fetcher.js';
import { CalComClient } from '../src/sources/calcom/client.js';
import { CalComSource, normalizeWallClock } from '../src/sources/calcom/source.js';
import type { RawSnapshot } from '../src/sources/source.js';
import { happyPathRoutes, testInput } from './fixtures/calcom.js';
import { calOk, instantSleep, mockHttp, overrideRoute } from './fixtures/mock-http.js';

log.setLevel(log.LEVELS.OFF);

function buildSource(
    routes: Parameters<typeof mockHttp>[0],
    inputOverrides: Record<string, unknown> = {},
): { fetchSnapshot: () => Promise<RawSnapshot>; mock: ReturnType<typeof mockHttp> } {
    const input = testInput(inputOverrides);
    const mock = mockHttp(routes);
    const sleep = instantSleep();
    const http = new HttpClient({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        timeoutMs: 5000,
        maxRetries: 1,
        fetchImpl: mock.fetchImpl,
        sleepImpl: sleep.sleepImpl,
        backoffBaseMs: 1,
    });
    const client = new CalComClient(http, {
        pageSize: input.pageSize,
        maxPages: input.maxPagesPerResource,
        maxRecords: input.maxRecordsPerResource,
    });
    const source = new CalComSource({ input, client, httpClient: http });
    return { fetchSnapshot: () => source.fetch(), mock };
}

describe('CalComSource - successful retrieval', () => {
    it('collects people, events, shift types and availability into one snapshot', async () => {
        const { fetchSnapshot } = buildSource(happyPathRoutes());

        const snapshot = await fetchSnapshot();

        assert.equal(snapshot.sourceSystem, 'cal.com');
        assert.equal(snapshot.complete, true);
        assert.equal(snapshot.events.length, 3);
        assert.equal(snapshot.shiftTypes.length, 2);

        const emails = snapshot.people.map((person) => person.email).sort();
        assert.deepEqual(emails, ['jonas@hospital.example', 'lead@hospital.example', 'sarah@hospital.example']);
    });

    it('excludes members whose team invitation is still pending', async () => {
        const { fetchSnapshot } = buildSource(happyPathRoutes());

        const snapshot = await fetchSnapshot();

        assert.equal(
            snapshot.people.some((person) => person.email === 'pending@hospital.example'),
            false,
            'a pending invitee cannot be asked to cover a shift',
        );
    });

    it('skips the organization entry when listing teams', async () => {
        const { fetchSnapshot, mock } = buildSource(happyPathRoutes());

        await fetchSnapshot();

        // Team 12 is the organization; only team 31 has a rota.
        assert.equal(
            mock.calls.some((call) => call.includes('/teams/12/memberships')),
            false,
        );
        assert.equal(
            mock.calls.some((call) => call.includes('/teams/31/memberships')),
            true,
        );
    });

    it('merges identity detail discovered through different resources', async () => {
        const { fetchSnapshot } = buildSource(happyPathRoutes());

        const snapshot = await fetchSnapshot();

        // Sarah is seen as a team member (email + username) and as an event-type host (id).
        const sarah = snapshot.people.find((person) => person.email === 'sarah@hospital.example');
        assert.ok(sarah !== undefined);
        assert.equal(sarah.username, 'sarah-v');
        assert.equal(sarah.externalId, 502);
    });

    it('records per-resource page and record counts', async () => {
        const { fetchSnapshot } = buildSource(happyPathRoutes());

        const snapshot = await fetchSnapshot();

        assert.equal(snapshot.stats.resources['/v2/teams/31/memberships']?.records, 4);
        assert.ok(snapshot.stats.apiRequests >= 6);
        assert.ok(snapshot.stats.pagesFetched >= 6);
    });

    it('scopes retrieval to the requested teams and warns about invisible ones', async () => {
        const { fetchSnapshot, mock } = buildSource(happyPathRoutes(), { teamIds: ['31', '99'] });

        const snapshot = await fetchSnapshot();

        assert.equal(
            mock.calls.some((call) => call.includes('/teams/99/memberships')),
            true,
        );
        assert.match(snapshot.warnings.join(' '), /Team 99 was requested but not returned/);
    });

    it('runs one paginated booking walk per requested status', async () => {
        const { fetchSnapshot, mock } = buildSource(happyPathRoutes(), {
            bookingStatuses: ['upcoming', 'cancelled'],
        });

        await fetchSnapshot();

        const statuses = mock.callsTo(/\/v2\/bookings$/).map((url) => url.searchParams.get('status'));
        assert.deepEqual(statuses.sort(), ['cancelled', 'upcoming']);
    });

    it('omits the status filter entirely when none is configured', async () => {
        const { fetchSnapshot, mock } = buildSource(happyPathRoutes(), { bookingStatuses: [] });

        await fetchSnapshot();

        const calls = mock.callsTo(/\/v2\/bookings$/);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.searchParams.has('status'), false);
    });

    it('honours the retrieval toggles', async () => {
        const { fetchSnapshot, mock } = buildSource(happyPathRoutes(), {
            includeTeamMemberships: false,
            includeEventTypes: false,
            includeSchedules: false,
        });

        const snapshot = await fetchSnapshot();

        assert.equal(
            mock.calls.some((call) => call.includes('memberships')),
            false,
        );
        assert.equal(
            mock.calls.some((call) => call.includes('event-types')),
            false,
        );
        assert.equal(
            mock.calls.some((call) => call.includes('schedules')),
            false,
        );
        assert.deepEqual(snapshot.shiftTypes, []);
        assert.deepEqual(snapshot.availability, []);
        // The authenticated user and every booking host are still discovered.
        assert.ok(snapshot.people.length >= 2);
    });
});

describe('CalComSource - availability projection', () => {
    it('projects weekly wall-clock availability into UTC windows inside the range', async () => {
        const { fetchSnapshot } = buildSource(happyPathRoutes());

        const snapshot = await fetchSnapshot();

        const availability = snapshot.availability[0];
        assert.ok(availability !== undefined, 'the authenticated user has projected availability');
        assert.equal(availability.timeZone, 'Europe/Amsterdam');

        // The window is 2026-09-26T00:00Z .. 2026-10-03T00:00Z. Weekdays only, so Mon 28th
        // (overridden), Tue 29th, Wed 30th, Thu 1st, Fri 2nd.
        const starts = availability.windows.map((window) => window.start);
        assert.equal(availability.windows.length, 5);

        // 09:00-17:00 Amsterdam in CEST is 07:00-15:00 UTC.
        assert.ok(starts.includes('2026-09-29T07:00:00.000Z'), `expected Tuesday 07:00Z in ${starts.join(', ')}`);
        const tuesday = availability.windows.find((window) => window.start === '2026-09-29T07:00:00.000Z');
        assert.equal(tuesday?.end, '2026-09-29T15:00:00.000Z');

        // The 28th is overridden to 12:00-20:00 local, i.e. 10:00-18:00 UTC.
        const monday = availability.windows.find((window) => window.start === '2026-09-28T10:00:00.000Z');
        assert.equal(monday?.end, '2026-09-28T18:00:00.000Z');
    });

    it('states plainly that Cal.com exposes schedules for the authenticated user only', async () => {
        const { fetchSnapshot } = buildSource(happyPathRoutes());

        const snapshot = await fetchSnapshot();

        assert.match(snapshot.warnings.join(' '), /only exposes availability schedules for the authenticated user/);
    });

    it('reads a schedule with no time zone as UTC and says so', async () => {
        const { fetchSnapshot } = buildSource(
            overrideRoute(happyPathRoutes(), 'schedules', () => ({
                body: calOk([
                    {
                        id: 1,
                        ownerId: 501,
                        isDefault: true,
                        availability: [{ days: ['Tuesday'], startTime: '09:00', endTime: '17:00' }],
                        overrides: [],
                    },
                ]),
            })),
        );

        const snapshot = await fetchSnapshot();

        assert.match(snapshot.warnings.join(' '), /no time zone; its availability was read as UTC/);
        assert.equal(snapshot.availability[0]?.windows[0]?.start, '2026-09-29T09:00:00.000Z');
    });

    it('rolls an overnight window onto the following day', async () => {
        const { fetchSnapshot } = buildSource(
            overrideRoute(happyPathRoutes(), 'schedules', () => ({
                body: calOk([
                    {
                        id: 1,
                        ownerId: 501,
                        timeZone: 'UTC',
                        isDefault: true,
                        // A night-shift pattern: 23:00 to 07:00 the next morning.
                        availability: [{ days: ['Tuesday'], startTime: '23:00', endTime: '07:00' }],
                        overrides: [],
                    },
                ]),
            })),
        );

        const snapshot = await fetchSnapshot();

        assert.deepEqual(snapshot.availability[0]?.windows, [
            { start: '2026-09-29T23:00:00.000Z', end: '2026-09-30T07:00:00.000Z' },
        ]);
    });

    it('warns instead of failing when the user has no schedule', async () => {
        const { fetchSnapshot } = buildSource(
            overrideRoute(happyPathRoutes(), 'schedules', () => ({ body: calOk([]) })),
        );

        const snapshot = await fetchSnapshot();

        assert.deepEqual(snapshot.availability, []);
        assert.match(snapshot.warnings.join(' '), /no availability schedules/);
    });
});

describe('CalComSource - failures', () => {
    it('fails fast on an invalid credential, before any other call', async () => {
        const { fetchSnapshot, mock } = buildSource([
            [/\/v2\/me$/, () => ({ status: 401, body: { error: 'nope' } })],
            [/\/v2\/.*/, () => ({ body: calOk([]) })],
        ]);

        await assert.rejects(fetchSnapshot(), AuthenticationError);
        assert.equal(mock.calls.length, 1, 'nothing else is attempted once the credential is rejected');
    });

    it('propagates a booking failure instead of returning an empty snapshot', async () => {
        const { fetchSnapshot } = buildSource(
            overrideRoute(happyPathRoutes(), 'bookings', () => ({ status: 500, text: 'upstream down' })),
        );

        await assert.rejects(fetchSnapshot(), /HTTP 500/);
    });

    it('marks the snapshot incomplete when a resource hit a cap', async () => {
        const { fetchSnapshot } = buildSource(
            overrideRoute(happyPathRoutes(), 'bookings', (_url, call) => ({
                body: calOk([{ id: call, uid: `bk-${call}` }], { nextCursor: `c${call}`, hasMore: true }),
            })),
            { maxPagesPerResource: 2 },
        );

        const snapshot = await fetchSnapshot();

        assert.equal(snapshot.complete, false);
        assert.match(snapshot.warnings.join(' '), /maxPagesPerResource cap of 2/);
    });
});

describe('normalizeWallClock', () => {
    it('extracts HH:mm from the shapes Cal.com uses', () => {
        assert.equal(normalizeWallClock('09:00'), '09:00');
        assert.equal(normalizeWallClock('9:00'), '09:00');
        assert.equal(normalizeWallClock('09:00:00'), '09:00');
        assert.equal(normalizeWallClock('1970-01-01T17:30:00.000Z'), '17:30');
    });
});
