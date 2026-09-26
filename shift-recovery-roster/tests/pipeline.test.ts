/**
 * End-to-end pipeline tests.
 *
 * These drive the whole chain - source, normalization, enrichment, deduplication, validation,
 * dataset write - against a mocked Cal.com and a mocked dataset, and assert on the contract the
 * n8n workflow actually consumes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { log } from 'apify';

import { AuthenticationError, EmptyResultError } from '../src/errors.js';
import { HttpClient } from '../src/http/fetcher.js';
import type { OutputDeps } from '../src/output/dataset.js';
import { runPipeline } from '../src/pipeline/run.js';
import { CalComClient } from '../src/sources/calcom/client.js';
import { CalComSource } from '../src/sources/calcom/source.js';
import { DemoRosterSource } from '../src/sources/demo/source.js';
import type { AnyRecord, ShiftRecord, SummaryRecord, WorkerRecord } from '../src/types.js';
import { EMPLOYEE_METADATA, SHIFT_TYPE_METADATA, happyPathRoutes, testInput } from './fixtures/calcom.js';
import { calOk, instantSleep, mockHttp, overrideRoute, type MockRoute } from './fixtures/mock-http.js';

log.setLevel(log.LEVELS.OFF);

interface Captured {
    output: OutputDeps;
    /** Every push, in order, so write ordering can be asserted. */
    pushes: AnyRecord[][];
    records: AnyRecord[];
    values: Record<string, unknown>;
}

function captureOutput(): Captured {
    const pushes: AnyRecord[][] = [];
    const values: Record<string, unknown> = {};
    return {
        pushes,
        get records() {
            return pushes.flat();
        },
        values,
        output: {
            pushData: async (records) => {
                pushes.push(records);
            },
            setValue: async (key, value) => {
                values[key] = value;
            },
        },
    };
}

function calComSource(routes: MockRoute[], input = testInput()): CalComSource {
    const mock = mockHttp(routes);
    const sleep = instantSleep();
    const http = new HttpClient({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        timeoutMs: 5000,
        maxRetries: 1,
        fetchImpl: mock.fetchImpl,
        sleepImpl: sleep.sleepImpl,
        backoffBaseMs: 1,
    });
    const client = new CalComClient(http, {
        pageSize: input.pageSize,
        maxPages: input.maxPagesPerResource,
        maxRecords: input.maxRecordsPerResource,
    });
    return new CalComSource({ input, client, httpClient: http });
}

describe('pipeline - successful run against Cal.com', () => {
    const input = testInput({
        employeeMetadata: EMPLOYEE_METADATA,
        shiftTypeMetadata: SHIFT_TYPE_METADATA,
    });

    it('produces workers, shifts, events and exactly one summary', async () => {
        const captured = captureOutput();
        const result = await runPipeline(input, {
            source: calComSource(happyPathRoutes(), input),
            output: captured.output,
        });

        assert.equal(result.summary.recordType, 'summary');
        assert.equal(result.summary.status, 'success');
        assert.equal(result.summary.emptyResult, false);
        assert.equal(result.bundle.workers.length, 3);
        assert.equal(result.bundle.shifts.length, 3);
        assert.equal(result.bundle.events.length, 3);

        const summaries = captured.records.filter((record) => record.recordType === 'summary');
        assert.equal(summaries.length, 1);
    });

    it('writes the summary last so a truncated dataset is detectable', async () => {
        const captured = captureOutput();
        await runPipeline(input, { source: calComSource(happyPathRoutes(), input), output: captured.output });

        const last = captured.records[captured.records.length - 1];
        assert.equal(last?.recordType, 'summary');
        const lastPush = captured.pushes[captured.pushes.length - 1];
        assert.equal(lastPush?.length, 1, 'the summary is pushed on its own, after everything else');
    });

    it('writes records in the documented order: workers, shifts, events', async () => {
        const captured = captureOutput();
        await runPipeline(input, { source: calComSource(happyPathRoutes(), input), output: captured.output });

        const types = captured.records.map((record) => record.recordType);
        const firstShift = types.indexOf('shift');
        const lastWorker = types.lastIndexOf('worker');
        const firstEvent = types.indexOf('schedulingEvent');

        assert.ok(lastWorker < firstShift, 'all workers precede the shifts');
        assert.ok(firstShift < firstEvent, 'all shifts precede the scheduling events');
    });

    it('emits the documented worker contract', async () => {
        const result = await runPipeline(input, {
            source: calComSource(happyPathRoutes(), input),
            output: captureOutput().output,
        });

        const sarah = result.bundle.workers.find((item) => item.email === 'sarah@hospital.example');
        assert.ok(sarah !== undefined);
        assert.equal(sarah.recordType, 'worker');
        assert.equal(sarah.employeeId, 'E101');
        assert.equal(sarah.role, 'ICU_NURSE');
        assert.equal(sarah.department, 'ICU');
        assert.deepEqual(sarah.skills, ['ICU', 'BLS']);
        assert.equal(sarah.contractedHoursPerWeek, 36);
        assert.equal(sarah.source, 'cal.com');
        assert.deepEqual(sarah.scheduledShifts, ['SHIFT-CAL-bk-1001']);
        assert.equal(typeof sarah.hoursThisWeek, 'number');
        assert.ok(Array.isArray(sarah.availability));
    });

    it('emits the documented shift contract, including the uncovered gap', async () => {
        const result = await runPipeline(input, {
            source: calComSource(happyPathRoutes(), input),
            output: captureOutput().output,
        });

        const open = result.bundle.shifts.find((item) => item.sourceIds.bookingUid === 'bk-1003');
        assert.ok(open !== undefined);
        assert.equal(open.recordType, 'shift');
        assert.equal(open.shiftId, 'SHIFT-CAL-bk-1003');
        assert.equal(open.role, 'ICU_NURSE');
        assert.deepEqual(open.requiredSkills, ['ICU', 'BLS']);
        assert.equal(open.assignedEmployeeId, null);
        assert.equal(open.coverageStatus, 'uncovered');
        assert.equal(open.status, 'pending');
        assert.equal(open.source, 'cal.com');
    });

    it('never labels workforce metadata as Cal.com data anywhere in the dataset', async () => {
        const captured = captureOutput();
        await runPipeline(input, { source: calComSource(happyPathRoutes(), input), output: captured.output });

        for (const record of captured.records) {
            if (record.recordType === 'summary') continue;
            const sources = record.fieldSources;
            for (const field of ['role', 'department', 'skills', 'contractedHoursPerWeek']) {
                const provenance = sources[field];
                if (provenance === undefined) continue;
                assert.notEqual(provenance, 'cal.com', `${record.recordType}.${field} wrongly claims Cal.com`);
            }
        }
    });

    it('reports counts, window, timing and version in the summary', async () => {
        const result = await runPipeline(input, {
            source: calComSource(happyPathRoutes(), input),
            output: captureOutput().output,
        });

        const { summary } = result;
        assert.equal(summary.counts.workersRetrieved, 3);
        assert.equal(summary.counts.shiftsRetrieved, 3);
        assert.equal(summary.counts.eventsRetrieved, 3);
        assert.equal(summary.counts.recordsNormalized, 9);
        assert.equal(summary.counts.recordsDiscarded, 0);
        assert.ok(summary.counts.apiRequests >= 6);
        assert.deepEqual(summary.dateRange, { start: '2026-09-26T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z' });
        assert.equal(summary.workforceMetadataSource, 'input-inline');
        assert.equal(summary.sourceSystem, 'cal.com');
        assert.equal(typeof summary.durationMs, 'number');
        assert.equal(summary.actorVersion, '1.0.0');
        assert.equal(summary.errorCode, null);
    });

    it('mirrors the summary and a run report into the key-value store', async () => {
        const captured = captureOutput();
        await runPipeline(input, { source: calComSource(happyPathRoutes(), input), output: captured.output });

        assert.equal((captured.values.SUMMARY as SummaryRecord).recordType, 'summary');
        const report = captured.values.RUN_REPORT as { resources: Record<string, unknown> };
        assert.ok(Object.keys(report.resources).length > 0, 'the report lists per-resource page counts');
    });

    it('keeps no credential anywhere in the output', async () => {
        const captured = captureOutput();
        await runPipeline(input, {
            source: calComSource(happyPathRoutes(), input),
            output: captured.output,
            configuration: { credentialProvided: true },
        });

        const serialized = JSON.stringify({ records: captured.records, values: captured.values });
        assert.equal(serialized.includes('cal_test_'), false);
        assert.equal(serialized.includes(input.apiKey), false);
    });
});

describe('pipeline - empty but successful', () => {
    it('reports a quiet week as a clean success, not a failure', async () => {
        // Every endpoint answers correctly; there is simply nothing scheduled in the window.
        const emptyRoutes: MockRoute[] = [
            [
                /\/v2\/me$/,
                () => ({
                    body: calOk({ id: 501, username: 'lead', email: 'lead@hospital.example', name: 'Alex Lead' }),
                }),
            ],
            [/\/v2\/teams$/, () => ({ body: calOk([]) })],
            [/\/v2\/event-types$/, () => ({ body: calOk([]) })],
            [/\/v2\/schedules$/, () => ({ body: calOk([]) })],
            [/\/v2\/bookings$/, () => ({ body: calOk([], { nextCursor: null, hasMore: false }) })],
        ];
        const input = testInput();
        const captured = captureOutput();

        const result = await runPipeline(input, { source: calComSource(emptyRoutes, input), output: captured.output });

        assert.equal(result.summary.status, 'success');
        assert.equal(result.summary.counts.shiftsRetrieved, 0);
        assert.equal(result.summary.counts.workersRetrieved, 1, 'the authenticated user is still a worker');
        assert.equal(result.summary.emptyResult, false);
        assert.equal(result.summary.errorCode, null);
        assert.ok(captured.records.length >= 2, 'a summary is written even when nothing was scheduled');
    });

    it('flags emptyResult and explains it when no worker is found', async () => {
        const noWorkerRoutes: MockRoute[] = [
            // A user record with no email and no name cannot be a usable worker.
            [/\/v2\/me$/, () => ({ body: calOk({}) })],
            [/\/v2\/teams$/, () => ({ body: calOk([]) })],
            [/\/v2\/event-types$/, () => ({ body: calOk([]) })],
            [/\/v2\/schedules$/, () => ({ body: calOk([]) })],
            [/\/v2\/bookings$/, () => ({ body: calOk([], { nextCursor: null, hasMore: false }) })],
        ];
        const input = testInput();

        const result = await runPipeline(input, {
            source: calComSource(noWorkerRoutes, input),
            output: captureOutput().output,
        });

        assert.equal(result.summary.counts.workersRetrieved, 0);
        assert.equal(result.summary.emptyResult, true);
        assert.notEqual(result.summary.status, 'failure');
        assert.match(result.summary.warnings.join(' '), /EMPTY SUCCESS, not a failure/);
    });

    it('fails the run on an empty result when the operator asked it to', async () => {
        const noWorkerRoutes: MockRoute[] = [
            [/\/v2\/me$/, () => ({ body: calOk({}) })],
            [/\/v2\/teams$/, () => ({ body: calOk([]) })],
            [/\/v2\/event-types$/, () => ({ body: calOk([]) })],
            [/\/v2\/schedules$/, () => ({ body: calOk([]) })],
            [/\/v2\/bookings$/, () => ({ body: calOk([], { nextCursor: null, hasMore: false }) })],
        ];
        const input = testInput({ failOnEmptyResult: true });
        const captured = captureOutput();

        await assert.rejects(
            runPipeline(input, { source: calComSource(noWorkerRoutes, input), output: captured.output }),
            (err: unknown) => {
                assert.ok(err instanceof EmptyResultError);
                assert.equal(err.code, 'EMPTY_RESULT');
                return true;
            },
        );
        // The dataset was still written first, so an operator can see what the empty run produced.
        assert.equal(captured.records.filter((record) => record.recordType === 'summary').length, 1);
    });
});

describe('pipeline - failures never look like an empty roster', () => {
    it('propagates an authentication failure instead of writing an empty dataset', async () => {
        const input = testInput();
        const captured = captureOutput();

        await assert.rejects(
            runPipeline(input, {
                source: calComSource([[/\/v2\/me$/, () => ({ status: 401, body: { error: 'bad key' } })]], input),
                output: captured.output,
            }),
            AuthenticationError,
        );

        assert.deepEqual(captured.records, [], 'nothing at all is written when retrieval fails');
    });

    it('propagates a mid-pagination upstream failure', async () => {
        const input = testInput();

        await assert.rejects(
            runPipeline(input, {
                source: calComSource(
                    overrideRoute(happyPathRoutes(), 'bookings', () => ({ status: 500, text: 'down' })),
                    input,
                ),
                output: captureOutput().output,
            }),
            /HTTP 500/,
        );
    });

    it('marks a capped run partial rather than success', async () => {
        const input = testInput({ maxPagesPerResource: 2 });
        const result = await runPipeline(input, {
            source: calComSource(
                overrideRoute(happyPathRoutes(), 'bookings', (_url, call) => ({
                    body: calOk(
                        [
                            {
                                id: call,
                                uid: `bk-${call}`,
                                start: '2026-09-27T05:00:00.000Z',
                                end: '2026-09-27T13:00:00.000Z',
                                status: 'accepted',
                                hosts: [],
                            },
                        ],
                        {
                            nextCursor: `c${call}`,
                            hasMore: true,
                        },
                    ),
                })),
                input,
            ),
            output: captureOutput().output,
        });

        assert.equal(result.summary.status, 'partial');
        assert.match(result.summary.warnings.join(' '), /maxPagesPerResource/);
    });
});

describe('pipeline - deduplication and validation in the full run', () => {
    it('merges a booking returned by two status walks into one shift', async () => {
        const input = testInput({ bookingStatuses: ['upcoming', 'past'] });
        const result = await runPipeline(input, {
            source: calComSource(happyPathRoutes(), input),
            output: captureOutput().output,
        });

        // Both walks return the same three bookings; the shift set is still three.
        assert.equal(result.summary.counts.rawEventsRetrieved, 6);
        assert.equal(result.bundle.shifts.length, 3);
        assert.ok(result.summary.counts.duplicatesDropped >= 3);
        const ids = result.bundle.shifts.map((item) => item.shiftId);
        assert.equal(new Set(ids).size, ids.length, 'shift IDs are unique');
    });

    it('counts a malformed booking as discarded and keeps the rest', async () => {
        const input = testInput();
        const result = await runPipeline(input, {
            source: calComSource(
                overrideRoute(happyPathRoutes(), 'bookings', () => ({
                    body: calOk(
                        [
                            {
                                id: 1,
                                uid: 'good',
                                start: '2026-09-27T05:00:00.000Z',
                                end: '2026-09-27T13:00:00.000Z',
                                status: 'accepted',
                                hosts: [],
                            },
                            { id: 2, uid: 'broken', start: 'whenever', end: null, status: 'accepted', hosts: [] },
                        ],
                        { nextCursor: null, hasMore: false },
                    ),
                })),
                input,
            ),
            output: captureOutput().output,
        });

        assert.equal(result.bundle.shifts.length, 1);
        assert.equal(result.summary.counts.recordsDiscarded, 1);
        assert.equal(result.summary.status, 'partial', 'a discarded record means the snapshot is not complete');
        assert.match(result.report.discarded[0]?.reason ?? '', /unparseable/);
    });

    it('produces identical output on a repeated run', async () => {
        const input = testInput({ employeeMetadata: EMPLOYEE_METADATA });
        const strip = (records: AnyRecord[]): unknown =>
            records
                .filter((record) => record.recordType !== 'summary')
                .map((record) => ({ ...record, retrievedAt: 'X' }));

        const first = captureOutput();
        const second = captureOutput();
        await runPipeline(input, { source: calComSource(happyPathRoutes(), input), output: first.output });
        await runPipeline(input, { source: calComSource(happyPathRoutes(), input), output: second.output });

        assert.deepEqual(strip(first.records), strip(second.records));
    });
});

describe('pipeline - demo mode', () => {
    const input = testInput({ mode: 'demo', apiKey: '' });

    it('runs with no credential and no network access', async () => {
        const captured = captureOutput();
        const result = await runPipeline(input, {
            source: new DemoRosterSource(input),
            output: captured.output,
        });

        assert.equal(result.summary.status, 'success');
        assert.equal(result.summary.sourceSystem, 'demo');
        assert.equal(result.summary.counts.apiRequests, 0);
        assert.equal(result.bundle.workers.length, 12);
        assert.ok(result.bundle.shifts.length > 20, 'a week of three shifts across five departments');
    });

    it('flags every demo record as synthetic', async () => {
        const captured = captureOutput();
        await runPipeline(input, { source: new DemoRosterSource(input), output: captured.output });

        for (const record of captured.records) {
            assert.equal(record.synthetic, true, `${record.recordType} must be flagged synthetic`);
        }
    });

    it('gives every demo worker a role, department and skills', async () => {
        const result = await runPipeline(input, {
            source: new DemoRosterSource(input),
            output: captureOutput().output,
        });

        for (const worker of result.bundle.workers) {
            assert.ok(worker.role !== null, `${worker.employeeId} has a role`);
            assert.ok(worker.department !== null);
            assert.ok(worker.skills.length > 0);
            assert.ok(worker.contractedHoursPerWeek !== null);
            assert.equal(worker.fieldSources.role, 'demo-workforce-metadata');
        }
    });

    it('leaves some shifts uncovered so there is something to recover', async () => {
        const result = await runPipeline(input, {
            source: new DemoRosterSource(input),
            output: captureOutput().output,
        });

        const uncovered = result.bundle.shifts.filter((item) => item.coverageStatus === 'uncovered');
        const covered = result.bundle.shifts.filter((item) => item.coverageStatus === 'covered');
        assert.ok(uncovered.length > 0, 'at least one gap');
        assert.ok(covered.length > 0, 'and some covered shifts to reason about');
    });

    it('gives every shift - covered or not - a role, department and required skills', async () => {
        const result = await runPipeline(input, {
            source: new DemoRosterSource(input),
            output: captureOutput().output,
        });

        for (const shift of result.bundle.shifts) {
            assert.ok(shift.role !== null, `${shift.shiftId} has a role`);
            assert.ok(shift.department !== null, `${shift.shiftId} has a department`);
            assert.ok(shift.requiredSkills.length > 0, `${shift.shiftId} states what it needs`);
            assert.equal(shift.fieldSources.requiredSkills, 'demo-workforce-metadata');
        }

        // An uncovered shift is useless to the decision layer without its requirements.
        const gap = result.bundle.shifts.find((item) => item.coverageStatus === 'uncovered');
        assert.ok(gap?.requiredSkills.length ?? 0 > 0);
    });

    it('requires ALS on night shifts, so eligibility filtering is not trivial', async () => {
        const result = await runPipeline(input, {
            source: new DemoRosterSource(input),
            output: captureOutput().output,
        });

        const night = result.bundle.shifts.filter((item) => item.sourceIds.eventTypeSlug?.endsWith('night-shift'));
        assert.ok(night.length > 0);
        for (const shift of night) assert.ok(shift.requiredSkills.includes('ALS'));

        // And not every demo nurse holds ALS, so the filter actually removes candidates.
        const withoutAls = result.bundle.workers.filter((item) => !item.skills.includes('ALS'));
        assert.ok(withoutAls.length > 0, 'some workers are ineligible for a night shift');
    });

    it('gives workers availability that does not collide with their own shifts', async () => {
        const result = await runPipeline(input, {
            source: new DemoRosterSource(input),
            output: captureOutput().output,
        });

        const withAvailability = result.bundle.workers.filter((item) => item.availability.length > 0);
        assert.ok(withAvailability.length > 0);

        for (const worker of withAvailability) {
            const shifts = result.bundle.shifts.filter((item) => item.assignedEmployeeId === worker.employeeId);
            for (const window of worker.availability) {
                for (const shift of shifts) {
                    const overlap =
                        Math.min(Date.parse(window.end), Date.parse(shift.end)) -
                        Math.max(Date.parse(window.start), Date.parse(shift.start));
                    assert.ok(overlap <= 0, `${worker.employeeId} is marked free during ${shift.shiftId}`);
                }
            }
        }
    });

    it('is deterministic for the same window', async () => {
        const a = await runPipeline(input, { source: new DemoRosterSource(input), output: captureOutput().output });
        const b = await runPipeline(input, { source: new DemoRosterSource(input), output: captureOutput().output });

        const ids = (records: (WorkerRecord | ShiftRecord)[]): string[] =>
            records.map((record) => (record.recordType === 'worker' ? record.employeeId : record.shiftId));

        assert.deepEqual(ids(a.bundle.workers), ids(b.bundle.workers));
        assert.deepEqual(ids(a.bundle.shifts), ids(b.bundle.shifts));
    });

    it('contains no medical information or absence reasons', async () => {
        const captured = captureOutput();
        await runPipeline(input, { source: new DemoRosterSource(input), output: captured.output });

        const serialized = JSON.stringify(captured.records).toLowerCase();
        for (const forbidden of ['patient', 'diagnos', 'illness', 'sick', 'symptom', 'medication']) {
            assert.equal(serialized.includes(forbidden), false, `demo data must not mention "${forbidden}"`);
        }
    });
});
