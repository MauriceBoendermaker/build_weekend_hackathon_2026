/**
 * The source adapter seam.
 *
 * A source knows how to talk to one scheduling system and nothing else. It returns a
 * {@link RawSnapshot}: source-shaped data with the vendor's quirks already smoothed out, but
 * with no business meaning attached. Everything downstream - normalization, metadata
 * enrichment, validation, deduplication - works purely against `RawSnapshot`.
 *
 * That is the whole point of the boundary. Swapping `CalComSource` for a
 * `HospitalRosterSource` means writing one `fetch()` that fills this structure; not a single
 * line of the pipeline changes.
 */

import type { SourceSystem } from '../types.js';

/** A person the scheduling system knows about. */
export interface SourcePerson {
    /**
     * Stable key within this snapshot, used to link people to events and availability.
     * Lower-cased email when available, otherwise the source's own identifier.
     */
    key: string;
    externalId: number | null;
    username: string | null;
    name: string | null;
    email: string | null;
    timeZone: string | null;
    /** Which API resource surfaced this person, for diagnostics. */
    discoveredVia: string;
}

export interface SourceParticipant {
    key: string | null;
    externalId: number | null;
    username: string | null;
    name: string | null;
    email: string | null;
    timeZone: string | null;
    /** True when the participant is absent from the event according to the source. */
    absent: boolean;
}

/** One scheduled occurrence in the source system: a Cal.com booking, a roster entry, etc. */
export interface SourceEvent {
    externalId: number | null;
    /** The source's own stable string identifier, if it has one. */
    uid: string | null;
    title: string | null;
    /** Raw start value exactly as the source returned it; normalization parses it. */
    start: unknown;
    end: unknown;
    durationMinutes: number | null;
    /** Raw status string from the source. */
    status: string | null;
    eventTypeId: number | null;
    eventTypeSlug: string | null;
    teamId: number | null;
    /** The people doing the work. The first host is treated as the assignee. */
    hosts: SourceParticipant[];
    attendees: SourceParticipant[];
    createdAt: unknown;
    updatedAt: unknown;
}

/** Availability the scheduling system itself reports, already projected onto real instants. */
export interface SourceAvailability {
    personKey: string;
    timeZone: string | null;
    windows: { start: string; end: string }[];
}

/** A bookable kind of work, e.g. a Cal.com event type. Used to resolve shift requirements. */
export interface SourceShiftType {
    externalId: number | null;
    slug: string | null;
    title: string | null;
    lengthInMinutes: number | null;
    teamId: number | null;
    /** Keys of people who can host this kind of work. */
    hostKeys: string[];
}

export interface ResourceStats {
    pages: number;
    records: number;
    /** True when a configured cap stopped retrieval before the source ran out of data. */
    truncated: boolean;
}

export interface SourceStats {
    apiRequests: number;
    retries: number;
    rateLimitHits: number;
    timeouts: number;
    pagesFetched: number;
    resources: Record<string, ResourceStats>;
}

export interface RawSnapshot {
    sourceSystem: SourceSystem;
    /** ISO-8601 UTC timestamp of when retrieval finished. */
    retrievedAt: string;
    people: SourcePerson[];
    events: SourceEvent[];
    availability: SourceAvailability[];
    shiftTypes: SourceShiftType[];
    stats: SourceStats;
    /** Non-fatal problems worth surfacing in the run summary. */
    warnings: string[];
    /** True when every requested resource was retrieved in full. */
    complete: boolean;
}

export interface RosterSource {
    /** Identifier used in logs and in the summary record. */
    readonly id: SourceSystem;

    /** Retrieves everything in scope. Throws a typed error rather than returning partial data. */
    fetch(): Promise<RawSnapshot>;
}

export function emptyStats(): SourceStats {
    return { apiRequests: 0, retries: 0, rateLimitHits: 0, timeouts: 0, pagesFetched: 0, resources: {} };
}

/** Builds the key used to link people across resources within one snapshot. */
export function personKey(email: string | null, username: string | null, externalId: number | null): string {
    if (email !== null && email.trim() !== '') return `email:${email.trim().toLowerCase()}`;
    if (username !== null && username.trim() !== '') return `username:${username.trim().toLowerCase()}`;
    if (externalId !== null) return `id:${externalId}`;
    return 'unknown';
}
