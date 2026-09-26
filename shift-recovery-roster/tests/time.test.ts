import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InputError } from '../src/errors.js';
import {
    clipToRange,
    durationMinutes,
    isoWeekBounds,
    isValidTimeZone,
    mergeWindows,
    overlapMs,
    resolveBoundary,
    resolveRange,
    subtractIntervals,
    toIsoUtc,
    utcDaysInRange,
    weekdayIndex,
    zonedWallClockToUtc,
} from '../src/time.js';

const NOW = new Date('2026-09-26T09:00:00.000Z');

describe('toIsoUtc', () => {
    it('normalizes offset timestamps to UTC', () => {
        assert.equal(toIsoUtc('2026-09-26T20:00:00+02:00'), '2026-09-26T18:00:00.000Z');
    });

    it('reads a bare date as UTC midnight', () => {
        assert.equal(toIsoUtc('2026-09-26'), '2026-09-26T00:00:00.000Z');
    });

    it('rejects invalid dates instead of rolling them over', () => {
        assert.equal(toIsoUtc('2026-02-30'), null);
        assert.equal(toIsoUtc('not-a-date'), null);
        assert.equal(toIsoUtc(''), null);
        assert.equal(toIsoUtc(undefined), null);
        assert.equal(toIsoUtc(null), null);
        assert.equal(toIsoUtc(Number.NaN), null);
        assert.equal(toIsoUtc(new Date('nope')), null);
    });

    it('accepts epoch milliseconds and Date objects', () => {
        assert.equal(toIsoUtc(1790000000000), new Date(1790000000000).toISOString());
        assert.equal(toIsoUtc(new Date('2026-09-26T18:00:00Z')), '2026-09-26T18:00:00.000Z');
    });
});

describe('resolveBoundary', () => {
    it('resolves "now" against the supplied reference', () => {
        assert.equal(resolveBoundary('now', 'startTime', NOW), '2026-09-26T09:00:00.000Z');
    });

    it('resolves relative offsets in minutes, hours, days and weeks', () => {
        assert.equal(resolveBoundary('now+7d', 'endTime', NOW), '2026-10-03T09:00:00.000Z');
        assert.equal(resolveBoundary('now-1d', 'startTime', NOW), '2026-09-25T09:00:00.000Z');
        assert.equal(resolveBoundary('now+2h', 'endTime', NOW), '2026-09-26T11:00:00.000Z');
        assert.equal(resolveBoundary('now+30m', 'endTime', NOW), '2026-09-26T09:30:00.000Z');
        assert.equal(resolveBoundary('now+1w', 'endTime', NOW), '2026-10-03T09:00:00.000Z');
    });

    it('rejects an unparseable boundary with an actionable message', () => {
        assert.throws(
            () => resolveBoundary('next tuesday', 'startTime', NOW),
            (err: unknown) => {
                assert.ok(err instanceof InputError);
                assert.match(err.message, /not a valid date/);
                assert.match(err.message, /now\+7d/);
                return true;
            },
        );
    });

    it('rejects an unknown relative unit', () => {
        assert.throws(() => resolveBoundary('now+3y', 'endTime', NOW), InputError);
    });
});

describe('resolveRange', () => {
    it('resolves both boundaries and reports the span', () => {
        const range = resolveRange('now', 'now+7d', 90, NOW);
        assert.equal(range.start, '2026-09-26T09:00:00.000Z');
        assert.equal(range.end, '2026-10-03T09:00:00.000Z');
        assert.equal(range.durationDays, 7);
    });

    it('rejects an end at or before the start', () => {
        assert.throws(() => resolveRange('now', 'now', 90, NOW), InputError);
        assert.throws(() => resolveRange('now', 'now-1d', 90, NOW), InputError);
    });

    it('rejects a window longer than the configured cap', () => {
        assert.throws(() => resolveRange('now', 'now+30d', 7, NOW), /above the 7-day cap/);
    });
});

describe('zonedWallClockToUtc', () => {
    it('converts summer-time wall clock using the real offset', () => {
        // Amsterdam is CEST (UTC+2) on 26 September 2026.
        assert.equal(zonedWallClockToUtc('2026-09-26', '09:00', 'Europe/Amsterdam'), '2026-09-26T07:00:00.000Z');
    });

    it('converts winter-time wall clock using the real offset', () => {
        // Amsterdam is CET (UTC+1) in December.
        assert.equal(zonedWallClockToUtc('2026-12-15', '09:00', 'Europe/Amsterdam'), '2026-12-15T08:00:00.000Z');
    });

    it('handles the day the clocks change', () => {
        // CEST -> CET happens on 25 October 2026 at 03:00 local. 09:00 that morning is UTC+1.
        assert.equal(zonedWallClockToUtc('2026-10-25', '09:00', 'Europe/Amsterdam'), '2026-10-25T08:00:00.000Z');
        // The evening before the change is still UTC+2.
        assert.equal(zonedWallClockToUtc('2026-10-24', '22:00', 'Europe/Amsterdam'), '2026-10-24T20:00:00.000Z');
    });

    it('treats UTC as a no-op', () => {
        assert.equal(zonedWallClockToUtc('2026-09-26', '23:00', 'UTC'), '2026-09-26T23:00:00.000Z');
    });

    it('returns null for malformed input or an unknown zone', () => {
        assert.equal(zonedWallClockToUtc('2026-09', '09:00', 'UTC'), null);
        assert.equal(zonedWallClockToUtc('2026-09-26', 'morning', 'UTC'), null);
        assert.equal(zonedWallClockToUtc('2026-09-26', '09:00', 'Mars/Olympus'), null);
    });
});

describe('isValidTimeZone', () => {
    it('accepts real zones and rejects invented ones', () => {
        assert.equal(isValidTimeZone('Europe/Amsterdam'), true);
        assert.equal(isValidTimeZone('UTC'), true);
        assert.equal(isValidTimeZone('Nowhere/Fake'), false);
    });
});

describe('isoWeekBounds', () => {
    it('starts the week on Monday, in UTC', () => {
        // 2026-09-26 is a Saturday; its ISO week starts Monday 2026-09-21.
        const week = isoWeekBounds(Date.parse('2026-09-26T09:00:00Z'));
        assert.equal(week.start, '2026-09-21T00:00:00.000Z');
        assert.equal(week.end, '2026-09-28T00:00:00.000Z');
    });

    it('treats Sunday as the last day of the week, not the first', () => {
        const week = isoWeekBounds(Date.parse('2026-09-27T23:59:00Z'));
        assert.equal(week.start, '2026-09-21T00:00:00.000Z');
    });

    it('is stable for a Monday', () => {
        const week = isoWeekBounds(Date.parse('2026-09-21T00:00:00Z'));
        assert.equal(week.start, '2026-09-21T00:00:00.000Z');
    });
});

describe('interval helpers', () => {
    it('computes overlap and returns zero when disjoint', () => {
        assert.equal(overlapMs(0, 10, 5, 20), 5);
        assert.equal(overlapMs(0, 10, 10, 20), 0);
        assert.equal(overlapMs(0, 10, 20, 30), 0);
    });

    it('computes duration in whole minutes', () => {
        assert.equal(durationMinutes('2026-09-26T18:00:00.000Z', '2026-09-27T02:00:00.000Z'), 480);
    });

    it('clips to the range and drops non-overlapping windows', () => {
        const rangeStart = Date.parse('2026-09-26T00:00:00Z');
        const rangeEnd = Date.parse('2026-09-27T00:00:00Z');
        assert.deepEqual(clipToRange('2026-09-25T20:00:00Z', '2026-09-26T04:00:00Z', rangeStart, rangeEnd), {
            start: '2026-09-26T00:00:00.000Z',
            end: '2026-09-26T04:00:00.000Z',
        });
        assert.equal(clipToRange('2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z', rangeStart, rangeEnd), null);
    });

    it('lists every UTC day the range touches', () => {
        const days = utcDaysInRange(Date.parse('2026-09-26T23:00:00Z'), Date.parse('2026-09-28T01:00:00Z'));
        assert.deepEqual(days, ['2026-09-26', '2026-09-27', '2026-09-28']);
    });

    it('merges overlapping and touching windows', () => {
        const merged = mergeWindows([
            { start: '2026-09-26T10:00:00.000Z', end: '2026-09-26T12:00:00.000Z' },
            { start: '2026-09-26T11:00:00.000Z', end: '2026-09-26T13:00:00.000Z' },
            { start: '2026-09-26T13:00:00.000Z', end: '2026-09-26T14:00:00.000Z' },
            { start: '2026-09-26T20:00:00.000Z', end: '2026-09-26T21:00:00.000Z' },
        ]);
        assert.deepEqual(merged, [
            { start: '2026-09-26T10:00:00.000Z', end: '2026-09-26T14:00:00.000Z' },
            { start: '2026-09-26T20:00:00.000Z', end: '2026-09-26T21:00:00.000Z' },
        ]);
    });

    it('drops windows with unparseable bounds when merging', () => {
        assert.deepEqual(mergeWindows([{ start: 'nope', end: 'also nope' }]), []);
    });
});

describe('subtractIntervals', () => {
    const day = { start: '2026-09-26T06:00:00.000Z', end: '2026-09-26T22:00:00.000Z' };

    it('splits a window around a shift in the middle', () => {
        assert.deepEqual(
            subtractIntervals(day, [{ start: '2026-09-26T07:00:00.000Z', end: '2026-09-26T15:00:00.000Z' }]),
            [
                { start: '2026-09-26T06:00:00.000Z', end: '2026-09-26T07:00:00.000Z' },
                { start: '2026-09-26T15:00:00.000Z', end: '2026-09-26T22:00:00.000Z' },
            ],
        );
    });

    it('trims the leading edge when a night shift runs into the morning', () => {
        assert.deepEqual(
            subtractIntervals(day, [{ start: '2026-09-25T23:00:00.000Z', end: '2026-09-26T07:00:00.000Z' }]),
            [{ start: '2026-09-26T07:00:00.000Z', end: '2026-09-26T22:00:00.000Z' }],
        );
    });

    it('returns nothing when the window is fully covered', () => {
        assert.deepEqual(
            subtractIntervals(day, [{ start: '2026-09-26T00:00:00.000Z', end: '2026-09-27T00:00:00.000Z' }]),
            [],
        );
    });

    it('leaves the window intact when nothing overlaps', () => {
        assert.deepEqual(
            subtractIntervals(day, [{ start: '2026-09-27T07:00:00.000Z', end: '2026-09-27T15:00:00.000Z' }]),
            [day],
        );
        assert.deepEqual(subtractIntervals(day, []), [day]);
    });

    it('handles several overlapping shifts at once', () => {
        assert.deepEqual(
            subtractIntervals(day, [
                { start: '2026-09-26T07:00:00.000Z', end: '2026-09-26T09:00:00.000Z' },
                { start: '2026-09-26T12:00:00.000Z', end: '2026-09-26T14:00:00.000Z' },
            ]),
            [
                { start: '2026-09-26T06:00:00.000Z', end: '2026-09-26T07:00:00.000Z' },
                { start: '2026-09-26T09:00:00.000Z', end: '2026-09-26T12:00:00.000Z' },
                { start: '2026-09-26T14:00:00.000Z', end: '2026-09-26T22:00:00.000Z' },
            ],
        );
    });

    it('ignores malformed busy intervals rather than dropping the window', () => {
        assert.deepEqual(subtractIntervals(day, [{ start: 'nope', end: 'nope' }]), [day]);
        assert.deepEqual(subtractIntervals({ start: 'nope', end: 'nope' }, []), []);
    });
});

describe('weekdayIndex', () => {
    it('maps Cal.com weekday names onto UTC day numbers', () => {
        assert.equal(weekdayIndex('Sunday'), 0);
        assert.equal(weekdayIndex('monday'), 1);
        assert.equal(weekdayIndex(' Friday '), 5);
        assert.equal(weekdayIndex('Funday'), null);
        assert.equal(weekdayIndex(3), null);
    });
});
