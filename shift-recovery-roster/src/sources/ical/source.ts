/**
 * iCalendar source adapter.
 *
 * Reads any calendar that publishes an iCalendar (.ics) feed - Google Calendar's "secret
 * address in iCal format", an Outlook/Microsoft 365 published calendar, iCloud, Cal.com - so a
 * roster can live in whatever calendar a ward already uses, at no cost.
 *
 * The mapping is deliberately plain:
 *
 * - every timed VEVENT inside the window is a shift; recurring events are expanded,
 * - the event's ATTENDEEs (minus the ORGANIZER, rooms and anyone who declined) are the people
 *   working it, the first of them being the assignee - the same "first host" rule Cal.com uses,
 * - a title starting with `sickPrefix` (default `ZIEK`) means the shift was reported sick, so
 *   it is emitted as cancelled: not worked, not counted towards hours.
 *
 * The feed URL usually embeds a secret token, so it is handled like a credential: it never
 * appears in a log line, an error message or error context.
 */

import { log } from 'apify';
import ical, { type Attendee, type CalendarResponse, type VEvent } from 'node-ical';

import {
    MalformedResponseError,
    NetworkError,
    RosterError,
    UpstreamError,
    UpstreamTimeoutError,
    toRosterError,
} from '../../errors.js';
import type { FetchImpl, SleepImpl } from '../../http/fetcher.js';
import type { ResolvedInput } from '../../input.js';
import { mergeWindows, subtractIntervals } from '../../time.js';
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
    type SourceStats,
} from '../source.js';

export interface IcalSourceOptions {
    input: ResolvedInput;
    /** Injected in tests. Defaults to the global `fetch`. */
    fetchImpl?: FetchImpl;
    /** Injected in tests so retry backoff does not actually sleep. */
    sleepImpl?: SleepImpl;
}

/** Shift records from this source carry this slug, so `shiftTypeMetadata` can map them. */
export const ICAL_EVENT_TYPE_SLUG = 'ical';

const LABEL = 'the iCal feed';

export class IcalSource implements RosterSource {
    readonly id: SourceSystem = 'ical';

    private readonly fetchImpl: FetchImpl;

    private readonly sleepImpl: SleepImpl;

    constructor(private readonly options: IcalSourceOptions) {
        this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
        this.sleepImpl =
            options.sleepImpl ??
            ((ms) =>
                new Promise((resolve) => {
                    setTimeout(resolve, ms);
                }));
    }

    async fetch(): Promise<RawSnapshot> {
        const { input } = this.options;
        if (input.icsUrl === null) {
            throw new RosterError(
                'INPUT_INVALID',
                'The iCal source needs "icsUrl" or the ICS_URL environment variable.',
            );
        }

        const stats = emptyStats();
        const body = await this.download(input.icsUrl, stats);

        let calendar: CalendarResponse;
        try {
            calendar = ical.sync.parseICS(body);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new MalformedResponseError(`${LABEL} could not be parsed as iCalendar: ${message}`);
        }

        const events = expandEvents(calendar, input);
        const people = collectPeople(events, input);
        const availability = buildAvailability(people, events, input);

        stats.pagesFetched = 1;
        stats.resources['ical:feed'] = { pages: 1, records: events.length, truncated: false };
        log.info(`iCal feed: ${events.length} timed event(s) in the window, ${people.length} person record(s)`);

        return {
            sourceSystem: 'ical',
            retrievedAt: new Date().toISOString(),
            people,
            events,
            availability,
            shiftTypes: [],
            stats,
            warnings: [
                'iCal feeds carry no availability, so each person is treated as available whenever they are not ' +
                    'on a shift in the window. Supply employeeMetadata[].availability to narrow that.',
            ],
            complete: true,
        };
    }

    /** GETs the feed, retrying transient failures like the Cal.com client does. */
    private async download(url: string, stats: SourceStats): Promise<string> {
        const { maxRetries, requestTimeoutSecs } = this.options.input;
        let lastError: RosterError | undefined;

        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            if (attempt > 0) {
                stats.retries += 1;
                log.warning(`Retrying ${LABEL} (attempt ${attempt + 1}/${maxRetries + 1}) after ${lastError?.code}`);
                await this.sleepImpl(Math.min(500 * 2 ** (attempt - 1), 30_000));
            }
            try {
                stats.apiRequests += 1;
                return await this.attempt(url, requestTimeoutSecs * 1000, stats);
            } catch (err) {
                const error = toRosterError(err);
                if (!error.retryable) throw error;
                lastError = error;
            }
        }
        throw lastError ?? new RosterError('UNEXPECTED_ERROR', `${LABEL} failed without producing an error object.`);
    }

    private async attempt(url: string, timeoutMs: number, stats: SourceStats): Promise<string> {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        let response: Response;
        try {
            response = await this.fetchImpl(url, {
                method: 'GET',
                headers: { accept: 'text/calendar', 'user-agent': 'apify-shift-recovery-roster/1.0' },
                signal: controller.signal,
                redirect: 'follow',
            });
        } catch (err) {
            if (timedOut) {
                stats.timeouts += 1;
                throw new UpstreamTimeoutError(`${LABEL} timed out after ${timeoutMs} ms.`);
            }
            const message = err instanceof Error ? err.message : String(err);
            // The message of a failed fetch can contain the URL; keep only the error class.
            throw new NetworkError(
                `Network error fetching ${LABEL} (${message.includes('://') ? 'fetch failed' : message}).`,
            );
        } finally {
            clearTimeout(timer);
        }

        if (!response.ok) {
            const hint =
                response.status === 401 || response.status === 403 || response.status === 404
                    ? ' The address is wrong, was reset, or the calendar is no longer shared - copy it again from the calendar settings.'
                    : '';
            throw new UpstreamError(response.status, `${LABEL} returned HTTP ${response.status}.${hint}`);
        }

        const body = await response.text();
        if (!/^\s*BEGIN:VCALENDAR/i.test(body)) {
            throw new MalformedResponseError(
                `${LABEL} did not return an iCalendar document (content-type ${response.headers.get('content-type') ?? 'unknown'}). ` +
                    'It may be a login page: use the secret/public iCal address, not the calendar web page.',
            );
        }
        return body;
    }
}

/** Every timed occurrence overlapping the window, as a source event. */
export function expandEvents(calendar: CalendarResponse, input: ResolvedInput): SourceEvent[] {
    const from = new Date(input.range.startMs);
    const to = new Date(input.range.endMs);
    const sickPrefix = input.sickPrefix.toLowerCase();
    const events: SourceEvent[] = [];

    for (const component of Object.values(calendar)) {
        if (component === undefined || component.type !== 'VEVENT') continue;
        const vevent = component as VEvent;
        // RECURRENCE-ID overrides are applied by expanding their base event.
        if (vevent.recurrenceid !== undefined) continue;

        const instances = ical.expandRecurringEvent(vevent, { from, to, expandOngoing: true });
        for (const instance of instances) {
            // All-day entries are notes, holidays or leave blocks - not timed shifts.
            if (instance.isFullDay) continue;

            const source = instance.event;
            const title = textOf(instance.summary) ?? textOf(source.summary);
            const start = instance.start.toISOString();
            const end = instance.end.toISOString();
            const baseUid = cleanUid(source.uid ?? vevent.uid);

            events.push({
                externalId: null,
                // Recurring instances get the "<id>_<UTC start>" form Google's API uses for them.
                uid: instance.isRecurring || instance.isOverride ? `${baseUid}_${compactUtc(start)}` : baseUid,
                title,
                start,
                end,
                durationMinutes: Math.round((Date.parse(end) - Date.parse(start)) / 60_000),
                status: eventStatus(source, title, sickPrefix),
                eventTypeId: null,
                eventTypeSlug: ICAL_EVENT_TYPE_SLUG,
                teamId: null,
                hosts: workingParticipants(source),
                attendees: [],
                createdAt: source.created?.toISOString() ?? null,
                updatedAt: source.lastmodified?.toISOString() ?? null,
            });
        }
    }
    return events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
}

/** Google suffixes feed UIDs with `@google.com`; its API ids do not have it. */
export function cleanUid(uid: string): string {
    return uid.trim().replace(/@google\.com$/i, '');
}

function compactUtc(iso: string): string {
    return iso.replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

function eventStatus(event: VEvent, title: string | null, sickPrefix: string): string {
    if (event.status === 'CANCELLED') return 'cancelled';
    if (sickPrefix !== '' && title !== null && title.trim().toLowerCase().startsWith(sickPrefix)) return 'cancelled';
    if (event.status === 'TENTATIVE') return 'pending';
    return 'accepted';
}

/** Attendees who work the shift: not the organizer, not rooms or resources, not decliners. */
function workingParticipants(event: VEvent): SourceParticipant[] {
    const organizer = emailOf(event.organizer);
    const attendees =
        event.attendee === undefined ? [] : Array.isArray(event.attendee) ? event.attendee : [event.attendee];
    const seen = new Set<string>();
    const participants: SourceParticipant[] = [];

    for (const attendee of attendees) {
        const email = emailOf(attendee);
        if (email === null || email === organizer || seen.has(email)) continue;
        const params = paramsOf(attendee);
        const type = (params.CUTYPE ?? 'INDIVIDUAL').toUpperCase();
        if (type === 'ROOM' || type === 'RESOURCE') continue;
        if ((params.PARTSTAT ?? '').toUpperCase() === 'DECLINED') continue;

        seen.add(email);
        participants.push({
            key: personKey(email, null, null),
            externalId: null,
            username: null,
            name: params.CN ?? null,
            email,
            timeZone: null,
            absent: false,
        });
    }
    return participants;
}

/**
 * The workforce: everyone working a shift in the feed, plus every employee in the inline
 * metadata. The second group matters - somebody with no shift this week is the best candidate
 * to cover one, so they must appear even though the calendar never mentions them.
 */
function collectPeople(events: SourceEvent[], input: ResolvedInput): SourcePerson[] {
    const people = new Map<string, SourcePerson>();

    for (const event of events) {
        for (const host of event.hosts) {
            if (host.key === null || people.has(host.key)) continue;
            people.set(host.key, {
                key: host.key,
                externalId: null,
                username: null,
                name: host.name,
                email: host.email,
                timeZone: null,
                discoveredVia: 'ical:attendee',
            });
        }
    }
    for (const employee of input.employeeMetadata) {
        if (employee.email === null) continue;
        const key = personKey(employee.email, null, null);
        if (people.has(key)) continue;
        people.set(key, {
            key,
            externalId: null,
            username: null,
            name: null,
            email: employee.email,
            timeZone: null,
            discoveredVia: 'workforce-metadata',
        });
    }
    return [...people.values()];
}

/**
 * ponytail: an iCal feed publishes no availability, so a person counts as available for the
 * whole window minus their own shifts. The downstream overlap and rest-time rules still apply;
 * real availability can be supplied through employeeMetadata[].availability.
 */
function buildAvailability(people: SourcePerson[], events: SourceEvent[], input: ResolvedInput): SourceAvailability[] {
    const busy = new Map<string, { start: string; end: string }[]>();
    for (const event of events) {
        if (event.status === 'cancelled') continue;
        for (const host of event.hosts) {
            if (host.key === null) continue;
            const list = busy.get(host.key) ?? [];
            list.push({ start: String(event.start), end: String(event.end) });
            busy.set(host.key, list);
        }
    }

    const window = { start: input.range.start, end: input.range.end };
    return people
        .map((person) => ({
            personKey: person.key,
            timeZone: null,
            windows: mergeWindows(subtractIntervals(window, busy.get(person.key) ?? [])),
        }))
        .filter((entry) => entry.windows.length > 0);
}

function textOf(value: string | { val: string } | undefined): string | null {
    if (value === undefined) return null;
    const text = typeof value === 'string' ? value : value.val;
    return text.trim() === '' ? null : text.trim();
}

function emailOf(value: string | { val: string } | undefined): string | null {
    const text = textOf(value);
    if (text === null) return null;
    const email = text
        .replace(/^mailto:/i, '')
        .trim()
        .toLowerCase();
    return email.includes('@') ? email : null;
}

function paramsOf(value: Attendee): Record<string, string> {
    return typeof value === 'string' ? {} : ((value.params ?? {}) as Record<string, string>);
}
