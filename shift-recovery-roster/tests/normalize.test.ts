import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { log } from 'apify';

import {
    buildAvailability,
    computeHoursThisWeek,
    derivedEmployeeId,
    eventIdentifier,
    normalize,
    resolveShiftStatus,
} from '../src/pipeline/normalize.js';
import type { ShiftRecord } from '../src/types.js';
import { EMPLOYEE_METADATA, SHIFT_TYPE_METADATA, testInput } from './fixtures/calcom.js';
import { context, person, snapshot, sourceEvent } from './fixtures/snapshot.js';

log.setLevel(log.LEVELS.OFF);

describe('normalize - shifts and events', () => {
    it('derives a shift and a scheduling event from one booking', () => {
        const input = testInput();
        const result = normalize(snapshot(), context(input));

        assert.equal(result.bundle.shifts.length, 1);
        assert.equal(result.bundle.events.length, 1);

        const shift = result.bundle.shifts[0];
        assert.equal(shift?.shiftId, 'SHIFT-CAL-bk-1001');
        assert.equal(shift?.start, '2026-09-26T18:00:00.000Z');
        assert.equal(shift?.end, '2026-09-27T02:00:00.000Z');
        assert.equal(shift?.durationMinutes, 480);
        assert.equal(shift?.status, 'scheduled');
        assert.equal(shift?.coverageStatus, 'covered');
        assert.equal(shift?.lastUpdated, '2026-09-20T10:00:00.000Z');
        assert.equal(shift?.sourceIds.bookingUid, 'bk-1001');
        assert.equal(shift?.sourceIds.teamId, 31);

        const event = result.bundle.events[0];
        assert.equal(event?.eventId, 'EVT-CAL-bk-1001');
        assert.equal(event?.participants.length, 1);
        assert.equal(event?.participants[0]?.participantRole, 'host');
    });

    it('normalizes non-UTC timestamps to UTC', () => {
        const input = testInput();
        const result = normalize(
            snapshot({
                events: [sourceEvent({ start: '2026-09-26T20:00:00+02:00', end: '2026-09-27T04:00:00+02:00' })],
            }),
            context(input),
        );

        assert.equal(result.bundle.shifts[0]?.start, '2026-09-26T18:00:00.000Z');
        assert.equal(result.bundle.shifts[0]?.end, '2026-09-27T02:00:00.000Z');
    });

    it('marks a booking with no host as an uncovered shift rather than dropping it', () => {
        const input = testInput();
        const result = normalize(
            snapshot({ events: [sourceEvent({ uid: 'bk-open', hosts: [], status: 'pending' })] }),
            context(input),
        );

        const shift = result.bundle.shifts[0];
        assert.equal(shift?.assignedEmployeeId, null);
        assert.equal(shift?.coverageStatus, 'uncovered');
        assert.equal(shift?.status, 'pending');
    });

    it('releases the assignment on a cancelled booking', () => {
        const input = testInput();
        const result = normalize(snapshot({ events: [sourceEvent({ status: 'cancelled' })] }), context(input));

        assert.equal(result.bundle.shifts[0]?.status, 'cancelled');
        assert.equal(result.bundle.shifts[0]?.assignedEmployeeId, null);
        assert.equal(result.bundle.shifts[0]?.coverageStatus, 'uncovered');
    });

    it('discards a booking with unparseable timestamps and records why', () => {
        const input = testInput();
        const result = normalize(
            snapshot({ events: [sourceEvent({ uid: 'bk-bad', start: 'yesterday', end: null })] }),
            context(input),
        );

        assert.equal(result.bundle.shifts.length, 0);
        assert.equal(result.discarded.length, 1);
        assert.equal(result.discarded[0]?.identifier, 'bk-bad');
        assert.match(result.discarded[0]?.reason ?? '', /unparseable start\/end/);
    });

    it('discards a booking whose end is before its start', () => {
        const input = testInput();
        const result = normalize(
            snapshot({
                events: [sourceEvent({ start: '2026-09-27T02:00:00Z', end: '2026-09-26T18:00:00Z' })],
            }),
            context(input),
        );

        assert.equal(result.bundle.shifts.length, 0);
        assert.match(result.discarded[0]?.reason ?? '', /at or before start/);
    });

    it('applies date filtering: drops events that do not overlap the window', () => {
        const input = testInput({ startTime: '2026-09-26T00:00:00Z', endTime: '2026-09-27T00:00:00Z' });
        const result = normalize(
            snapshot({
                events: [
                    sourceEvent({ uid: 'inside', start: '2026-09-26T10:00:00Z', end: '2026-09-26T18:00:00Z' }),
                    sourceEvent({ uid: 'straddles', start: '2026-09-25T22:00:00Z', end: '2026-09-26T06:00:00Z' }),
                    sourceEvent({ uid: 'before', start: '2026-09-20T10:00:00Z', end: '2026-09-20T18:00:00Z' }),
                    sourceEvent({ uid: 'after', start: '2026-10-10T10:00:00Z', end: '2026-10-10T18:00:00Z' }),
                ],
            }),
            context(input),
        );

        const kept = result.bundle.shifts.map((shift) => shift.sourceIds.bookingUid).sort();
        assert.deepEqual(kept, ['inside', 'straddles'], 'an overlapping shift still consumes hours in the window');
        assert.equal(result.discarded.length, 2);
        assert.match(result.discarded[0]?.reason ?? '', /outside the requested window/);
    });

    it('omits scheduling events when emitSchedulingEvents is off but keeps the shifts', () => {
        const input = testInput({ emitSchedulingEvents: false });
        const result = normalize(snapshot(), context(input));

        assert.equal(result.bundle.events.length, 0);
        assert.equal(result.bundle.shifts.length, 1);
    });
});

describe('normalize - deterministic identifiers', () => {
    it('produces the same IDs on every run', () => {
        const input = testInput();
        const first = normalize(snapshot(), context(input));
        const second = normalize(snapshot(), context(input));

        assert.equal(first.bundle.shifts[0]?.shiftId, second.bundle.shifts[0]?.shiftId);
        assert.equal(first.bundle.workers[0]?.employeeId, second.bundle.workers[0]?.employeeId);
    });

    it('derives a content hash when the source has no stable ID', () => {
        const withoutIds = sourceEvent({ uid: null, externalId: null });
        const identifier = eventIdentifier(withoutIds);

        assert.match(identifier, /^H[0-9a-z]+$/);
        assert.equal(identifier, eventIdentifier(sourceEvent({ uid: null, externalId: null })), 'stable across calls');
        assert.notEqual(
            identifier,
            eventIdentifier(sourceEvent({ uid: null, externalId: null, start: '2026-09-27T18:00:00.000Z' })),
            'a different shift gets a different ID',
        );
    });

    it('prefers the source UID, then the numeric ID, then the hash', () => {
        assert.equal(eventIdentifier(sourceEvent({ uid: 'bk-9' })), 'bk-9');
        assert.equal(eventIdentifier(sourceEvent({ uid: null, externalId: 77 })), '77');
    });

    it('derives employee IDs from the most stable identifier available', () => {
        assert.equal(derivedEmployeeId(person({ externalId: 502 }), 'CAL'), 'CAL-U502');
        assert.match(derivedEmployeeId(person({ externalId: null }), 'CAL'), /^CAL-E[0-9a-z]+$/);
        assert.match(derivedEmployeeId(person({ externalId: null, email: null }), 'CAL'), /^CAL-N[0-9a-z]+$/);
        // Same person, same ID, every time.
        assert.equal(
            derivedEmployeeId(person({ externalId: null }), 'CAL'),
            derivedEmployeeId(person({ externalId: null }), 'CAL'),
        );
    });
});

describe('normalize - workforce metadata and provenance', () => {
    it('joins metadata by email and labels every field with its origin', () => {
        const input = testInput({ shiftTypeMetadata: SHIFT_TYPE_METADATA });
        const result = normalize(snapshot(), context(input, { employees: EMPLOYEE_METADATA }));

        const worker = result.bundle.workers[0];
        assert.equal(worker?.employeeId, 'E101');
        assert.equal(worker?.name, 'Sarah V');
        assert.equal(worker?.role, 'ICU_NURSE');
        assert.deepEqual(worker?.skills, ['ICU', 'BLS']);
        assert.equal(worker?.contractedHoursPerWeek, 36);

        // Identity comes from the scheduling system; the workforce layer comes from the roster.
        assert.equal(worker?.fieldSources.name, 'cal.com');
        assert.equal(worker?.fieldSources.email, 'cal.com');
        assert.equal(worker?.fieldSources.role, 'workforce-metadata');
        assert.equal(worker?.fieldSources.department, 'workforce-metadata');
        assert.equal(worker?.fieldSources.skills, 'workforce-metadata');
        assert.deepEqual(worker?.dataSources, ['cal.com', 'workforce-metadata']);
        assert.equal(worker?.synthetic, false);
    });

    it('never attributes a metadata-only field to Cal.com', () => {
        const input = testInput();
        const result = normalize(snapshot(), context(input, { employees: EMPLOYEE_METADATA }));

        const worker = result.bundle.workers[0];
        for (const field of ['role', 'department', 'skills', 'contractedHoursPerWeek']) {
            assert.notEqual(worker?.fieldSources[field], 'cal.com', `${field} must not claim to come from Cal.com`);
        }
    });

    it('joins metadata by username when no email matches', () => {
        const input = testInput();
        const result = normalize(
            snapshot({
                people: [person({ email: null, key: 'username:jonas-b', username: 'jonas-b', externalId: 503 })],
                events: [],
            }),
            context(input, { employees: EMPLOYEE_METADATA }),
        );

        assert.equal(result.bundle.workers[0]?.employeeId, 'E102');
        assert.equal(result.bundle.workers[0]?.role, 'ICU_NURSE');
    });

    it('keeps a worker with no metadata, with null workforce fields and a warning', () => {
        const input = testInput();
        const result = normalize(snapshot(), context(input, { employees: [] }));

        const worker = result.bundle.workers[0];
        assert.equal(worker?.role, null);
        assert.equal(worker?.department, null);
        assert.deepEqual(worker?.skills, []);
        assert.equal(worker?.contractedHoursPerWeek, null);
        assert.equal(worker?.employeeId, 'CAL-U502', 'a deterministic fallback ID is still assigned');
        assert.equal(result.workersWithoutMetadata, 1);
        assert.match(result.warnings.join(' '), /no workforce metadata/);
    });

    it('flags a synthesized profile as synthetic and demo-sourced', () => {
        const input = testInput();
        const result = normalize(snapshot(), context(input, { employees: [], synthesize: true }));

        const worker = result.bundle.workers[0];
        assert.match(worker?.employeeId ?? '', /^DEMO-\d{5}$/);
        assert.equal(worker?.synthetic, true);
        assert.equal(worker?.fieldSources.role, 'demo-workforce-metadata');
        // The real name from Cal.com is preserved rather than replaced by a fake one.
        assert.equal(worker?.name, 'Sarah V');
        assert.equal(worker?.fieldSources.name, 'cal.com');
    });

    it('warns when a roster entry matches nobody in the scheduling system', () => {
        const input = testInput();
        const result = normalize(
            snapshot({
                people: [
                    person({
                        email: 'someone-else@hospital.example',
                        key: 'email:someone-else@hospital.example',
                        externalId: 999,
                        username: 'other',
                    }),
                ],
            }),
            context(input, { employees: EMPLOYEE_METADATA }),
        );

        assert.match(result.warnings.join(' '), /matched no user in the scheduling system/);
        assert.match(result.warnings.join(' '), /E101/);
    });
});

describe('normalize - shift requirements', () => {
    it('resolves role, department and skills from the shift type mapping', () => {
        const input = testInput({ shiftTypeMetadata: SHIFT_TYPE_METADATA });
        const result = normalize(snapshot(), context(input, { employees: EMPLOYEE_METADATA }));

        const shift = result.bundle.shifts[0];
        assert.equal(shift?.role, 'ICU_NURSE');
        assert.equal(shift?.department, 'ICU');
        assert.deepEqual(shift?.requiredSkills, ['ICU', 'BLS']);
        assert.equal(shift?.fieldSources.role, 'workforce-metadata');
    });

    it('matches a shift type by numeric event type ID as well as by slug', () => {
        const input = testInput({ shiftTypeMetadata: SHIFT_TYPE_METADATA });
        const result = normalize(
            snapshot({ events: [sourceEvent({ eventTypeId: 901, eventTypeSlug: null })] }),
            context(input),
        );

        assert.deepEqual(result.bundle.shifts[0]?.requiredSkills, ['ICU']);
    });

    it('falls back to the assignee profile and says the value was inferred', () => {
        const input = testInput();
        const result = normalize(snapshot(), context(input, { employees: EMPLOYEE_METADATA }));

        const shift = result.bundle.shifts[0];
        assert.equal(shift?.role, 'ICU_NURSE');
        assert.equal(shift?.fieldSources.role, 'derived:assigned-worker');
        assert.deepEqual(shift?.requiredSkills, [], 'requirements are never invented from a worker profile');
    });

    it('leaves requirements null when nothing can supply them', () => {
        const input = testInput();
        const result = normalize(snapshot({ events: [sourceEvent({ hosts: [] })] }), context(input));

        assert.equal(result.bundle.shifts[0]?.role, null);
        assert.equal(result.bundle.shifts[0]?.department, null);
        assert.deepEqual(result.bundle.shifts[0]?.requiredSkills, []);
    });
});

describe('normalize - availability and hours', () => {
    it('links scheduled shifts to the worker and totals the ISO week', () => {
        const input = testInput({ startTime: '2026-09-21T00:00:00Z', endTime: '2026-09-28T00:00:00Z' });
        const result = normalize(
            snapshot({
                events: [
                    sourceEvent({ uid: 'bk-a', start: '2026-09-22T07:00:00Z', end: '2026-09-22T15:00:00Z' }),
                    sourceEvent({ uid: 'bk-b', start: '2026-09-23T07:00:00Z', end: '2026-09-23T15:00:00Z' }),
                ],
            }),
            context(input, { employees: EMPLOYEE_METADATA }),
        );

        const worker = result.bundle.workers[0];
        assert.deepEqual(worker?.scheduledShifts, ['SHIFT-CAL-bk-a', 'SHIFT-CAL-bk-b']);
        assert.equal(worker?.hoursThisWeek, 16);
        assert.equal(worker?.fieldSources.hoursThisWeek, 'derived:scheduled-shifts-in-window');
    });

    it('keeps source availability and roster availability separately attributed', () => {
        const input = testInput();
        const result = normalize(
            snapshot({
                availability: [
                    {
                        personKey: 'email:sarah@hospital.example',
                        timeZone: 'Europe/Amsterdam',
                        windows: [{ start: '2026-09-29T07:00:00.000Z', end: '2026-09-29T15:00:00.000Z' }],
                    },
                ],
            }),
            context(input, {
                employees: [
                    {
                        ...EMPLOYEE_METADATA[0],
                        availability: [{ start: '2026-09-30T06:00:00Z', end: '2026-09-30T14:00:00Z' }],
                    },
                ],
            }),
        );

        const availability = result.bundle.workers[0]?.availability ?? [];
        assert.equal(availability.length, 2);
        assert.equal(availability[0]?.source, 'cal.com');
        assert.equal(availability[1]?.source, 'workforce-metadata');
    });

    it('clips availability to the requested window', () => {
        const merged = buildAvailability(
            [{ start: '2026-09-25T20:00:00.000Z', end: '2026-09-26T08:00:00.000Z' }],
            'cal.com',
            [],
            null,
            Date.parse('2026-09-26T00:00:00Z'),
            Date.parse('2026-09-27T00:00:00Z'),
        );

        assert.deepEqual(merged, [
            { start: '2026-09-26T00:00:00.000Z', end: '2026-09-26T08:00:00.000Z', source: 'cal.com' },
        ]);
    });

    it('excludes cancelled shifts from the weekly hours', () => {
        const shifts = [
            { start: '2026-09-22T07:00:00.000Z', end: '2026-09-22T15:00:00.000Z', status: 'scheduled' },
            { start: '2026-09-23T07:00:00.000Z', end: '2026-09-23T15:00:00.000Z', status: 'cancelled' },
        ] as ShiftRecord[];

        const hours = computeHoursThisWeek(
            shifts,
            Date.parse('2026-09-21T00:00:00Z'),
            Date.parse('2026-09-28T00:00:00Z'),
        );
        assert.equal(hours, 8);
    });

    it('counts only the part of a shift that falls inside the week', () => {
        const shifts = [
            { start: '2026-09-27T20:00:00.000Z', end: '2026-09-28T04:00:00.000Z', status: 'scheduled' },
        ] as ShiftRecord[];

        const hours = computeHoursThisWeek(
            shifts,
            Date.parse('2026-09-21T00:00:00Z'),
            Date.parse('2026-09-28T00:00:00Z'),
        );
        assert.equal(hours, 4);
    });
});

describe('resolveShiftStatus', () => {
    const now = Date.parse('2026-09-26T09:00:00Z');

    it('maps Cal.com statuses onto the contract', () => {
        assert.equal(resolveShiftStatus('accepted', Date.parse('2026-09-27T00:00:00Z'), now), 'scheduled');
        assert.equal(resolveShiftStatus('pending', Date.parse('2026-09-27T00:00:00Z'), now), 'pending');
        assert.equal(resolveShiftStatus('awaiting_host', Date.parse('2026-09-27T00:00:00Z'), now), 'pending');
        assert.equal(resolveShiftStatus('cancelled', Date.parse('2026-09-27T00:00:00Z'), now), 'cancelled');
        assert.equal(resolveShiftStatus('rejected', Date.parse('2026-09-27T00:00:00Z'), now), 'cancelled');
    });

    it('reports an accepted shift that has already ended as completed', () => {
        assert.equal(resolveShiftStatus('accepted', Date.parse('2026-09-25T00:00:00Z'), now), 'completed');
    });

    it('does not guess at an unrecognized status', () => {
        assert.equal(resolveShiftStatus('teleported', Date.parse('2026-09-27T00:00:00Z'), now), 'unknown');
    });
});
