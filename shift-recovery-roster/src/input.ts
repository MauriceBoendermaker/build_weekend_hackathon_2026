/**
 * Input parsing, coercion and validation.
 *
 * Everything that can be wrong with the configuration is caught here, before a single API
 * call is made, so a misconfigured run fails in a second with a message that says what to fix
 * rather than after ten minutes of pagination.
 */

import { CredentialsMissingError, InputError } from './errors.js';
import { resolveRange, type ResolvedRange } from './time.js';
import type { Provenance, SourceSystem } from './types.js';

export type Mode = 'live' | 'hybrid' | 'demo';

export const BOOKING_STATUSES = ['upcoming', 'recurring', 'past', 'cancelled', 'unconfirmed'] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** A workforce metadata entry as supplied by the operator. */
export interface EmployeeMetadata {
    employeeId: string;
    /** Primary match key against Cal.com users, compared case-insensitively. */
    email: string | null;
    calUsername: string | null;
    calUserId: number | null;
    name: string | null;
    role: string | null;
    department: string | null;
    skills: string[];
    contractedHoursPerWeek: number | null;
    /** Optional roster-supplied availability windows, normalized to UTC. */
    availability: { start: string; end: string }[];
}

/** Maps a Cal.com event type onto the shift requirements it represents. */
export interface ShiftTypeMetadata {
    eventTypeId: number | null;
    eventTypeSlug: string | null;
    role: string | null;
    department: string | null;
    requiredSkills: string[];
    /** Where this mapping came from, so shift requirements carry honest provenance too. */
    provenance: Provenance;
}

export interface ResolvedInput {
    mode: Mode;
    apiKey: string;
    baseUrl: string;
    /**
     * iCalendar feed to read instead of Cal.com. Often a secret address (Google's "secret
     * address in iCal format"), so it is treated like a credential: never logged, never quoted.
     */
    icsUrl: string | null;
    /** Events whose title starts with this (case-insensitive) are reported sick: cancelled, not worked. */
    sickPrefix: string;
    range: ResolvedRange;
    teamIds: number[];
    eventTypeIds: number[];
    usernames: string[];
    bookingStatuses: BookingStatus[];
    includeTeamMemberships: boolean;
    includeEventTypes: boolean;
    includeSchedules: boolean;
    emitSchedulingEvents: boolean;
    employeeMetadata: EmployeeMetadata[];
    employeeMetadataUrl: string | null;
    employeeMetadataStoreKey: string | null;
    employeeMetadataStoreId: string | null;
    shiftTypeMetadata: ShiftTypeMetadata[];
    useDemoWorkforceMetadata: boolean;
    pageSize: number;
    maxPagesPerResource: number;
    maxRecordsPerResource: number;
    requestTimeoutSecs: number;
    maxRetries: number;
    maxDateRangeDays: number;
    failOnEmptyResult: boolean;
    debug: boolean;
}

export interface ParseInputOptions {
    /** Environment to read the credential fallback from. */
    env?: Record<string, string | undefined>;
    /** Reference point for relative window boundaries; makes runs reproducible in tests. */
    now?: Date;
}

export function parseInput(raw: unknown, options: ParseInputOptions = {}): ResolvedInput {
    const env = options.env ?? process.env;
    const now = options.now ?? new Date();

    if (raw !== null && raw !== undefined && typeof raw !== 'object') {
        throw new InputError('Actor input must be a JSON object.');
    }
    const input = (raw ?? {}) as Record<string, unknown>;

    const mode = asEnum<Mode>(input.mode, ['live', 'hybrid', 'demo'], 'live', 'mode');
    const maxDateRangeDays = asInteger(input.maxDateRangeDays, 90, 'maxDateRangeDays', 1, 730);
    const range = resolveRange(
        asString(input.startTime, 'now', 'startTime'),
        asString(input.endTime, 'now+7d', 'endTime'),
        maxDateRangeDays,
        now,
    );

    const icsUrl = resolveIcsUrl(input.icsUrl, env);
    const apiKey = resolveApiKey(input.apiKey, env, mode, icsUrl !== null);
    const baseUrl = normalizeBaseUrl(asString(input.baseUrl, 'https://api.cal.com/v2', 'baseUrl'));

    const statuses = asStringArray(input.bookingStatuses, ['upcoming'], 'bookingStatuses');
    const bookingStatuses = statuses.map((status) => {
        if (!(BOOKING_STATUSES as readonly string[]).includes(status)) {
            throw new InputError(
                `"bookingStatuses" contains an unsupported value ${JSON.stringify(status)}. ` +
                    `Cal.com accepts: ${BOOKING_STATUSES.join(', ')}.`,
            );
        }
        return status as BookingStatus;
    });

    const resolved: ResolvedInput = {
        mode,
        apiKey,
        baseUrl,
        icsUrl,
        sickPrefix: asString(input.sickPrefix, 'ZIEK', 'sickPrefix').trim(),
        range,
        teamIds: asIdArray(input.teamIds, 'teamIds'),
        eventTypeIds: asIdArray(input.eventTypeIds, 'eventTypeIds'),
        usernames: asStringArray(input.usernames, [], 'usernames').map((name) => name.trim().replace(/^@/, '')),
        bookingStatuses: dedupeStrings(bookingStatuses) as BookingStatus[],
        includeTeamMemberships: asBoolean(input.includeTeamMemberships, true),
        includeEventTypes: asBoolean(input.includeEventTypes, true),
        includeSchedules: asBoolean(input.includeSchedules, true),
        emitSchedulingEvents: asBoolean(input.emitSchedulingEvents, true),
        employeeMetadata: parseEmployeeMetadataList(input.employeeMetadata, 'employeeMetadata'),
        employeeMetadataUrl: asOptionalUrl(input.employeeMetadataUrl, 'employeeMetadataUrl'),
        employeeMetadataStoreKey: asOptionalString(input.employeeMetadataStoreKey),
        employeeMetadataStoreId: asOptionalString(input.employeeMetadataStoreId),
        shiftTypeMetadata: parseShiftTypeMetadataList(input.shiftTypeMetadata),
        // Demo metadata is implied by the demo and hybrid modes; the flag only adds it to live runs.
        useDemoWorkforceMetadata: mode !== 'live' || asBoolean(input.useDemoWorkforceMetadata, false),
        pageSize: asInteger(input.pageSize, 100, 'pageSize', 1, 100),
        maxPagesPerResource: asInteger(input.maxPagesPerResource, 100, 'maxPagesPerResource', 1, 10_000),
        maxRecordsPerResource: asInteger(input.maxRecordsPerResource, 5000, 'maxRecordsPerResource', 1, 500_000),
        requestTimeoutSecs: asInteger(input.requestTimeoutSecs, 30, 'requestTimeoutSecs', 1, 300),
        maxRetries: asInteger(input.maxRetries, 4, 'maxRetries', 0, 10),
        maxDateRangeDays,
        failOnEmptyResult: asBoolean(input.failOnEmptyResult, false),
        debug: asBoolean(input.debug, false),
    };

    return resolved;
}

/**
 * A log-safe view of the configuration.
 *
 * The credential is reduced to a boolean and a prefix. Nothing here can leak a secret, which
 * is why this - and never the raw input - is what gets logged at the start of a run.
 */
export function describeConfig(input: ResolvedInput): Record<string, unknown> {
    return {
        mode: input.mode,
        sourceSystem: sourceSystemFor(input),
        baseUrl: input.baseUrl,
        icsConfigured: input.icsUrl !== null,
        sickPrefix: input.sickPrefix,
        credentialProvided: input.apiKey !== '',
        credentialKind: input.apiKey === '' ? 'none' : classifyKey(input.apiKey),
        window: { start: input.range.start, end: input.range.end, days: Number(input.range.durationDays.toFixed(2)) },
        filters: {
            teamIds: input.teamIds,
            eventTypeIds: input.eventTypeIds,
            usernames: input.usernames,
            bookingStatuses: input.bookingStatuses,
        },
        retrieve: {
            teamMemberships: input.includeTeamMemberships,
            eventTypes: input.includeEventTypes,
            schedules: input.includeSchedules,
            schedulingEvents: input.emitSchedulingEvents,
        },
        workforceMetadata: {
            inlineEntries: input.employeeMetadata.length,
            urlConfigured: input.employeeMetadataUrl !== null,
            storeKeyConfigured: input.employeeMetadataStoreKey !== null,
            shiftTypeEntries: input.shiftTypeMetadata.length,
            demoFallback: input.useDemoWorkforceMetadata,
        },
        limits: {
            pageSize: input.pageSize,
            maxPagesPerResource: input.maxPagesPerResource,
            maxRecordsPerResource: input.maxRecordsPerResource,
            requestTimeoutSecs: input.requestTimeoutSecs,
            maxRetries: input.maxRetries,
        },
        failOnEmptyResult: input.failOnEmptyResult,
    };
}

/** Reports the key flavour without revealing any of it. */
function classifyKey(apiKey: string): string {
    if (apiKey.startsWith('cal_live_')) return 'cal_live';
    if (apiKey.startsWith('cal_test_')) return 'cal_test';
    if (apiKey.startsWith('cal_')) return 'cal';
    return 'opaque';
}

/** Which source adapter this configuration selects. Mirrors `createSource()` in the pipeline. */
export function sourceSystemFor(input: Pick<ResolvedInput, 'mode' | 'icsUrl'>): SourceSystem {
    if (input.mode === 'demo') return 'demo';
    return input.icsUrl === null ? 'cal.com' : 'ical';
}

/**
 * The feed URL may carry a secret token in its path, so validation errors describe the
 * problem without echoing the value. `webcal://` is the same feed over HTTPS.
 */
function resolveIcsUrl(value: unknown, env: Record<string, string | undefined>): string | null {
    const raw = asOptionalString(value) ?? asOptionalString(env.ICS_URL);
    if (raw === null) return null;
    let url: URL;
    try {
        url = new URL(raw.replace(/^webcal:\/\//i, 'https://'));
    } catch {
        throw new InputError('"icsUrl" is not a valid URL.');
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        throw new InputError('"icsUrl" must use HTTPS (or webcal://).');
    }
    return url.toString();
}

function resolveApiKey(value: unknown, env: Record<string, string | undefined>, mode: Mode, usesIcal: boolean): string {
    const fromInput = asOptionalString(value);
    const fromEnv = asOptionalString(env.CAL_COM_API_KEY);
    const apiKey = fromInput ?? fromEnv ?? '';

    // Neither the demo roster nor an iCal feed talks to Cal.com.
    if (mode === 'demo' || usesIcal) return apiKey;

    if (apiKey === '') {
        throw new CredentialsMissingError(
            `Mode "${mode}" needs a Cal.com API key. Set the "apiKey" input (it is a secret field) or the ` +
                'CAL_COM_API_KEY environment variable. To run without credentials, set "mode" to "demo".',
        );
    }
    if (apiKey.length < 16) {
        throw new InputError(
            'The supplied Cal.com API key is too short to be valid. Copy the full key from ' +
                'Settings > Developer > API keys.',
        );
    }
    return apiKey;
}

function normalizeBaseUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new InputError(`"baseUrl" is not a valid URL: ${JSON.stringify(value)}.`);
    }
    const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !isLocal) {
        throw new InputError('"baseUrl" must use HTTPS. Cal.com rejects plain HTTP requests.');
    }
    return url.toString().replace(/\/+$/, '');
}

function asString(value: unknown, fallback: string, field: string): string {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'string') throw new InputError(`"${field}" must be a string.`);
    return value;
}

function asOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

function asOptionalUrl(value: unknown, field: string): string | null {
    const raw = asOptionalString(value);
    if (raw === null) return null;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new InputError(`"${field}" is not a valid URL: ${JSON.stringify(raw)}.`);
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        throw new InputError(`"${field}" must use HTTPS.`);
    }
    return url.toString();
}

function asBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
}

function asInteger(value: unknown, fallback: number, field: string, min: number, max: number): number {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed))
        throw new InputError(`"${field}" must be a number, received ${JSON.stringify(value)}.`);
    const rounded = Math.trunc(parsed);
    if (rounded < min || rounded > max) {
        throw new InputError(`"${field}" must be between ${min} and ${max}, received ${rounded}.`);
    }
    return rounded;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T, field: string): T {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
        throw new InputError(`"${field}" must be one of ${allowed.join(', ')}, received ${JSON.stringify(value)}.`);
    }
    return value as T;
}

function asStringArray(value: unknown, fallback: string[], field: string): string[] {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'string') return [value];
    if (!Array.isArray(value)) throw new InputError(`"${field}" must be an array of strings.`);
    return value
        .filter((item) => item !== null && item !== undefined && item !== '')
        .map((item) => {
            if (typeof item !== 'string' && typeof item !== 'number') {
                throw new InputError(`"${field}" must contain only strings, found ${typeof item}.`);
            }
            return String(item).trim();
        })
        .filter((item) => item !== '');
}

/** Cal.com IDs are numeric; the Console string-list editor hands them over as strings. */
function asIdArray(value: unknown, field: string): number[] {
    const ids = asStringArray(value, [], field).map((item) => {
        const parsed = Number(item);
        if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new InputError(`"${field}" must contain positive integer IDs, received ${JSON.stringify(item)}.`);
        }
        return parsed;
    });
    return [...new Set(ids)];
}

function dedupeStrings(values: string[]): string[] {
    return [...new Set(values)];
}

/**
 * Parses operator-supplied employee metadata.
 *
 * Structural problems throw, because silently dropping a roster entry would make the
 * downstream agent skip a real, eligible worker.
 */
export function parseEmployeeMetadataList(value: unknown, field: string): EmployeeMetadata[] {
    const items = asObjectArray(value, field);
    return items.map((item, index) => {
        const where = `${field}[${index}]`;
        const email = asOptionalString(item.email);
        const calUsername = asOptionalString(item.calUsername ?? item.username);
        const calUserId = toOptionalPositiveInt(item.calUserId, `${where}.calUserId`);
        const employeeId = asOptionalString(item.employeeId ?? item.employeeID ?? item.id);

        if (employeeId === null) {
            throw new InputError(`${where} is missing "employeeId", which is the stable key the workflow joins on.`);
        }
        if (email === null && calUsername === null && calUserId === null) {
            throw new InputError(
                `${where} needs at least one match key: "email", "calUsername" or "calUserId". ` +
                    'Without one it can never be attached to a scheduling-system user.',
            );
        }

        return {
            employeeId,
            email: email === null ? null : email.toLowerCase(),
            calUsername: calUsername === null ? null : calUsername.toLowerCase().replace(/^@/, ''),
            calUserId,
            name: asOptionalString(item.name),
            role: asOptionalString(item.role),
            department: asOptionalString(item.department),
            skills: asStringArray(item.skills, [], `${where}.skills`),
            contractedHoursPerWeek: toOptionalNumber(item.contractedHoursPerWeek, `${where}.contractedHoursPerWeek`),
            availability: parseWindowList(item.availability, `${where}.availability`),
        };
    });
}

function parseShiftTypeMetadataList(value: unknown): ShiftTypeMetadata[] {
    const items = asObjectArray(value, 'shiftTypeMetadata');
    return items.map((item, index) => {
        const where = `shiftTypeMetadata[${index}]`;
        const eventTypeId = toOptionalPositiveInt(item.eventTypeId, `${where}.eventTypeId`);
        const eventTypeSlug = asOptionalString(item.eventTypeSlug ?? item.slug);
        if (eventTypeId === null && eventTypeSlug === null) {
            throw new InputError(`${where} needs "eventTypeId" or "eventTypeSlug" so it can be matched to a shift.`);
        }
        return {
            eventTypeId,
            eventTypeSlug: eventTypeSlug === null ? null : eventTypeSlug.toLowerCase(),
            role: asOptionalString(item.role),
            department: asOptionalString(item.department),
            requiredSkills: asStringArray(item.requiredSkills ?? item.skills, [], `${where}.requiredSkills`),
            provenance: 'workforce-metadata',
        };
    });
}

/** Availability windows arrive as `{start, end}`; both must be real timestamps and ordered. */
export function parseWindowList(value: unknown, field: string): { start: string; end: string }[] {
    const items = asObjectArray(value, field);
    const windows: { start: string; end: string }[] = [];
    for (const [index, item] of items.entries()) {
        const where = `${field}[${index}]`;
        const start = Date.parse(String(item.start ?? ''));
        const end = Date.parse(String(item.end ?? ''));
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            throw new InputError(`${where} needs ISO-8601 "start" and "end" timestamps.`);
        }
        if (end <= start) throw new InputError(`${where} has "end" at or before "start".`);
        windows.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
    }
    return windows;
}

/** Accepts an array, a `{employees: []}` wrapper, or a JSON string holding either. */
export function asObjectArray(value: unknown, field: string): Record<string, unknown>[] {
    if (value === undefined || value === null || value === '') return [];

    let candidate: unknown = value;
    if (typeof candidate === 'string') {
        try {
            candidate = JSON.parse(candidate);
        } catch {
            throw new InputError(`"${field}" is a string but not valid JSON.`);
        }
    }
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
        const wrapper = candidate as Record<string, unknown>;
        const inner = wrapper.employees ?? wrapper.items ?? wrapper.data;
        if (Array.isArray(inner)) candidate = inner;
    }
    if (!Array.isArray(candidate)) {
        throw new InputError(`"${field}" must be an array of objects.`);
    }
    return candidate.map((item, index) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            throw new InputError(`"${field}[${index}]" must be an object.`);
        }
        return item as Record<string, unknown>;
    });
}

function toOptionalPositiveInt(value: unknown, field: string): number | null {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new InputError(`"${field}" must be a positive integer, received ${JSON.stringify(value)}.`);
    }
    return parsed;
}

function toOptionalNumber(value: unknown, field: string): number | null {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new InputError(`"${field}" must be a non-negative number, received ${JSON.stringify(value)}.`);
    }
    return parsed;
}
