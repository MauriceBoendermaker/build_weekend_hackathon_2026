import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { log } from 'apify';

import { MetadataSourceError } from '../src/errors.js';
import { demoRosterMetadata, stableHash, synthesizeMetadata } from '../src/metadata/demo-metadata.js';
import { loadWorkforceMetadata, MetadataIndex, ShiftTypeIndex } from '../src/metadata/loader.js';
import { EMPLOYEE_METADATA, testInput } from './fixtures/calcom.js';
import { person } from './fixtures/snapshot.js';

log.setLevel(log.LEVELS.OFF);

const jsonResponse = (body: unknown, status = 200): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('loadWorkforceMetadata - sources', () => {
    it('loads inline entries and reports the origin', async () => {
        const result = await loadWorkforceMetadata(testInput({ employeeMetadata: EMPLOYEE_METADATA }));

        assert.equal(result.entries.length, 2);
        assert.deepEqual(result.origins, ['input-inline']);
        assert.equal(result.entries[0]?.provenance, 'workforce-metadata');
    });

    it('loads entries from an HTTPS URL', async () => {
        const result = await loadWorkforceMetadata(
            testInput({ employeeMetadataUrl: 'https://roster.example/staff.json' }),
            { fetchImpl: () => jsonResponse({ employees: EMPLOYEE_METADATA }) },
        );

        assert.equal(result.entries.length, 2);
        assert.deepEqual(result.origins, ['input-url']);
    });

    it('loads entries from a key-value store', async () => {
        const result = await loadWorkforceMetadata(testInput({ employeeMetadataStoreKey: 'ROSTER' }), {
            readStoreValue: async (_storeId, key) => (key === 'ROSTER' ? EMPLOYEE_METADATA : null),
        });

        assert.equal(result.entries.length, 2);
        assert.deepEqual(result.origins, ['key-value-store']);
    });

    it('merges several sources and reports the mix, with inline winning a conflict', async () => {
        const result = await loadWorkforceMetadata(
            testInput({
                employeeMetadata: [{ employeeId: 'E101', email: 'sarah@hospital.example', role: 'CHARGE_NURSE' }],
                employeeMetadataUrl: 'https://roster.example/staff.json',
            }),
            { fetchImpl: () => jsonResponse(EMPLOYEE_METADATA) },
        );

        assert.equal(result.origins.length, 2);
        const sarah = result.entries.find((entry) => entry.employee.employeeId === 'E101');
        assert.equal(sarah?.employee.role, 'CHARGE_NURSE');
        assert.equal(sarah?.origin, 'input-inline');
        assert.match(result.warnings.join(' '), /appears in more than one metadata source/);
    });

    it('supplies the demo roster in demo mode', async () => {
        const result = await loadWorkforceMetadata(testInput({ mode: 'demo', apiKey: '' }));

        assert.equal(result.entries.length, 12);
        assert.deepEqual(result.origins, ['demo']);
        assert.equal(result.entries[0]?.provenance, 'demo-workforce-metadata');
    });

    it('warns loudly when no metadata source is configured at all', async () => {
        const result = await loadWorkforceMetadata(testInput());

        assert.deepEqual(result.entries, []);
        assert.match(result.warnings.join(' '), /No workforce metadata source is configured/);
        assert.match(result.warnings.join(' '), /employeeMetadata/);
    });

    it('does not warn when demo fallback covers the gap', async () => {
        const result = await loadWorkforceMetadata(testInput({ mode: 'hybrid' }));

        assert.equal(result.warnings.join(' ').includes('No workforce metadata source'), false);
    });
});

describe('loadWorkforceMetadata - failures are loud, not silent', () => {
    it('fails when the metadata URL is unreachable', async () => {
        await assert.rejects(
            loadWorkforceMetadata(testInput({ employeeMetadataUrl: 'https://roster.example/staff.json' }), {
                fetchImpl: () => Promise.reject(new TypeError('fetch failed: ENOTFOUND')),
            }),
            (err: unknown) => {
                assert.ok(err instanceof MetadataSourceError);
                assert.equal(err.code, 'METADATA_SOURCE_ERROR');
                return true;
            },
        );
    });

    it('fails on a non-2xx metadata URL response', async () => {
        await assert.rejects(
            loadWorkforceMetadata(testInput({ employeeMetadataUrl: 'https://roster.example/staff.json' }), {
                fetchImpl: () => jsonResponse({ error: 'nope' }, 404),
            }),
            /HTTP 404/,
        );
    });

    it('fails when the metadata URL returns something that is not JSON', async () => {
        await assert.rejects(
            loadWorkforceMetadata(testInput({ employeeMetadataUrl: 'https://roster.example/staff.json' }), {
                fetchImpl: () => Promise.resolve(new Response('<html>oops</html>', { status: 200 })),
            }),
            /did not return valid JSON/,
        );
    });

    it('fails when the configured key-value store key is empty', async () => {
        await assert.rejects(
            loadWorkforceMetadata(testInput({ employeeMetadataStoreKey: 'ROSTER' }), {
                readStoreValue: async () => null,
            }),
            /holds no value/,
        );
    });

    it('fails when the key-value store itself errors', async () => {
        await assert.rejects(
            loadWorkforceMetadata(testInput({ employeeMetadataStoreKey: 'ROSTER' }), {
                readStoreValue: async () => {
                    throw new Error('store unavailable');
                },
            }),
            /Could not read employee metadata/,
        );
    });
});

describe('MetadataIndex', () => {
    const entries = [
        {
            employee: {
                employeeId: 'E101',
                email: 'sarah@hospital.example',
                calUsername: null,
                calUserId: null,
                name: null,
                role: 'ICU_NURSE',
                department: 'ICU',
                skills: ['ICU'],
                contractedHoursPerWeek: 36,
                availability: [],
            },
            origin: 'input-inline' as const,
            provenance: 'workforce-metadata' as const,
        },
        {
            employee: {
                employeeId: 'E102',
                email: null,
                calUsername: 'jonas-b',
                calUserId: null,
                name: null,
                role: 'ER_NURSE',
                department: 'ER',
                skills: [],
                contractedHoursPerWeek: null,
                availability: [],
            },
            origin: 'input-inline' as const,
            provenance: 'workforce-metadata' as const,
        },
        {
            employee: {
                employeeId: 'E103',
                email: null,
                calUsername: null,
                calUserId: 777,
                name: null,
                role: 'DOCTOR',
                department: 'ICU',
                skills: [],
                contractedHoursPerWeek: null,
                availability: [],
            },
            origin: 'input-inline' as const,
            provenance: 'workforce-metadata' as const,
        },
    ];

    it('matches on email, case-insensitively', () => {
        const index = new MetadataIndex(entries, false);
        assert.equal(index.lookup(person({ email: 'SARAH@hospital.example' }))?.employee.employeeId, 'E101');
    });

    it('falls back to username, then to the numeric ID', () => {
        const index = new MetadataIndex(entries, false);
        assert.equal(
            index.lookup(person({ email: null, username: 'JONAS-B', externalId: null }))?.employee.employeeId,
            'E102',
        );
        assert.equal(
            index.lookup(person({ email: null, username: null, externalId: 777 }))?.employee.employeeId,
            'E103',
        );
    });

    it('returns null for an unknown person when synthesis is off', () => {
        const index = new MetadataIndex(entries, false);
        assert.equal(
            index.lookup(person({ email: 'stranger@hospital.example', username: null, externalId: null })),
            null,
        );
    });

    it('synthesizes a clearly-labelled profile when synthesis is on', () => {
        const index = new MetadataIndex(entries, true);
        const match = index.lookup(person({ email: 'stranger@hospital.example', username: null, externalId: null }));

        assert.equal(match?.provenance, 'demo-workforce-metadata');
        assert.match(match?.employee.employeeId ?? '', /^DEMO-/);
    });

    it('reports roster entries that matched nobody', () => {
        const index = new MetadataIndex(entries, false);
        index.lookup(person({ email: 'sarah@hospital.example' }));

        const unmatched = index.unmatchedEntries().map((entry) => entry.employee.employeeId);
        assert.deepEqual(unmatched, ['E102', 'E103']);
    });
});

describe('ShiftTypeIndex', () => {
    const index = new ShiftTypeIndex([
        {
            eventTypeId: 900,
            eventTypeSlug: null,
            role: 'ICU_NURSE',
            department: 'ICU',
            requiredSkills: ['ICU'],
            provenance: 'workforce-metadata',
        },
        {
            eventTypeId: null,
            eventTypeSlug: 'er-day-shift',
            role: 'ER_NURSE',
            department: 'ER',
            requiredSkills: ['ER'],
            provenance: 'workforce-metadata',
        },
    ]);

    it('matches by ID and by slug, case-insensitively', () => {
        assert.equal(index.lookup(900, null)?.role, 'ICU_NURSE');
        assert.equal(index.lookup(null, 'ER-DAY-SHIFT')?.role, 'ER_NURSE');
    });

    it('prefers the ID when both are present', () => {
        assert.equal(index.lookup(900, 'er-day-shift')?.role, 'ICU_NURSE');
    });

    it('returns null when nothing matches', () => {
        assert.equal(index.lookup(123, 'unknown-shift'), null);
    });
});

describe('synthetic metadata', () => {
    it('is deterministic for the same person', () => {
        const first = synthesizeMetadata(person({ key: 'email:x@y.example' }));
        const second = synthesizeMetadata(person({ key: 'email:x@y.example' }));

        assert.deepEqual(first, second);
    });

    it('differs between people', () => {
        const a = synthesizeMetadata(person({ key: 'email:a@y.example' }));
        const b = synthesizeMetadata(person({ key: 'email:b@y.example' }));

        assert.notEqual(a.employeeId, b.employeeId);
    });

    it('never invents a name over the real one from the scheduling system', () => {
        assert.equal(synthesizeMetadata(person()).name, null);
    });

    it('describes the demo roster with unroutable email addresses', () => {
        const roster = demoRosterMetadata();

        assert.equal(roster.length, 12);
        for (const entry of roster) {
            assert.match(entry.email ?? '', /@demo\.hospital\.invalid$/, 'RFC 2606 reserves .invalid');
            assert.ok(entry.role !== null && entry.department !== null);
        }
    });

    it('hashes stably', () => {
        assert.equal(stableHash('abc'), stableHash('abc'));
        assert.notEqual(stableHash('abc'), stableHash('abd'));
    });
});
