/**
 * Deduplication.
 *
 * Overlapping pages, several status walks over the same booking, and a worker discovered
 * through both a team membership and an event-type host list all produce the same record twice.
 * Emitting it twice would make the decision layer double-count somebody's hours, so records are
 * collapsed on their stable ID and merged rather than simply dropped - the second copy often
 * carries a field the first one lacked.
 */

import type { NormalizedBundle, Provenance, SchedulingEventRecord, ShiftRecord, WorkerRecord } from '../types.js';

export interface DedupeResult {
    bundle: NormalizedBundle;
    duplicatesDropped: number;
}

export function dedupeBundle(bundle: NormalizedBundle): DedupeResult {
    const workers = collapse(bundle.workers, (worker) => worker.employeeId, mergeWorkers);
    const shifts = collapse(bundle.shifts, (shift) => shift.shiftId, mergeByRecency);
    const events = collapse(bundle.events, (event) => event.eventId, mergeByRecency);

    return {
        bundle: { workers: workers.records, shifts: shifts.records, events: events.records },
        duplicatesDropped: workers.dropped + shifts.dropped + events.dropped,
    };
}

/** Collapses by key, preserving first-seen order so output is stable across runs. */
export function collapse<T>(
    records: T[],
    keyOf: (record: T) => string,
    merge: (existing: T, incoming: T) => T,
): { records: T[]; dropped: number } {
    const byKey = new Map<string, T>();
    let dropped = 0;

    for (const record of records) {
        const key = keyOf(record);
        const existing = byKey.get(key);
        if (existing === undefined) {
            byKey.set(key, record);
            continue;
        }
        byKey.set(key, merge(existing, record));
        dropped += 1;
    }

    return { records: [...byKey.values()], dropped };
}

/** Unions everything that is a set, and fills nulls from whichever copy has a value. */
export function mergeWorkers(existing: WorkerRecord, incoming: WorkerRecord): WorkerRecord {
    return {
        ...existing,
        name: existing.name ?? incoming.name,
        email: existing.email ?? incoming.email,
        role: existing.role ?? incoming.role,
        department: existing.department ?? incoming.department,
        skills: unique([...existing.skills, ...incoming.skills]),
        availability: uniqueWindows([...existing.availability, ...incoming.availability]),
        scheduledShifts: unique([...existing.scheduledShifts, ...incoming.scheduledShifts]).sort(),
        // Hours are computed from shifts; the copy that saw more shifts has the better figure.
        hoursThisWeek: maxOrNull(existing.hoursThisWeek, incoming.hoursThisWeek),
        contractedHoursPerWeek: existing.contractedHoursPerWeek ?? incoming.contractedHoursPerWeek,
        timeZone: existing.timeZone ?? incoming.timeZone,
        sourceIds: {
            calUserId: existing.sourceIds.calUserId ?? incoming.sourceIds.calUserId,
            calUsername: existing.sourceIds.calUsername ?? incoming.sourceIds.calUsername,
        },
        dataSources: unique([...existing.dataSources, ...incoming.dataSources]) as Provenance[],
        synthetic: existing.synthetic || incoming.synthetic,
        fieldSources: { ...incoming.fieldSources, ...existing.fieldSources },
    };
}

/** For time-stamped records the newer copy wins, since the source has revised it. */
export function mergeByRecency<T extends { lastUpdated: string | null }>(existing: T, incoming: T): T {
    const existingMs = existing.lastUpdated === null ? -Infinity : Date.parse(existing.lastUpdated);
    const incomingMs = incoming.lastUpdated === null ? -Infinity : Date.parse(incoming.lastUpdated);
    return incomingMs > existingMs ? incoming : existing;
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

function uniqueWindows<T extends { start: string; end: string; source: Provenance }>(windows: T[]): T[] {
    const seen = new Set<string>();
    const result: T[] = [];
    for (const window of windows) {
        const key = `${window.source}|${window.start}|${window.end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(window);
    }
    return result.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

function maxOrNull(a: number | null, b: number | null): number | null {
    if (a === null) return b;
    if (b === null) return a;
    return Math.max(a, b);
}

export type { SchedulingEventRecord, ShiftRecord, WorkerRecord };
