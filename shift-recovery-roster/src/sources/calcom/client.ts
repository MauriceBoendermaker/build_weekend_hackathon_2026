/**
 * Cal.com API v2 client.
 *
 * Implemented against the published OpenAPI document at
 * https://cal.com/docs/api-reference/v2/openapi.json. Cal.com pins endpoint behaviour with a
 * `cal-api-version` header and explicitly warns that omitting it silently falls back to an
 * older version, so every call sends the version that matches the response shape this client
 * parses. Those constants are the single place to bump when Cal.com ships a new version.
 *
 * Authentication is `Authorization: Bearer <cal_ key>`. No official read-only endpoint exposes
 * the data this Actor needs through HTML, so nothing here scrapes anything.
 */

import { log } from 'apify';

import { MalformedResponseError, UpstreamError } from '../../errors.js';
import type { HttpClient } from '../../http/fetcher.js';
import type { ResourceStats } from '../source.js';

/** Endpoint-specific API versions, as documented per endpoint in the OpenAPI spec. */
export const CAL_API_VERSIONS = {
    bookings: '2026-05-01',
    eventTypes: '2026-06-12',
    schedules: '2024-06-11',
} as const;

export interface CalEnvelope<T> {
    status?: string;
    data?: T;
    error?: unknown;
}

export interface CalCursorPagination {
    nextCursor?: string | null;
    hasMore?: boolean;
}

export interface CalMe {
    id?: number;
    username?: string;
    email?: string;
    name?: string;
    timeZone?: string;
    defaultScheduleId?: number | null;
    organizationId?: number | null;
}

export interface CalTeam {
    id?: number;
    name?: string;
    slug?: string;
    isOrganization?: boolean;
    parentId?: number | null;
    timeZone?: string;
}

export interface CalMembershipUser {
    email?: string;
    username?: string;
    name?: string;
    avatarUrl?: string;
}

export interface CalMembership {
    id?: number;
    userId?: number;
    teamId?: number;
    accepted?: boolean;
    role?: string;
    user?: CalMembershipUser;
}

export interface CalBookingHost {
    id?: number;
    name?: string;
    email?: string;
    username?: string;
    timeZone?: string;
}

export interface CalBookingAttendee {
    name?: string;
    email?: string;
    timeZone?: string;
    absent?: boolean;
}

export interface CalBooking {
    id?: number;
    uid?: string;
    title?: string;
    status?: string;
    start?: string;
    end?: string;
    duration?: number;
    eventTypeId?: number;
    eventType?: { id?: number; slug?: string };
    hosts?: CalBookingHost[];
    attendees?: CalBookingAttendee[];
    absentHost?: boolean;
    createdAt?: string;
    updatedAt?: string;
}

export interface CalEventTypeUser {
    id?: number;
    name?: string;
    username?: string;
}

export interface CalEventType {
    id?: number;
    slug?: string;
    title?: string;
    lengthInMinutes?: number;
    ownerId?: number | null;
    teamId?: number | null;
    scheduleId?: number | null;
    hidden?: boolean;
    users?: CalEventTypeUser[];
}

export interface CalScheduleAvailability {
    days?: string[];
    startTime?: string;
    endTime?: string;
}

export interface CalScheduleOverride {
    date?: string;
    startTime?: string;
    endTime?: string;
}

export interface CalSchedule {
    id?: number;
    ownerId?: number;
    name?: string;
    timeZone?: string;
    isDefault?: boolean;
    availability?: CalScheduleAvailability[];
    overrides?: CalScheduleOverride[];
}

export interface BookingQuery {
    afterStart: string;
    beforeEnd: string;
    status?: string;
    eventTypeIds?: number[];
    teamId?: number;
}

export interface PaginationGuards {
    pageSize: number;
    maxPages: number;
    maxRecords: number;
}

export interface PaginatedResult<T> {
    items: T[];
    stats: ResourceStats;
    warnings: string[];
}

export class CalComClient {
    constructor(
        private readonly http: HttpClient,
        private readonly guards: PaginationGuards,
    ) {}

    /**
     * Verifies the credential before anything expensive happens.
     *
     * A bad key produces a single clear 401 here rather than an ambiguous failure halfway
     * through pagination, and the returned user is itself a member of the workforce.
     */
    async getMe(): Promise<CalMe> {
        return this.unwrapObject<CalMe>(await this.http.getJson('/me', { label: 'GET /v2/me' }), 'GET /v2/me');
    }

    async listTeams(): Promise<CalTeam[]> {
        return this.unwrapArray<CalTeam>(
            await this.http.getJson('/teams', { label: 'GET /v2/teams' }),
            'GET /v2/teams',
        );
    }

    /** `/v2/teams/{id}/memberships` uses classic take/skip pagination. */
    async listTeamMemberships(teamId: number): Promise<PaginatedResult<CalMembership>> {
        return this.walkOffset<CalMembership>(`/teams/${teamId}/memberships`, `GET /v2/teams/${teamId}/memberships`, {
            take: Math.min(this.guards.pageSize, 250),
        });
    }

    /** `/v2/bookings` uses opaque cursor pagination and caps `limit` at 100. */
    async listBookings(query: BookingQuery): Promise<PaginatedResult<CalBooking>> {
        const params: Record<string, string | number | undefined> = {
            afterStart: query.afterStart,
            beforeEnd: query.beforeEnd,
            status: query.status,
            sortStart: 'asc',
        };
        if (query.eventTypeIds !== undefined && query.eventTypeIds.length > 0) {
            params.eventTypeIds = query.eventTypeIds.join(',');
        }
        if (query.teamId !== undefined) params.teamId = query.teamId;

        const label = `GET /v2/bookings${query.status === undefined ? '' : ` (status=${query.status})`}`;
        return this.walkCursor<CalBooking>('/bookings', label, params, CAL_API_VERSIONS.bookings);
    }

    /**
     * `/v2/event-types` is not paginated in the v2 spec, so one call returns the full list.
     * `username` narrows it to a specific user; without it the authenticated user's own types
     * are returned.
     */
    async listEventTypes(username?: string): Promise<CalEventType[]> {
        const label = `GET /v2/event-types${username === undefined ? '' : ` (username=${username})`}`;
        const body = await this.http.getJson('/event-types', {
            label,
            apiVersion: CAL_API_VERSIONS.eventTypes,
            query: { username },
        });
        return this.unwrapArray<CalEventType>(body, label);
    }

    async listTeamEventTypes(teamId: number): Promise<CalEventType[]> {
        const label = `GET /v2/teams/${teamId}/event-types`;
        const body = await this.http.getJson(`/teams/${teamId}/event-types`, {
            label,
            apiVersion: CAL_API_VERSIONS.eventTypes,
        });
        return this.unwrapArray<CalEventType>(body, label);
    }

    /** Cal.com only exposes schedules for the authenticated user. Documented as a limitation. */
    async listSchedules(): Promise<CalSchedule[]> {
        const label = 'GET /v2/schedules';
        const body = await this.http.getJson('/schedules', { label, apiVersion: CAL_API_VERSIONS.schedules });
        return this.unwrapArray<CalSchedule>(body, label);
    }

    /**
     * Walks an opaque-cursor endpoint to exhaustion.
     *
     * Guards, in order of precedence: a repeated cursor (a server-side bug that would otherwise
     * loop forever), an empty page, the configured record cap, then the configured page cap.
     * Hitting a cap is reported as a warning and marks the resource truncated so the run
     * summary can say the snapshot is partial rather than pretending it is complete.
     */
    private async walkCursor<T>(
        path: string,
        label: string,
        baseQuery: Record<string, string | number | undefined>,
        apiVersion: string,
    ): Promise<PaginatedResult<T>> {
        const items: T[] = [];
        const warnings: string[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | undefined;
        let pages = 0;
        let truncated = false;

        for (;;) {
            const body = await this.http.getJson<CalEnvelope<T[]> & { pagination?: CalCursorPagination }>(path, {
                label,
                apiVersion,
                query: { ...baseQuery, limit: this.guards.pageSize, cursor },
            });
            pages += 1;

            const page = this.unwrapArray<T>(body, label);
            items.push(...page);
            log.debug(`${label} page ${pages}: ${page.length} records (${items.length} so far)`);

            if (page.length === 0) break;

            if (items.length >= this.guards.maxRecords) {
                items.length = this.guards.maxRecords;
                truncated = true;
                warnings.push(
                    `${label} stopped at the maxRecordsPerResource cap of ${this.guards.maxRecords}; ` +
                        'the snapshot is incomplete.',
                );
                break;
            }

            const pagination = body.pagination;
            const nextCursor = typeof pagination?.nextCursor === 'string' ? pagination.nextCursor : null;
            if (pagination?.hasMore !== true || nextCursor === null || nextCursor === '') break;

            if (seenCursors.has(nextCursor)) {
                warnings.push(`${label} repeated a pagination cursor; stopped to avoid an infinite loop.`);
                truncated = true;
                break;
            }
            seenCursors.add(nextCursor);

            if (pages >= this.guards.maxPages) {
                truncated = true;
                warnings.push(
                    `${label} stopped at the maxPagesPerResource cap of ${this.guards.maxPages}; ` +
                        'the snapshot is incomplete.',
                );
                break;
            }
            cursor = nextCursor;
        }

        return { items, stats: { pages, records: items.length, truncated }, warnings };
    }

    /** Walks a take/skip endpoint to exhaustion, with the same caps and loop guards. */
    private async walkOffset<T>(path: string, label: string, options: { take: number }): Promise<PaginatedResult<T>> {
        const items: T[] = [];
        const warnings: string[] = [];
        const take = Math.max(1, options.take);
        let skip = 0;
        let pages = 0;
        let truncated = false;

        for (;;) {
            const body = await this.http.getJson<CalEnvelope<T[]>>(path, { label, query: { take, skip } });
            pages += 1;

            const page = this.unwrapArray<T>(body, label);
            items.push(...page);
            log.debug(`${label} page ${pages}: ${page.length} records (${items.length} so far)`);

            // A short page means the server has nothing left; this is the normal exit.
            if (page.length < take) break;

            if (items.length >= this.guards.maxRecords) {
                items.length = this.guards.maxRecords;
                truncated = true;
                warnings.push(
                    `${label} stopped at the maxRecordsPerResource cap of ${this.guards.maxRecords}; ` +
                        'the snapshot is incomplete.',
                );
                break;
            }
            if (pages >= this.guards.maxPages) {
                truncated = true;
                warnings.push(
                    `${label} stopped at the maxPagesPerResource cap of ${this.guards.maxPages}; ` +
                        'the snapshot is incomplete.',
                );
                break;
            }
            skip += take;
        }

        return { items, stats: { pages, records: items.length, truncated }, warnings };
    }

    /**
     * Unwraps the `{status, data}` envelope every v2 endpoint uses.
     *
     * A 200 response carrying `status: "error"` is an upstream failure, not empty data, and is
     * raised as one. A missing or non-array `data` is a contract break and raised as malformed,
     * because guessing here is exactly how an outage turns into "there are no workers".
     */
    private unwrapArray<T>(body: unknown, label: string): T[] {
        const envelope = this.assertEnvelope(body, label);
        const data = envelope.data;
        if (data === undefined || data === null) {
            throw new MalformedResponseError(`${label} returned an envelope without a "data" property.`, { label });
        }
        // The spec types some list endpoints as returning a bare object; tolerate that rather
        // than dropping a real record on the floor.
        if (!Array.isArray(data)) {
            if (typeof data === 'object') return [data as T];
            throw new MalformedResponseError(
                `${label} returned "data" of type ${typeof data}; an array of records was expected.`,
                { label },
            );
        }
        return data as T[];
    }

    private unwrapObject<T>(body: unknown, label: string): T {
        const envelope = this.assertEnvelope(body, label);
        const data = envelope.data;
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
            throw new MalformedResponseError(`${label} returned "data" that is not an object.`, { label });
        }
        return data as T;
    }

    private assertEnvelope(body: unknown, label: string): CalEnvelope<unknown> {
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            throw new MalformedResponseError(`${label} returned a body that is not a JSON object.`, { label });
        }
        const envelope = body as CalEnvelope<unknown>;
        if (envelope.status === 'error') {
            throw new UpstreamError(200, `${label} responded with status "error": ${JSON.stringify(envelope.error)}`, {
                label,
            });
        }
        if (envelope.status !== undefined && envelope.status !== 'success') {
            throw new MalformedResponseError(
                `${label} returned an unexpected envelope status ${JSON.stringify(envelope.status)}.`,
                { label },
            );
        }
        return envelope;
    }
}
