import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { log } from 'apify';

import { collapse, dedupeBundle, mergeByRecency, mergeWorkers } from '../src/pipeline/dedupe.js';
import { normalize } from '../src/pipeline/normalize.js';
import { isIsoUtc, looksLikeEmail, validateBundle } from '../src/pipeline/validate.js';
import type { NormalizedBundle, SchedulingEventRecord, ShiftRecord, WorkerRecord } from '../src/types.js';
import { testInput } from './fixtures/calcom.js';
import { context, person, snapshot, sourceEvent } from './fixtures/snapshot.js';

log.setLevel(log.LEVELS.OFF);

function worker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
    return {
        recordType: 'worker',
        employeeId: 'E101',
        name: 'Sarah V',
        email: 'sarah@hospital.example',
        role: 'ICU_NURSE',
        department: 'ICU',
        skills: ['ICU'],
        availability: [],
        scheduledShifts: [],
        hoursThisWeek: 8,
        contractedHoursPerWeek: 36,
        timeZone: 'Europe/Amsterdam',
        sourceSystem: 'cal.com',
        sourceIds: { calUserId: 502, calUsername: 'sarah-v' },
        dataSources: ['cal.com'],
        source: 'cal.com',
        synthetic: false,
        retrievedAt: '2026-09-26T09:00:00.000Z',
        lastUpdated: null,
        fieldSources: { employeeId: 'workforce-metadata' },
        ...overrides,
    };
}

function shift(overrides: Partial<ShiftRecord> = {}): ShiftRecord {
    return {
        recordType: 'shift',
        shiftId: 'SHIFT-CAL-bk-1001',
        start: '2026-09-26T18:00:00.000Z',
        end: '2026-09-27T02:00:00.000Z',
        durationMinutes: 480,
        role: 'ICU_NURSE',
        department: 'ICU',
        requiredSkills: ['ICU'],
        assignedEmployeeId: 'E101',
        assignedWorkerEmail: 'sarah@hospital.example',
        status: 'scheduled',
        coverageStatus: 'covered',
        sourceSystem: 'cal.com',
        sourceIds: {
            bookingId: 1001,
            bookingUid: 'bk-1001',
            eventTypeId: 900,
            eventTypeSlug: 'icu-night-shift',
            teamId: 31,
        },
        source: 'cal.com',
        synthetic: false,
        retrievedAt: '2026-09-26T09:00:00.000Z',
        lastUpdated: '2026-09-20T10:00:00.000Z',
        fieldSources: {},
        ...overrides,
    };
}

function bundle(overrides: Partial<NormalizedBundle> = {}): NormalizedBundle {
    return { workers: [], shifts: [], events: [], ...overrides };
}

describe('dedupe - duplicate records from overlapping pages', () => {
    it('collapses the same worker seen twice and unions the set-valued fields', () => {
        const result = dedupeBundle(
            bundle({
                workers: [
                    worker({ skills: ['ICU'], scheduledShifts: ['SHIFT-A'], hoursThisWeek: 8 }),
                    worker({ skills: ['BLS'], scheduledShifts: ['SHIFT-B'], hoursThisWeek: 16, role: null }),
                ],
            }),
        );

        assert.equal(result.bundle.workers.length, 1);
        assert.equal(result.duplicatesDropped, 1);

        const merged = result.bundle.workers[0];
        assert.deepEqual(merged?.skills, ['ICU', 'BLS']);
        assert.deepEqual(merged?.scheduledShifts, ['SHIFT-A', 'SHIFT-B']);
        assert.equal(merged?.hoursThisWeek, 16, 'the copy that saw more shifts wins');
        assert.equal(merged?.role, 'ICU_NURSE', 'a real value is never replaced by null');
    });

    it('collapses the same shift and keeps the more recently updated copy', () => {
        const result = dedupeBundle(
            bundle({
                shifts: [
                    shift({ status: 'pending', lastUpdated: '2026-09-20T10:00:00.000Z' }),
                    shift({ status: 'cancelled', lastUpdated: '2026-09-25T10:00:00.000Z' }),
                ],
            }),
        );

        assert.equal(result.bundle.shifts.length, 1);
        assert.equal(result.bundle.shifts[0]?.status, 'cancelled');
        assert.equal(result.duplicatesDropped, 1);
    });

    it('is a no-op when there are no duplicates', () => {
        const result = dedupeBundle(
            bundle({ workers: [worker({ employeeId: 'E101' }), worker({ employeeId: 'E102' })] }),
        );

        assert.equal(result.bundle.workers.length, 2);
        assert.equal(result.duplicatesDropped, 0);
    });

    it('preserves first-seen order so output is stable across runs', () => {
        const result = dedupeBundle(
            bundle({
                workers: [
                    worker({ employeeId: 'E103' }),
                    worker({ employeeId: 'E101' }),
                    worker({ employeeId: 'E103' }),
                ],
            }),
        );

        assert.deepEqual(
            result.bundle.workers.map((item) => item.employeeId),
            ['E103', 'E101'],
        );
    });

    it('propagates the synthetic flag when either copy is synthetic', () => {
        const merged = mergeWorkers(worker({ synthetic: false }), worker({ synthetic: true }));
        assert.equal(merged.synthetic, true);
    });

    it('unions availability windows without losing their provenance', () => {
        const merged = mergeWorkers(
            worker({
                availability: [
                    { start: '2026-09-29T07:00:00.000Z', end: '2026-09-29T15:00:00.000Z', source: 'cal.com' },
                ],
            }),
            worker({
                availability: [
                    { start: '2026-09-29T07:00:00.000Z', end: '2026-09-29T15:00:00.000Z', source: 'cal.com' },
                    {
                        start: '2026-09-30T06:00:00.000Z',
                        end: '2026-09-30T14:00:00.000Z',
                        source: 'workforce-metadata',
                    },
                ],
            }),
        );

        assert.equal(merged.availability.length, 2, 'the identical window is not duplicated');
        assert.equal(merged.availability[1]?.source, 'workforce-metadata');
    });

    it('keeps the existing record when neither copy has an update timestamp', () => {
        const first = { lastUpdated: null, id: 'a' };
        const second = { lastUpdated: null, id: 'b' };
        assert.equal(mergeByRecency(first, second).id, 'a');
    });

    it('collapses arbitrary records by a supplied key', () => {
        const result = collapse(
            [
                { k: 'x', v: 1 },
                { k: 'x', v: 2 },
                { k: 'y', v: 3 },
            ],
            (item) => item.k,
            (a) => a,
        );
        assert.equal(result.records.length, 2);
        assert.equal(result.dropped, 1);
    });
});

describe('dedupe - end to end through normalization', () => {
    it('removes a booking that two status walks both returned', () => {
        const input = testInput();
        // The same booking, returned twice, exactly as two paginated walks would produce it.
        const normalized = normalize(snapshot({ events: [sourceEvent(), sourceEvent()] }), context(input));
        const result = dedupeBundle(normalized.bundle);

        assert.equal(result.bundle.shifts.length, 1);
        assert.equal(result.bundle.events.length, 1);
        assert.equal(result.duplicatesDropped, 2, 'one duplicate shift and one duplicate event');
    });

    it('unifies a worker discovered under two different source keys', () => {
        const input = testInput();
        const normalized = normalize(
            snapshot({
                people: [
                    person({ key: 'email:sarah@hospital.example' }),
                    person({ key: 'username:sarah-v', email: null, name: null }),
                ],
                events: [],
            }),
            context(input),
        );
        const result = dedupeBundle(normalized.bundle);

        // Both resolve to the same deterministic employee ID, so they collapse into one worker.
        assert.equal(result.bundle.workers.length, 1);
        assert.equal(result.bundle.workers[0]?.email, 'sarah@hospital.example');
        assert.equal(result.bundle.workers[0]?.name, 'Sarah V');
    });
});

describe('validate - rejects records that would mislead the decision layer', () => {
    it('accepts a complete bundle untouched', () => {
        const result = validateBundle(bundle({ workers: [worker()], shifts: [shift()] }));

        assert.equal(result.bundle.workers.length, 1);
        assert.equal(result.bundle.shifts.length, 1);
        assert.deepEqual(result.rejected, []);
        assert.deepEqual(result.repaired, []);
    });

    it('rejects a worker with no employee ID', () => {
        const result = validateBundle(bundle({ workers: [worker({ employeeId: '' })] }));

        assert.equal(result.bundle.workers.length, 0);
        assert.match(result.rejected[0]?.reason ?? '', /employeeId is missing/);
    });

    it('rejects a worker who can be neither named nor contacted', () => {
        const result = validateBundle(bundle({ workers: [worker({ name: null, email: null })] }));

        assert.equal(result.bundle.workers.length, 0);
        assert.match(result.rejected[0]?.reason ?? '', /cannot be contacted/);
    });

    it('rejects a malformed email address', () => {
        const result = validateBundle(bundle({ workers: [worker({ email: 'not-an-email' })] }));

        assert.equal(result.bundle.workers.length, 0);
        assert.match(result.rejected[0]?.reason ?? '', /not a valid address/);
    });

    it('rejects a shift with a broken time range', () => {
        const result = validateBundle(
            bundle({
                shifts: [
                    shift({ shiftId: 'S1', start: '2026-09-27T02:00:00.000Z', end: '2026-09-26T18:00:00.000Z' }),
                    shift({ shiftId: 'S2', start: 'yesterday' }),
                    shift({ shiftId: 'S3', durationMinutes: 0 }),
                ],
            }),
        );

        assert.equal(result.bundle.shifts.length, 0);
        assert.equal(result.rejected.length, 3);
    });

    it('rejects a timestamp that is not ISO-8601 UTC', () => {
        const result = validateBundle(bundle({ shifts: [shift({ start: '2026-09-26T20:00:00+02:00' })] }));

        assert.equal(result.bundle.shifts.length, 0);
        assert.match(result.rejected[0]?.reason ?? '', /not an ISO-8601 UTC timestamp/);
    });

    it('rejects a shift that claims coverage with nobody assigned', () => {
        const result = validateBundle(
            bundle({ shifts: [shift({ coverageStatus: 'covered', assignedEmployeeId: null })] }),
        );

        assert.equal(result.bundle.shifts.length, 0);
        assert.match(result.rejected[0]?.reason ?? '', /no employee is assigned/);
    });

    it('rejects a scheduling event with no ID', () => {
        const event = {
            recordType: 'schedulingEvent',
            eventId: '',
            name: null,
            start: '2026-09-26T18:00:00.000Z',
            end: '2026-09-27T02:00:00.000Z',
            durationMinutes: 480,
            status: 'accepted',
            participants: [],
            primaryWorkerEmployeeId: null,
            sourceSystem: 'cal.com',
            sourceIds: { bookingId: null, bookingUid: null, eventTypeId: null, eventTypeSlug: null },
            source: 'cal.com',
            synthetic: false,
            retrievedAt: '2026-09-26T09:00:00.000Z',
            lastUpdated: null,
            fieldSources: {},
        } as SchedulingEventRecord;

        const result = validateBundle(bundle({ events: [event] }));
        assert.equal(result.bundle.events.length, 0);
    });
});

describe('validate - repairs rather than discards partial data', () => {
    it('keeps a worker with no role, department or skills', () => {
        const result = validateBundle(
            bundle({ workers: [worker({ role: null, department: null, skills: [], contractedHoursPerWeek: null })] }),
        );

        assert.equal(result.bundle.workers.length, 1, 'a worker without a profile is still a real worker');
        assert.deepEqual(result.rejected, []);
    });

    it('drops only the broken availability window and keeps the worker', () => {
        const result = validateBundle(
            bundle({
                workers: [
                    worker({
                        availability: [
                            { start: '2026-09-29T07:00:00.000Z', end: '2026-09-29T15:00:00.000Z', source: 'cal.com' },
                            { start: 'nope', end: 'also nope', source: 'cal.com' },
                        ],
                    }),
                ],
            }),
        );

        assert.equal(result.bundle.workers.length, 1);
        assert.equal(result.bundle.workers[0]?.availability.length, 1);
        assert.match(result.repaired[0]?.reason ?? '', /malformed availability window/);
    });

    it('nulls an impossible hour count instead of dropping the worker', () => {
        const result = validateBundle(bundle({ workers: [worker({ hoursThisWeek: -5 })] }));

        assert.equal(result.bundle.workers.length, 1);
        assert.equal(result.bundle.workers[0]?.hoursThisWeek, null);
        assert.match(result.repaired[0]?.reason ?? '', /hoursThisWeek/);
    });
});

describe('validate - helpers', () => {
    it('recognizes only millisecond-precision UTC timestamps', () => {
        assert.equal(isIsoUtc('2026-09-26T18:00:00.000Z'), true);
        assert.equal(isIsoUtc('2026-09-26T18:00:00Z'), false);
        assert.equal(isIsoUtc('2026-09-26'), false);
        assert.equal(isIsoUtc(42), false);
    });

    it('accepts unusual but valid addresses and rejects obvious rubbish', () => {
        assert.equal(looksLikeEmail('a.b+tag@sub.hospital.example'), true);
        assert.equal(looksLikeEmail('nurse@hospital.example'), true);
        assert.equal(looksLikeEmail('nurse@localhost'), false);
        assert.equal(looksLikeEmail('nurse at hospital'), false);
        assert.equal(looksLikeEmail(''), false);
    });
});
