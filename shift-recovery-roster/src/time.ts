/**
 * Time handling.
 *
 * Rules this Actor follows, without exception:
 *
 * 1. Every timestamp written to the dataset is ISO-8601 with an explicit `Z`, produced by
 *    `Date#toISOString()`, so it is always UTC and always millisecond-precision.
 * 2. A date-only input (`2026-09-26`) means UTC midnight. This is documented in the input
 *    schema and the README; it is the only local-time assumption in the Actor.
 * 3. Cal.com weekly availability is stored as wall-clock time plus an IANA zone. Converting
 *    it to UTC is done through {@link zonedWallClockToUtc}, which resolves the real offset
 *    for that instant, so DST transitions are handled rather than approximated.
 * 4. "This week" means the ISO week (Monday 00:00 UTC through the following Monday 00:00 UTC)
 *    containing the start of the requested window.
 */

import { InputError } from './errors.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Cal.com spells weekdays out in full; index 0 is Sunday to match `Date#getUTCDay()`. */
const WEEKDAY_INDEX: Record<string, number> = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
};

/** Normalizes an arbitrary timestamp-ish value to ISO-8601 UTC, or null when unusable. */
export function toIsoUtc(value: unknown): string | null {
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        const fromEpoch = new Date(value);
        return Number.isFinite(fromEpoch.getTime()) ? fromEpoch.toISOString() : null;
    }
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (trimmed === '') return null;

    // A bare date means UTC midnight. `new Date('2026-09-26')` already parses as UTC, but
    // spelling it out keeps the rule explicit rather than relying on engine behaviour.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateOnly) {
        const ms = Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
        const parsed = new Date(ms);
        if (!Number.isFinite(parsed.getTime())) return null;
        // Guard against rollover such as 2026-02-30 silently becoming March.
        if (parsed.getUTCMonth() !== Number(dateOnly[2]) - 1 || parsed.getUTCDate() !== Number(dateOnly[3])) {
            return null;
        }
        return parsed.toISOString();
    }

    const parsed = new Date(trimmed);
    if (!Number.isFinite(parsed.getTime())) return null;
    return parsed.toISOString();
}

/**
 * Resolves a window boundary from the input.
 *
 * Accepts `now`, `now+<n><unit>`, `now-<n><unit>` (units: m, h, d, w), a bare date, or any
 * ISO-8601 timestamp. `now` is taken from `reference` so runs are reproducible in tests.
 */
export function resolveBoundary(raw: string, fieldName: string, reference: Date = new Date()): string {
    const value = raw.trim();
    if (value === '') {
        throw new InputError(`"${fieldName}" is empty. Provide an ISO-8601 timestamp, a date, "now", or "now+7d".`);
    }

    const relative = /^now\s*(?:([+-])\s*(\d+)\s*([mhdw]))?$/i.exec(value);
    if (relative) {
        if (!relative[1]) return reference.toISOString();
        const sign = relative[1] === '-' ? -1 : 1;
        const amount = Number(relative[2]);
        const unit = (relative[3] ?? 'd').toLowerCase();
        const perUnit: Record<string, number> = {
            m: MS_PER_MINUTE,
            h: MS_PER_HOUR,
            d: MS_PER_DAY,
            w: MS_PER_DAY * 7,
        };
        const step = perUnit[unit];
        if (step === undefined) {
            throw new InputError(`"${fieldName}" uses an unknown unit "${unit}". Use m, h, d or w.`);
        }
        return new Date(reference.getTime() + sign * amount * step).toISOString();
    }

    const iso = toIsoUtc(value);
    if (iso === null) {
        throw new InputError(
            `"${fieldName}" is not a valid date: ${JSON.stringify(raw)}. ` +
                'Use an ISO-8601 timestamp (2026-09-26T18:00:00Z), a date (2026-09-26), "now", or "now+7d".',
        );
    }
    return iso;
}

export interface ResolvedRange {
    start: string;
    end: string;
    startMs: number;
    endMs: number;
    durationDays: number;
}

/** Resolves and sanity-checks the requested window. */
export function resolveRange(
    rawStart: string,
    rawEnd: string,
    maxDays: number,
    reference: Date = new Date(),
): ResolvedRange {
    const start = resolveBoundary(rawStart, 'startTime', reference);
    const end = resolveBoundary(rawEnd, 'endTime', reference);
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);

    if (endMs <= startMs) {
        throw new InputError(`"endTime" (${end}) must be after "startTime" (${start}).`);
    }

    const durationDays = (endMs - startMs) / MS_PER_DAY;
    if (durationDays > maxDays) {
        throw new InputError(
            `The requested window spans ${durationDays.toFixed(1)} days, above the ${maxDays}-day cap. ` +
                'Narrow the window or raise "maxDateRangeDays".',
        );
    }

    return { start, end, startMs, endMs, durationDays };
}

/**
 * Converts a wall-clock time in an IANA zone to a UTC instant.
 *
 * `Intl.DateTimeFormat` can tell us what a given UTC instant looks like in a zone, but not
 * the reverse, so we guess (treat the wall clock as UTC), measure how far off the guess
 * renders in the target zone, and correct. Two passes settle the DST-transition edge cases
 * where the first correction crosses the boundary itself.
 */
export function zonedWallClockToUtc(dateYmd: string, timeHm: string, timeZone: string): string | null {
    const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
    const timeParts = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(timeHm);
    if (!dateParts || !timeParts) return null;

    const year = Number(dateParts[1]);
    const month = Number(dateParts[2]);
    const day = Number(dateParts[3]);
    const hour = Number(timeParts[1]);
    const minute = Number(timeParts[2]);
    const second = Number(timeParts[3] ?? '0');

    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 59) return null;

    const targetUtcAsIfUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    if (!Number.isFinite(targetUtcAsIfUtc)) return null;

    let guess = targetUtcAsIfUtc;
    for (let pass = 0; pass < 2; pass += 1) {
        const rendered = wallClockInZone(new Date(guess), timeZone);
        if (rendered === null) return null;
        const drift = rendered - targetUtcAsIfUtc;
        if (drift === 0) break;
        guess -= drift;
    }

    const result = new Date(guess);
    return Number.isFinite(result.getTime()) ? result.toISOString() : null;
}

/**
 * Renders an instant in a zone and returns that wall clock as if it were UTC, which makes
 * offsets a plain subtraction. Returns null when the zone identifier is not supported.
 */
function wallClockInZone(instant: Date, timeZone: string): number | null {
    let parts: Intl.DateTimeFormatPart[];
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        }).formatToParts(instant);
    } catch {
        return null;
    }

    const lookup: Record<string, number> = {};
    for (const part of parts) {
        if (part.type !== 'literal') lookup[part.type] = Number(part.value);
    }
    const { year, month, day, hour, minute, second } = lookup;
    if (
        year === undefined ||
        month === undefined ||
        day === undefined ||
        hour === undefined ||
        minute === undefined ||
        second === undefined
    ) {
        return null;
    }
    return Date.UTC(year, month - 1, day, hour === 24 ? 0 : hour, minute, second);
}

/** True when the IANA zone identifier is usable on this runtime. */
export function isValidTimeZone(timeZone: string): boolean {
    return wallClockInZone(new Date(0), timeZone) !== null;
}

/** `YYYY-MM-DD` for an instant, in UTC. */
export function utcDateKey(instantMs: number): string {
    return new Date(instantMs).toISOString().slice(0, 10);
}

/** Weekday index (0 = Sunday) for a Cal.com weekday name, or null when unrecognized. */
export function weekdayIndex(name: unknown): number | null {
    if (typeof name !== 'string') return null;
    const index = WEEKDAY_INDEX[name.trim().toLowerCase()];
    return index === undefined ? null : index;
}

/** Start and end of the ISO week (Monday-based, UTC) containing the given instant. */
export function isoWeekBounds(instantMs: number): { start: string; end: string; startMs: number; endMs: number } {
    const day = new Date(instantMs);
    const dayOfWeek = day.getUTCDay(); // 0 = Sunday
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const startMs = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - daysSinceMonday * MS_PER_DAY;
    const endMs = startMs + 7 * MS_PER_DAY;
    return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), startMs, endMs };
}

/** Overlap between two half-open intervals, in milliseconds. Zero when they do not overlap. */
export function overlapMs(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
    return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Whole minutes between two ISO timestamps, rounded to the nearest minute. */
export function durationMinutes(startIso: string, endIso: string): number {
    return Math.round((Date.parse(endIso) - Date.parse(startIso)) / MS_PER_MINUTE);
}

/** Every UTC calendar day touched by the window, as `YYYY-MM-DD`, inclusive of both ends. */
export function utcDaysInRange(startMs: number, endMs: number): string[] {
    const days: string[] = [];
    const first = Date.parse(`${utcDateKey(startMs)}T00:00:00.000Z`);
    for (let cursor = first; cursor <= endMs; cursor += MS_PER_DAY) {
        days.push(utcDateKey(cursor));
    }
    return days;
}

/** Clips a window to the requested range, returning null when there is no overlap. */
export function clipToRange(
    startIso: string,
    endIso: string,
    rangeStartMs: number,
    rangeEndMs: number,
): { start: string; end: string } | null {
    const startMs = Math.max(Date.parse(startIso), rangeStartMs);
    const endMs = Math.min(Date.parse(endIso), rangeEndMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
    return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

/**
 * Removes the busy intervals from a window, returning whatever is left.
 *
 * Used to publish availability that does not overlap work the person is already assigned - a
 * nurse on a 07:00-15:00 shift is free afterwards, not all day and not not at all.
 */
export function subtractIntervals(
    window: { start: string; end: string },
    busy: { start: string; end: string }[],
): { start: string; end: string }[] {
    let free = [{ startMs: Date.parse(window.start), endMs: Date.parse(window.end) }];
    if (!Number.isFinite(free[0]?.startMs) || !Number.isFinite(free[0]?.endMs)) return [];

    for (const interval of busy) {
        const busyStart = Date.parse(interval.start);
        const busyEnd = Date.parse(interval.end);
        if (!Number.isFinite(busyStart) || !Number.isFinite(busyEnd) || busyEnd <= busyStart) continue;

        const next: typeof free = [];
        for (const slot of free) {
            if (busyEnd <= slot.startMs || busyStart >= slot.endMs) {
                next.push(slot);
                continue;
            }
            if (busyStart > slot.startMs) next.push({ startMs: slot.startMs, endMs: busyStart });
            if (busyEnd < slot.endMs) next.push({ startMs: busyEnd, endMs: slot.endMs });
        }
        free = next;
    }

    return free
        .filter((slot) => slot.endMs > slot.startMs)
        .map((slot) => ({ start: new Date(slot.startMs).toISOString(), end: new Date(slot.endMs).toISOString() }));
}

/** Merges overlapping or touching windows so availability is reported once, in order. */
export function mergeWindows<T extends { start: string; end: string }>(windows: T[]): T[] {
    const sorted = [...windows]
        .filter((w) => Number.isFinite(Date.parse(w.start)) && Number.isFinite(Date.parse(w.end)))
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end));

    const merged: T[] = [];
    for (const window of sorted) {
        const previous = merged[merged.length - 1];
        if (previous !== undefined && Date.parse(window.start) <= Date.parse(previous.end)) {
            if (Date.parse(window.end) > Date.parse(previous.end)) previous.end = window.end;
            continue;
        }
        merged.push({ ...window });
    }
    return merged;
}
