import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CredentialsMissingError, InputError } from '../src/errors.js';
import { describeConfig, parseEmployeeMetadataList, parseInput } from '../src/input.js';

const NOW = new Date('2026-09-26T09:00:00.000Z');
const KEY = 'cal_test_0123456789abcdef';

function parse(raw: Record<string, unknown>, env: Record<string, string | undefined> = {}) {
    return parseInput(raw, { now: NOW, env });
}

describe('parseInput - defaults', () => {
    it('defaults to a live run over the coming week', () => {
        const input = parse({ apiKey: KEY });

        assert.equal(input.mode, 'live');
        assert.equal(input.baseUrl, 'https://api.cal.com/v2');
        assert.equal(input.range.start, '2026-09-26T09:00:00.000Z');
        assert.equal(input.range.end, '2026-10-03T09:00:00.000Z');
        assert.deepEqual(input.bookingStatuses, ['upcoming']);
        assert.equal(input.pageSize, 100);
        assert.equal(input.maxRetries, 4);
        assert.equal(input.failOnEmptyResult, false);
    });

    it('needs no credential in demo mode', () => {
        const input = parse({ mode: 'demo' });

        assert.equal(input.mode, 'demo');
        assert.equal(input.useDemoWorkforceMetadata, true, 'demo mode implies demo metadata');
    });

    it('turns on demo metadata fallback in hybrid mode', () => {
        assert.equal(parse({ mode: 'hybrid', apiKey: KEY }).useDemoWorkforceMetadata, true);
    });

    it('leaves demo metadata off in live mode unless asked', () => {
        assert.equal(parse({ apiKey: KEY }).useDemoWorkforceMetadata, false);
        assert.equal(parse({ apiKey: KEY, useDemoWorkforceMetadata: true }).useDemoWorkforceMetadata, true);
    });
});

describe('parseInput - credentials', () => {
    it('falls back to the environment variable', () => {
        const input = parse({}, { CAL_COM_API_KEY: KEY });
        assert.equal(input.apiKey, KEY);
    });

    it('prefers the input over the environment', () => {
        const input = parse({ apiKey: 'cal_test_fromtheinput00' }, { CAL_COM_API_KEY: KEY });
        assert.equal(input.apiKey, 'cal_test_fromtheinput00');
    });

    it('fails with actionable guidance when no credential is available', () => {
        assert.throws(
            () => parse({ mode: 'live' }),
            (err: unknown) => {
                assert.ok(err instanceof CredentialsMissingError);
                assert.equal(err.code, 'CREDENTIALS_MISSING');
                assert.match(err.message, /CAL_COM_API_KEY/);
                assert.match(err.message, /"demo"/);
                return true;
            },
        );
    });

    it('rejects a truncated key before making any request', () => {
        assert.throws(() => parse({ apiKey: 'cal_x' }), /too short to be valid/);
    });
});

describe('parseInput - validation', () => {
    it('rejects a non-object input', () => {
        assert.throws(() => parseInput('nope', { now: NOW, env: {} }), InputError);
    });

    it('rejects an unknown mode', () => {
        assert.throws(() => parse({ mode: 'turbo', apiKey: KEY }), /must be one of live, hybrid, demo/);
    });

    it('rejects a non-HTTPS base URL but allows localhost', () => {
        assert.throws(() => parse({ apiKey: KEY, baseUrl: 'http://api.cal.com/v2' }), /must use HTTPS/);
        assert.equal(parse({ apiKey: KEY, baseUrl: 'http://localhost:3000/v2' }).baseUrl, 'http://localhost:3000/v2');
    });

    it('strips a trailing slash from the base URL', () => {
        assert.equal(parse({ apiKey: KEY, baseUrl: 'https://api.cal.com/v2/' }).baseUrl, 'https://api.cal.com/v2');
    });

    it('rejects an invalid URL', () => {
        assert.throws(() => parse({ apiKey: KEY, baseUrl: 'not a url' }), /not a valid URL/);
    });

    it('rejects a number outside its documented bounds', () => {
        assert.throws(() => parse({ apiKey: KEY, pageSize: 500 }), /must be between 1 and 100/);
        assert.throws(() => parse({ apiKey: KEY, maxRetries: -1 }), /must be between 0 and 10/);
    });

    it('rejects an unsupported booking status', () => {
        assert.throws(() => parse({ apiKey: KEY, bookingStatuses: ['tomorrow'] }), /unsupported value/);
    });

    it('deduplicates booking statuses', () => {
        assert.deepEqual(parse({ apiKey: KEY, bookingStatuses: ['past', 'past'] }).bookingStatuses, ['past']);
    });

    it('coerces the Console string list of IDs into integers', () => {
        const input = parse({ apiKey: KEY, teamIds: ['31', '31', '44'], eventTypeIds: ['900'] });
        assert.deepEqual(input.teamIds, [31, 44]);
        assert.deepEqual(input.eventTypeIds, [900]);
    });

    it('rejects a non-numeric ID', () => {
        assert.throws(() => parse({ apiKey: KEY, teamIds: ['icu-team'] }), /positive integer IDs/);
    });

    it('strips a leading @ from usernames', () => {
        assert.deepEqual(parse({ apiKey: KEY, usernames: ['@sarah-v', 'jonas-b'] }).usernames, ['sarah-v', 'jonas-b']);
    });

    it('rejects a metadata URL that is not HTTPS', () => {
        assert.throws(() => parse({ apiKey: KEY, employeeMetadataUrl: 'http://roster.example/staff.json' }), /HTTPS/);
    });
});

describe('parseInput - employee metadata', () => {
    it('normalizes match keys to lower case', () => {
        const input = parse({
            apiKey: KEY,
            employeeMetadata: [
                { employeeId: 'E101', email: 'Sarah@Hospital.Example', calUsername: '@Sarah-V', role: 'ICU_NURSE' },
            ],
        });

        assert.equal(input.employeeMetadata[0]?.email, 'sarah@hospital.example');
        assert.equal(input.employeeMetadata[0]?.calUsername, 'sarah-v');
    });

    it('accepts a JSON string, a bare array, or an { employees: [] } wrapper', () => {
        const entry = { employeeId: 'E101', email: 'a@b.example' };
        assert.equal(parseEmployeeMetadataList(JSON.stringify([entry]), 'f').length, 1);
        assert.equal(parseEmployeeMetadataList({ employees: [entry] }, 'f').length, 1);
        assert.equal(parseEmployeeMetadataList([entry], 'f').length, 1);
        assert.equal(parseEmployeeMetadataList(undefined, 'f').length, 0);
    });

    it('rejects an entry with no employee ID', () => {
        assert.throws(() => parseEmployeeMetadataList([{ email: 'a@b.example' }], 'f'), /missing "employeeId"/);
    });

    it('rejects an entry with no way to match it to a scheduling user', () => {
        assert.throws(() => parseEmployeeMetadataList([{ employeeId: 'E1' }], 'f'), /at least one match key/);
    });

    it('rejects a malformed availability window rather than ignoring it', () => {
        assert.throws(
            () =>
                parseEmployeeMetadataList(
                    [{ employeeId: 'E1', email: 'a@b.example', availability: [{ start: 'x', end: 'y' }] }],
                    'f',
                ),
            /ISO-8601 "start" and "end"/,
        );
        assert.throws(
            () =>
                parseEmployeeMetadataList(
                    [
                        {
                            employeeId: 'E1',
                            email: 'a@b.example',
                            availability: [{ start: '2026-09-26T10:00:00Z', end: '2026-09-26T08:00:00Z' }],
                        },
                    ],
                    'f',
                ),
            /at or before "start"/,
        );
    });

    it('normalizes availability windows to UTC', () => {
        const parsed = parseEmployeeMetadataList(
            [
                {
                    employeeId: 'E1',
                    email: 'a@b.example',
                    availability: [{ start: '2026-09-26T10:00:00+02:00', end: '2026-09-26T18:00:00+02:00' }],
                },
            ],
            'f',
        );

        assert.deepEqual(parsed[0]?.availability, [
            { start: '2026-09-26T08:00:00.000Z', end: '2026-09-26T16:00:00.000Z' },
        ]);
    });

    it('rejects a shift type mapping with nothing to match on', () => {
        assert.throws(() => parse({ apiKey: KEY, shiftTypeMetadata: [{ role: 'ICU_NURSE' }] }), /eventTypeId/);
    });
});

describe('describeConfig', () => {
    it('reduces the credential to a boolean and a flavour', () => {
        const described = describeConfig(parse({ apiKey: 'cal_live_realsecret12345' }));

        assert.equal(described.credentialProvided, true);
        assert.equal(described.credentialKind, 'cal_live');
        assert.equal(JSON.stringify(described).includes('realsecret'), false, 'the key never appears');
    });

    it('reports no credential in demo mode', () => {
        const described = describeConfig(parse({ mode: 'demo' }));
        assert.equal(described.credentialProvided, false);
        assert.equal(described.credentialKind, 'none');
    });

    it('summarizes the window, filters and limits', () => {
        const described = describeConfig(parse({ apiKey: KEY, teamIds: ['31'], startTime: 'now', endTime: 'now+2d' }));

        assert.deepEqual(described.window, {
            start: '2026-09-26T09:00:00.000Z',
            end: '2026-09-28T09:00:00.000Z',
            days: 2,
        });
        assert.deepEqual((described.filters as { teamIds: number[] }).teamIds, [31]);
    });
});
