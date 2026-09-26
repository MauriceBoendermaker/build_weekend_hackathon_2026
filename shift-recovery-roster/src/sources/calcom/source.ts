/**
 * Cal.com source adapter.
 *
 * Turns the Cal.com API v2 into a {@link RawSnapshot}. It answers three questions and nothing
 * more:
 *
 * - who does the scheduling system know about?  (`/v2/me`, team memberships, event-type hosts)
 * - what is scheduled in the window?           (`/v2/bookings`)
 * - what availability does it publish?         (`/v2/schedules`, projected into the window)
 *
 * It deliberately does not invent employee IDs, roles, departments, skills or contracted
 * hours: Cal.com does not store them, so they come from the workforce metadata source instead
 * and are labelled as such.
 */

import { log } from 'apify';

import type { ResolvedInput } from '../../input.js';
import { HttpClient } from '../../http/fetcher.js';
import {
    clipToRange,
    isValidTimeZone,
    mergeWindows,
    utcDaysInRange,
    weekdayIndex,
    zonedWallClockToUtc,
} from '../../time.js';
import type { SourceSystem } from '../../types.js';
import {
    emptyStats,
    personKey,
    type RawSnapshot,
    type RosterSource,
    type SourceAvailability,
    type SourceEvent,
    type SourceParticipant,
    type SourcePerson,
    type SourceShiftType,
    type SourceStats,
} from '../source.js';
import {
    CalComClient,
    type CalBooking,
    type CalEventType,
    type CalMembership,
    type CalSchedule,
    type CalTeam,
} from './client.js';

const MS_PER_DAY = 86_400_000;

export interface CalComSourceOptions {
    input: ResolvedInput;
    /** Injected in tests. */
    client?: CalComClient;
    httpClient?: HttpClient;
}

export class CalComSource implements RosterSource {
    readonly id: SourceSystem = 'cal.com';

    private readonly input: ResolvedInput;

    private readonly client: CalComClient;

    private readonly http: HttpClient | null;

    private readonly people = new Map<string, SourcePerson>();

    /** Every identifier seen for a person, mapped to that person's canonical snapshot key. */
    private readonly aliasToKey = new Map<string, string>();

    private readonly warnings: string[] = [];

    private readonly resources: SourceStats['resources'] = {};

    constructor(options: CalComSourceOptions) {
        this.input = options.input;
        this.http =
            options.httpClient ??
            (options.client === undefined
                ? new HttpClient({
                      baseUrl: options.input.baseUrl,
                      apiKey: options.input.apiKey,
                      timeoutMs: options.input.requestTimeoutSecs * 1000,
                      maxRetries: options.input.maxRetries,
                  })
                : null);
        this.client =
            options.client ??
            new CalComClient(this.http as HttpClient, {
                pageSize: options.input.pageSize,
                maxPages: options.input.maxPagesPerResource,
                maxRecords: options.input.maxRecordsPerResource,
            });
    }

    async fetch(): Promise<RawSnapshot> {
        const { input } = this;
        log.info(`Querying Cal.com at ${input.baseUrl} for ${input.range.start} .. ${input.range.end}`);

        // Fail fast on credentials, and pick up the authenticated user as a known person.
        const me = await this.client.getMe();
        const meKey = this.rememberPerson(
            {
                externalId: me.id ?? null,
                username: me.username ?? null,
                name: me.name ?? null,
                email: me.email ?? null,
                timeZone: me.timeZone ?? null,
            },
            '/v2/me',
        );
        log.info(`Authenticated as Cal.com user #${me.id ?? 'unknown'} (${me.username ?? 'no username'})`);
        this.resources['/v2/me'] = { pages: 1, records: 1, truncated: false };

        const teams = await this.resolveTeams();
        await this.collectTeamMemberships(teams);
        const shiftTypes = await this.collectEventTypes(teams);
        const events = await this.collectBookings(teams);
        const availability = await this.collectAvailability(me.id ?? null, meKey);

        const stats: SourceStats = {
            ...emptyStats(),
            apiRequests: this.http?.stats.requests ?? 0,
            retries: this.http?.stats.retries ?? 0,
            rateLimitHits: this.http?.stats.rateLimitHits ?? 0,
            timeouts: this.http?.stats.timeouts ?? 0,
            pagesFetched: Object.values(this.resources).reduce((sum, resource) => sum + resource.pages, 0),
            resources: this.resources,
        };

        const complete = Object.values(this.resources).every((resource) => !resource.truncated);

        return {
            sourceSystem: 'cal.com',
            retrievedAt: new Date().toISOString(),
            people: [...this.people.values()],
            events,
            availability,
            shiftTypes,
            stats,
            warnings: this.warnings,
            complete,
        };
    }

    /** Resolves which teams are in scope, warning when a requested team is not visible. */
    private async resolveTeams(): Promise<CalTeam[]> {
        if (!this.input.includeTeamMemberships && !this.input.includeEventTypes) return [];

        const teams = await this.client.listTeams();
        this.resources['/v2/teams'] = { pages: 1, records: teams.length, truncated: false };

        // Cal.com organizations appear in this list too; they hold no shift rota of their own.
        const realTeams = teams.filter((team) => team.isOrganization !== true);

        if (this.input.teamIds.length === 0) {
            log.info(`Discovered ${realTeams.length} Cal.com team(s)`);
            return realTeams;
        }

        const selected: CalTeam[] = [];
        for (const teamId of this.input.teamIds) {
            const match = realTeams.find((team) => team.id === teamId);
            if (match === undefined) {
                // Still attempt it: the key may be able to read a team the list endpoint omits.
                this.warnings.push(`Team ${teamId} was requested but not returned by /v2/teams; attempting anyway.`);
                selected.push({ id: teamId });
            } else {
                selected.push(match);
            }
        }
        log.info(`Scoped to ${selected.length} requested Cal.com team(s)`);
        return selected;
    }

    private async collectTeamMemberships(teams: CalTeam[]): Promise<void> {
        if (!this.input.includeTeamMemberships) return;

        for (const team of teams) {
            if (team.id === undefined) continue;
            const result = await this.client.listTeamMemberships(team.id);
            this.resources[`/v2/teams/${team.id}/memberships`] = result.stats;
            this.warnings.push(...result.warnings);

            let added = 0;
            for (const membership of result.items) {
                if (!isAcceptedMembership(membership)) continue;
                const user = membership.user ?? {};
                const key = this.rememberPerson(
                    {
                        externalId: membership.userId ?? null,
                        username: user.username ?? null,
                        name: user.name ?? null,
                        email: user.email ?? null,
                        timeZone: null,
                    },
                    `team:${team.id}`,
                );
                if (key !== 'unknown') added += 1;
            }
            log.info(`Team ${team.id}${team.name === undefined ? '' : ` (${team.name})`}: ${added} accepted member(s)`);
        }
    }

    private async collectEventTypes(teams: CalTeam[]): Promise<SourceShiftType[]> {
        if (!this.input.includeEventTypes) return [];

        const collected: CalEventType[] = [];

        // The authenticated user's own event types, plus any explicitly requested usernames.
        const targets: (string | undefined)[] =
            this.input.usernames.length > 0 ? [...this.input.usernames] : [undefined];
        for (const username of targets) {
            const items = await this.client.listEventTypes(username);
            this.resources[`/v2/event-types${username === undefined ? '' : `?username=${username}`}`] = {
                pages: 1,
                records: items.length,
                truncated: false,
            };
            collected.push(...items);
        }

        for (const team of teams) {
            if (team.id === undefined) continue;
            const items = await this.client.listTeamEventTypes(team.id);
            this.resources[`/v2/teams/${team.id}/event-types`] = {
                pages: 1,
                records: items.length,
                truncated: false,
            };
            collected.push(...items.map((item) => ({ ...item, teamId: item.teamId ?? team.id })));
        }

        const shiftTypes: SourceShiftType[] = [];
        const seen = new Set<number>();
        for (const eventType of collected) {
            if (eventType.id !== undefined) {
                if (seen.has(eventType.id)) continue;
                seen.add(eventType.id);
            }
            const hostKeys: string[] = [];
            for (const user of eventType.users ?? []) {
                // Event-type users carry no email, so they are keyed by username.
                const key = this.rememberPerson(
                    {
                        externalId: user.id ?? null,
                        username: user.username ?? null,
                        name: user.name ?? null,
                        email: null,
                        timeZone: null,
                    },
                    `eventType:${eventType.id ?? 'unknown'}`,
                );
                if (key !== 'unknown') hostKeys.push(key);
            }
            shiftTypes.push({
                externalId: eventType.id ?? null,
                slug: eventType.slug ?? null,
                title: eventType.title ?? null,
                lengthInMinutes: eventType.lengthInMinutes ?? null,
                teamId: eventType.teamId ?? null,
                hostKeys,
            });
        }

        log.info(`Discovered ${shiftTypes.length} event type(s) describing bookable work`);
        return shiftTypes;
    }

    /**
     * Retrieves bookings across the requested statuses and team scopes.
     *
     * Cal.com filters by a single status per request, so several statuses mean several
     * paginated walks. The same is true of team scoping, hence the nested loop; both loops are
     * bounded by validated input.
     */
    private async collectBookings(teams: CalTeam[]): Promise<SourceEvent[]> {
        const statuses: (string | undefined)[] =
            this.input.bookingStatuses.length > 0 ? [...this.input.bookingStatuses] : [undefined];
        const teamScopes: (number | undefined)[] =
            this.input.teamIds.length > 0
                ? teams.map((team) => team.id).filter((id): id is number => id !== undefined)
                : [undefined];

        const events: SourceEvent[] = [];
        for (const status of statuses) {
            for (const teamId of teamScopes) {
                const result = await this.client.listBookings({
                    afterStart: this.input.range.start,
                    beforeEnd: this.input.range.end,
                    status,
                    eventTypeIds: this.input.eventTypeIds,
                    teamId,
                });
                const key = `/v2/bookings?status=${status ?? 'all'}${teamId === undefined ? '' : `&teamId=${teamId}`}`;
                this.resources[key] = result.stats;
                this.warnings.push(...result.warnings);

                for (const booking of result.items) {
                    events.push(this.toSourceEvent(booking));
                }
            }
        }

        log.info(`Retrieved ${events.length} booking(s) from Cal.com`);
        return events;
    }

    private toSourceEvent(booking: CalBooking): SourceEvent {
        const hosts = (booking.hosts ?? []).map((host) =>
            this.toParticipant(
                {
                    externalId: host.id ?? null,
                    username: host.username ?? null,
                    name: host.name ?? null,
                    email: host.email ?? null,
                    timeZone: host.timeZone ?? null,
                },
                booking.absentHost === true,
                `booking:${booking.uid ?? booking.id ?? 'unknown'}`,
            ),
        );
        const attendees = (booking.attendees ?? []).map((attendee) =>
            this.toParticipant(
                {
                    externalId: null,
                    username: null,
                    name: attendee.name ?? null,
                    email: attendee.email ?? null,
                    timeZone: attendee.timeZone ?? null,
                },
                attendee.absent === true,
                // Attendees are the other side of the booking, not staff; they are not added
                // to the workforce, only recorded on the event.
                null,
            ),
        );

        return {
            externalId: booking.id ?? null,
            uid: booking.uid ?? null,
            title: booking.title ?? null,
            start: booking.start,
            end: booking.end,
            durationMinutes: typeof booking.duration === 'number' ? booking.duration : null,
            status: booking.status ?? null,
            eventTypeId: booking.eventTypeId ?? booking.eventType?.id ?? null,
            eventTypeSlug: booking.eventType?.slug ?? null,
            teamId: null,
            hosts,
            attendees,
            createdAt: booking.createdAt,
            updatedAt: booking.updatedAt,
        };
    }

    private toParticipant(
        identity: Omit<SourcePerson, 'key' | 'discoveredVia'>,
        absent: boolean,
        discoveredVia: string | null,
    ): SourceParticipant {
        const key =
            discoveredVia === null
                ? personKey(identity.email, identity.username, identity.externalId)
                : this.rememberPerson(identity, discoveredVia);
        return {
            key: key === 'unknown' ? null : key,
            externalId: identity.externalId,
            username: identity.username,
            name: identity.name,
            email: identity.email,
            timeZone: identity.timeZone,
            absent,
        };
    }

    /**
     * Projects the authenticated user's weekly availability onto real UTC instants.
     *
     * Cal.com stores availability as wall-clock times plus an IANA zone. Candidate local dates
     * are taken one day wider than the window on both sides so that a zone offset cannot drop
     * a window that straddles the boundary; everything is then clipped back to the window and
     * merged.
     */
    private async collectAvailability(meId: number | null, meKey: string): Promise<SourceAvailability[]> {
        if (!this.input.includeSchedules) return [];

        const schedules = await this.client.listSchedules();
        this.resources['/v2/schedules'] = { pages: 1, records: schedules.length, truncated: false };

        const relevant = schedules.filter(
            (schedule) => meId === null || schedule.ownerId === undefined || schedule.ownerId === meId,
        );
        if (relevant.length === 0) {
            this.warnings.push('Cal.com returned no availability schedules for the authenticated user.');
            return [];
        }

        // Prefer the default schedule; otherwise take every schedule the user owns.
        const chosen = relevant.filter((schedule) => schedule.isDefault === true);
        const toProject = chosen.length > 0 ? chosen : relevant;

        const windows: { start: string; end: string }[] = [];
        let timeZone: string | null = null;
        for (const schedule of toProject) {
            const zone = resolveZone(schedule.timeZone);
            if (zone.warning !== null) this.warnings.push(zone.warning);
            timeZone ??= zone.timeZone;
            windows.push(...this.projectSchedule(schedule, zone.timeZone));
        }

        const merged = mergeWindows(windows);
        log.info(
            `Projected ${merged.length} availability window(s) for the authenticated user from ` +
                `${toProject.length} Cal.com schedule(s)`,
        );
        this.warnings.push(
            'Cal.com only exposes availability schedules for the authenticated user, so schedule-derived ' +
                'availability covers that user only. Availability for other workers must come from the ' +
                'workforce metadata source.',
        );

        if (merged.length === 0) return [];
        return [{ personKey: meKey, timeZone, windows: merged }];
    }

    private projectSchedule(schedule: CalSchedule, timeZone: string): { start: string; end: string }[] {
        const { range } = this.input;
        const candidateDays = utcDaysInRange(range.startMs - MS_PER_DAY, range.endMs + MS_PER_DAY);

        const overridesByDate = new Map<string, { startTime?: string; endTime?: string }>();
        for (const override of schedule.overrides ?? []) {
            const date = typeof override.date === 'string' ? override.date.slice(0, 10) : null;
            if (date !== null) overridesByDate.set(date, override);
        }

        const windows: { start: string; end: string }[] = [];
        for (const day of candidateDays) {
            const override = overridesByDate.get(day);
            if (override !== undefined) {
                // An override replaces the weekly rule for that date. Equal times mean a day off.
                const window = this.buildWindow(day, override.startTime, override.endTime, timeZone);
                if (window !== null) windows.push(window);
                continue;
            }

            const dayIndex = new Date(`${day}T00:00:00.000Z`).getUTCDay();
            for (const rule of schedule.availability ?? []) {
                const matches = (rule.days ?? []).some((name) => weekdayIndex(name) === dayIndex);
                if (!matches) continue;
                const window = this.buildWindow(day, rule.startTime, rule.endTime, timeZone);
                if (window !== null) windows.push(window);
            }
        }
        return windows;
    }

    /** Builds one UTC window from a local date plus wall-clock times, clipped to the range. */
    private buildWindow(
        day: string,
        startTime: string | undefined,
        endTime: string | undefined,
        timeZone: string,
    ): { start: string; end: string } | null {
        if (typeof startTime !== 'string' || typeof endTime !== 'string') return null;

        const startIso = zonedWallClockToUtc(day, normalizeWallClock(startTime), timeZone);
        let endIso = zonedWallClockToUtc(day, normalizeWallClock(endTime), timeZone);
        if (startIso === null || endIso === null) return null;

        // "22:00-06:00" and "09:00-00:00" both mean the window ends on the following day.
        if (Date.parse(endIso) <= Date.parse(startIso)) {
            const nextDay = new Date(Date.parse(`${day}T00:00:00.000Z`) + MS_PER_DAY).toISOString().slice(0, 10);
            endIso = zonedWallClockToUtc(nextDay, normalizeWallClock(endTime), timeZone);
            if (endIso === null || Date.parse(endIso) <= Date.parse(startIso)) return null;
        }

        return clipToRange(startIso, endIso, this.input.range.startMs, this.input.range.endMs);
    }

    /**
     * Records a person once, merging in any identity detail a later resource reveals.
     *
     * Cal.com identifies the same human differently per resource: team memberships carry an
     * email and a username, event-type hosts carry only a username and a numeric ID, booking
     * hosts carry all three. Keying naively on whatever a resource happened to provide would
     * split one nurse into three "workers" and let the decision layer double-book her.
     *
     * So every identifier a resource reveals is registered as an alias of one canonical key,
     * and a later sighting resolves through those aliases before a new person is created.
     */
    private rememberPerson(identity: Omit<SourcePerson, 'key' | 'discoveredVia'>, discoveredVia: string): string {
        const aliases = identityAliases(identity);
        if (aliases.length === 0) return 'unknown';

        // Aliases are in precedence order (email, username, ID), so the first one is the key a
        // brand-new person gets - the same order personKey() uses.
        const canonical =
            aliases.map((alias) => this.aliasToKey.get(alias)).find((key) => key !== undefined) ??
            (aliases[0] as string);

        const existing = this.people.get(canonical);
        this.people.set(
            canonical,
            existing === undefined
                ? { key: canonical, discoveredVia, ...identity }
                : {
                      ...existing,
                      externalId: existing.externalId ?? identity.externalId,
                      username: existing.username ?? identity.username,
                      name: existing.name ?? identity.name,
                      email: existing.email ?? identity.email,
                      timeZone: existing.timeZone ?? identity.timeZone,
                  },
        );
        for (const alias of aliases) this.aliasToKey.set(alias, canonical);
        return canonical;
    }
}

/**
 * Every identifier that can stand for this person, in the same precedence order
 * {@link personKey} uses: email, then username, then the source's numeric ID.
 */
function identityAliases(identity: Omit<SourcePerson, 'key' | 'discoveredVia'>): string[] {
    const aliases: string[] = [];
    if (identity.email !== null && identity.email.trim() !== '')
        aliases.push(`email:${identity.email.trim().toLowerCase()}`);
    if (identity.username !== null && identity.username.trim() !== '') {
        aliases.push(`username:${identity.username.trim().toLowerCase()}`);
    }
    if (identity.externalId !== null) aliases.push(`id:${identity.externalId}`);
    return aliases;
}

function isAcceptedMembership(membership: CalMembership): boolean {
    // `accepted: false` is a pending invitation - not somebody who can be asked to work a shift.
    return membership.accepted !== false;
}

/** Cal.com wall-clock values are sometimes full ISO timestamps; keep only `HH:mm`. */
export function normalizeWallClock(value: string): string {
    const isoTime = /T(\d{2}:\d{2})/.exec(value);
    if (isoTime?.[1] !== undefined) return isoTime[1];
    const hm = /^(\d{1,2}):(\d{2})/.exec(value.trim());
    if (hm?.[1] !== undefined && hm[2] !== undefined) return `${hm[1].padStart(2, '0')}:${hm[2]}`;
    return value.trim();
}

function resolveZone(timeZone: string | undefined): { timeZone: string; warning: string | null } {
    if (typeof timeZone !== 'string' || timeZone.trim() === '') {
        return { timeZone: 'UTC', warning: 'A Cal.com schedule had no time zone; its availability was read as UTC.' };
    }
    if (!isValidTimeZone(timeZone)) {
        return {
            timeZone: 'UTC',
            warning: `A Cal.com schedule reported the unsupported time zone "${timeZone}"; it was read as UTC.`,
        };
    }
    return { timeZone, warning: null };
}
