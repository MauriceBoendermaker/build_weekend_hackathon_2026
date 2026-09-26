/**
 * Builders for source-shaped snapshots, so pipeline tests can describe exactly the situation
 * under test without going through an HTTP double.
 */

import { MetadataIndex, ShiftTypeIndex, type MetadataEntry } from '../../src/metadata/loader.js';
import type { NormalizeContext } from '../../src/pipeline/normalize.js';
import { emptyStats, type RawSnapshot, type SourceEvent, type SourcePerson } from '../../src/sources/source.js';
import { parseEmployeeMetadataList, type ResolvedInput } from '../../src/input.js';
import type { SourceSystem } from '../../src/types.js';

export const RETRIEVED_AT = '2026-09-26T09:00:00.000Z';

export function person(overrides: Partial<SourcePerson> = {}): SourcePerson {
    const email = overrides.email ?? 'sarah@hospital.example';
    return {
        key: overrides.key ?? (email === null ? 'unknown' : `email:${email}`),
        externalId: 502,
        username: 'sarah-v',
        name: 'Sarah V',
        email,
        timeZone: 'Europe/Amsterdam',
        discoveredVia: 'team:31',
        ...overrides,
    };
}

export function sourceEvent(overrides: Partial<SourceEvent> = {}): SourceEvent {
    return {
        externalId: 1001,
        uid: 'bk-1001',
        title: 'ICU night shift',
        start: '2026-09-26T18:00:00.000Z',
        end: '2026-09-27T02:00:00.000Z',
        durationMinutes: 480,
        status: 'accepted',
        eventTypeId: 900,
        eventTypeSlug: 'icu-night-shift',
        teamId: 31,
        hosts: [
            {
                key: 'email:sarah@hospital.example',
                externalId: 502,
                username: 'sarah-v',
                name: 'Sarah V',
                email: 'sarah@hospital.example',
                timeZone: 'Europe/Amsterdam',
                absent: false,
            },
        ],
        attendees: [],
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
        ...overrides,
    };
}

export function snapshot(overrides: Partial<RawSnapshot> = {}): RawSnapshot {
    const sourceSystem: SourceSystem = overrides.sourceSystem ?? 'cal.com';
    return {
        sourceSystem,
        retrievedAt: RETRIEVED_AT,
        people: [person()],
        events: [sourceEvent()],
        availability: [],
        shiftTypes: [],
        stats: emptyStats(),
        warnings: [],
        complete: true,
        ...overrides,
    };
}

/** Builds a normalize context with the given roster, as if it came from the run input. */
export function context(
    input: ResolvedInput,
    options: { employees?: Record<string, unknown>[]; synthesize?: boolean } = {},
): NormalizeContext {
    const entries: MetadataEntry[] = parseEmployeeMetadataList(options.employees ?? [], 'employeeMetadata').map(
        (employee) => ({ employee, origin: 'input-inline', provenance: 'workforce-metadata' }),
    );
    return {
        input,
        metadata: new MetadataIndex(entries, options.synthesize ?? false),
        shiftTypes: new ShiftTypeIndex(input.shiftTypeMetadata),
        retrievedAt: RETRIEVED_AT,
    };
}
