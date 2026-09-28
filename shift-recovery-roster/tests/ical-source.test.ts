/**
 * iCal source tests.
 *
 * Drive the full pipeline from an inline .ics feed, the way a Google Calendar "secret address"
 * serves it, and assert on the records the n8n workflow consumes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { log } from 'apify';

import { describeConfig, parseInput } from '../src/input.js';
import type { OutputDeps } from '../src/output/dataset.js';
import { createSource, runPipeline } from '../src/pipeline/run.js';
import { IcalSource } from '../src/sources/ical/source.js';
import type { AnyRecord, ShiftRecord, SummaryRecord, WorkerRecord } from '../src/types.js';
import { NOW } from './fixtures/calcom.js';

log.setLevel(log.LEVELS.OFF);

const SECRET_URL = 'https://calendar.google.com/calendar/ical/icu%40group.calendar.google.com/private-s3cr3t/basic.ics';

const FEED = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    // A day shift, organised by the reception account, which is also listed as an attendee.
    'BEGIN:VEVENT',
    'DTSTART:20260928T050000Z',
    'DTEND:20260928T130000Z',
    'UID:shift1@google.com',
    'SUMMARY:ICU dienst',
    'ORGANIZER;CN=ICU rooster:mailto:receptie@hospital.example',
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Sarah Vos:mailto:sarah@hospital.example',
    'ATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=ACCEPTED;CN=ICU rooster:mailto:receptie@hospital.example',
    'END:VEVENT',
    // The receptionist reported this one sick.
    'BEGIN:VEVENT',
    'DTSTART:20260929T050000Z',
    'DTEND:20260929T130000Z',
    'UID:shift2@google.com',
    'SUMMARY:ZIEK ICU dienst',
    'ATTENDEE;CN=Sarah Vos:mailto:sarah@hospital.example',
    'END:VEVENT',
    // Three nights in a row from one recurring event.
    'BEGIN:VEVENT',
    'DTSTART:20260928T210000Z',
    'DTEND:20260929T050000Z',
    'RRULE:FREQ=DAILY;COUNT=3',
    'UID:night@google.com',
    'SUMMARY:ICU nachtdienst',
    'ATTENDEE;CN=Jonas Berg:mailto:jonas@hospital.example',
    'END:VEVENT',
    // All-day entries are not shifts.
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20260930',
    'DTEND;VALUE=DATE:20261001',
    'UID:allday@google.com',
    'SUMMARY:Teamuitje',
    'ATTENDEE:mailto:sarah@hospital.example',
    'END:VEVENT',
    // A declined guest and a room are skipped; Amina works it.
    'BEGIN:VEVENT',
    'DTSTART:20261001T050000Z',
    'DTEND:20261001T130000Z',
    'UID:shift3@google.com',
    'SUMMARY:ICU dienst',
    'ATTENDEE;PARTSTAT=DECLINED:mailto:jonas@hospital.example',
    'ATTENDEE;CUTYPE=ROOM:mailto:room@resource.calendar.google.com',
    'ATTENDEE:mailto:amina@hospital.example',
    'END:VEVENT',
    'END:VCALENDAR',
].join('\r\n');

const EMPLOYEES = ['sarah', 'jonas', 'amina', 'pieter'].map((name, index) => ({
    employeeId: `E10${index + 1}`,
    email: `${name}@hospital.example`,
    role: 'ICU_NURSE',
    department: 'ICU',
    skills: ['ICU'],
}));

function icalInput(overrides: Record<string, unknown> = {}) {
    return parseInput(
        {
            mode: 'live',
            icsUrl: SECRET_URL,
            startTime: '2026-09-28T00:00:00Z',
            endTime: '2026-10-05T00:00:00Z',
            employeeMetadata: EMPLOYEES,
            ...overrides,
        },
        { now: NOW, env: {} },
    );
}

type Reply = { status?: number; body?: string; contentType?: string } | Error;

/** A fetch that serves the given replies in order and records every call. */
function feed(...replies: Reply[]) {
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
        calls.push(url);
        const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {};
        if (reply instanceof Error) throw reply;
        return new Response(reply.body ?? FEED, {
            status: reply.status ?? 200,
            headers: { 'content-type': reply.contentType ?? 'text/calendar; charset=UTF-8' },
        });
    };
    return { calls, fetchImpl };
}

async function run(source: IcalSource) {
    const records: AnyRecord[] = [];
    const output: OutputDeps = {
        pushData: async (items) => {
            records.push(...items);
        },
        setValue: async () => {},
    };
    await runPipeline(icalInput(), { source, output });
    const workers = new Map(
        records.filter((r): r is WorkerRecord => r.recordType === 'worker').map((w) => [w.employeeId, w]),
    );
    const shifts = new Map(
        records.filter((r): r is ShiftRecord => r.recordType === 'shift').map((s) => [s.shiftId, s]),
    );
    const summary = records.find((r): r is SummaryRecord => r.recordType === 'summary');
    return { workers, shifts, summary };
}

function source(fetchImpl: (url: string) => Promise<Response>, overrides: Record<string, unknown> = {}) {
    return new IcalSource({ input: icalInput(overrides), fetchImpl, sleepImpl: async () => {} });
}

describe('IcalSource', () => {
    it('turns a calendar feed into workers and shifts', async () => {
        const { workers, shifts, summary } = await run(source(feed().fetchImpl));

        assert.equal(summary?.sourceSystem, 'ical');
        assert.equal(summary?.status, 'success');
        // The organizer is not staff; Pieter has no shift but is still a candidate.
        assert.deepEqual([...workers.keys()].sort(), ['E101', 'E102', 'E103', 'E104']);

        const dayShift = shifts.get('SHIFT-ICAL-shift1');
        assert.equal(dayShift?.assignedEmployeeId, 'E101');
        // 'scheduled' or 'completed' depending on the wall clock; never cancelled.
        assert.ok(dayShift?.status === 'scheduled' || dayShift?.status === 'completed');

        const sick = shifts.get('SHIFT-ICAL-shift2');
        assert.equal(sick?.status, 'cancelled');
        assert.equal(sick?.assignedEmployeeId, null);

        assert.equal(shifts.get('SHIFT-ICAL-shift3')?.assignedEmployeeId, 'E103');
        assert.equal(
            [...shifts.keys()].some((id) => id.includes('allday')),
            false,
        );
    });

    it('expands recurring events with Google-style instance ids', async () => {
        const { workers, shifts } = await run(source(feed().fetchImpl));
        const nights = [...shifts.values()].filter((s) => s.shiftId.startsWith('SHIFT-ICAL-night_'));
        assert.deepEqual(
            nights.map((s) => s.shiftId),
            [
                'SHIFT-ICAL-night_20260928T210000Z',
                'SHIFT-ICAL-night_20260929T210000Z',
                'SHIFT-ICAL-night_20260930T210000Z',
            ],
        );
        assert.equal(workers.get('E102')?.scheduledShifts.length, 3);
        assert.equal(workers.get('E102')?.hoursThisWeek, 24);
    });

    it('does not count a sick shift as worked and keeps availability off shifts', async () => {
        const { workers } = await run(source(feed().fetchImpl));
        const sarah = workers.get('E101');
        assert.equal(sarah?.hoursThisWeek, 8);
        assert.deepEqual(sarah?.scheduledShifts, ['SHIFT-ICAL-shift1']);

        const onShift = (w: WorkerRecord | undefined, at: string) =>
            (w?.availability ?? []).some(
                (a) => Date.parse(a.start) <= Date.parse(at) && Date.parse(a.end) > Date.parse(at),
            );
        assert.equal(onShift(sarah, '2026-09-28T08:00:00Z'), false);
        // The sick day is free time: Sarah is not working it.
        assert.equal(onShift(sarah, '2026-09-29T08:00:00Z'), true);
        assert.equal(onShift(workers.get('E104'), '2026-10-04T23:00:00Z'), true);
    });

    it('honours a custom sick prefix', async () => {
        const custom = source(feed().fetchImpl, { sickPrefix: 'SICK' });
        const snapshot = await custom.fetch();
        assert.equal(snapshot.events.find((e) => e.uid === 'shift2')?.status, 'accepted');
    });

    it('retries a 503 and then succeeds', async () => {
        const mock = feed({ status: 503, body: 'down' }, {});
        const snapshot = await source(mock.fetchImpl).fetch();
        assert.equal(mock.calls.length, 2);
        assert.equal(snapshot.stats.retries, 1);
    });

    it('fails with a typed error and never leaks the secret address', async () => {
        await assert.rejects(
            source(feed({ status: 404, body: 'Not found' }).fetchImpl).fetch(),
            (err: Error & { code?: string }) => {
                assert.equal(err.code, 'UPSTREAM_ERROR');
                assert.equal(err.message.includes('s3cr3t'), false);
                return true;
            },
        );
        await assert.rejects(
            source(feed({ body: '<html>Sign in</html>', contentType: 'text/html' }).fetchImpl).fetch(),
            (err: Error & { code?: string }) => err.code === 'MALFORMED_RESPONSE',
        );
        await assert.rejects(
            source(feed(new TypeError(`fetch failed for ${SECRET_URL}`)).fetchImpl, { maxRetries: 0 }).fetch(),
            (err: Error & { code?: string }) => err.code === 'NETWORK_ERROR' && !err.message.includes('s3cr3t'),
        );
    });
});

describe('iCal input', () => {
    it('needs no Cal.com key and selects the iCal adapter', () => {
        const input = icalInput();
        assert.equal(input.apiKey, '');
        assert.ok(createSource(input) instanceof IcalSource);
    });

    it('reads ICS_URL from the environment and accepts webcal://', () => {
        const input = parseInput({ mode: 'live' }, { now: NOW, env: { ICS_URL: 'webcal://example.com/cal.ics' } });
        assert.equal(input.icsUrl, 'https://example.com/cal.ics');
    });

    it('never puts the address in the logged configuration or in validation errors', () => {
        assert.equal(JSON.stringify(describeConfig(icalInput())).includes('s3cr3t'), false);
        assert.throws(
            () => parseInput({ icsUrl: 'http://example.com/private-s3cr3t.ics' }, { now: NOW, env: {} }),
            (err: Error) => !err.message.includes('s3cr3t'),
        );
    });
});
