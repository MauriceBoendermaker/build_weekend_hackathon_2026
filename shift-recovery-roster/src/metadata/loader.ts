/**
 * Workforce metadata loading and lookup.
 *
 * Three interchangeable sources, merged in precedence order (inline wins, then URL, then
 * key-value store), plus an optional synthetic fallback. Whichever source an entry came from
 * travels with it, because the provenance ends up on the worker record.
 *
 * A configured metadata source that fails is a hard error, not a silent skip: a run that
 * quietly drops the roster would tell the decision layer that nobody has the ICU skill.
 */

import { Actor, log } from 'apify';

import { MetadataSourceError } from '../errors.js';
import {
    parseEmployeeMetadataList,
    type EmployeeMetadata,
    type ResolvedInput,
    type ShiftTypeMetadata,
} from '../input.js';
import type { Provenance } from '../types.js';
import type { SourcePerson } from '../sources/source.js';
import { demoRosterMetadata, demoShiftTypeMetadata, synthesizeMetadata } from './demo-metadata.js';

export type MetadataOrigin = 'input-inline' | 'input-url' | 'key-value-store' | 'demo';

export interface MetadataEntry {
    employee: EmployeeMetadata;
    origin: MetadataOrigin;
    provenance: Provenance;
}

export interface LoadedMetadata {
    entries: MetadataEntry[];
    /** Event-type-to-shift-requirement mappings, from the input and, in demo mode, the demo set. */
    shiftTypes: ShiftTypeMetadata[];
    origins: MetadataOrigin[];
    warnings: string[];
}

export interface MetadataLoaderDeps {
    /** Injected in tests. Defaults to the global fetch. */
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
    /** Injected in tests. Defaults to reading the Apify key-value store. */
    readStoreValue?: (storeId: string | null, key: string) => Promise<unknown>;
}

const URL_TIMEOUT_MS = 20_000;

export async function loadWorkforceMetadata(
    input: ResolvedInput,
    deps: MetadataLoaderDeps = {},
): Promise<LoadedMetadata> {
    const entries: MetadataEntry[] = [];
    const origins: MetadataOrigin[] = [];
    const warnings: string[] = [];
    const seenEmployeeIds = new Set<string>();

    const add = (employees: EmployeeMetadata[], origin: MetadataOrigin, provenance: Provenance): void => {
        let added = 0;
        for (const employee of employees) {
            // Earlier sources win, so a roster override in the run input beats the stored copy.
            if (seenEmployeeIds.has(employee.employeeId)) {
                warnings.push(
                    `Employee ${employee.employeeId} appears in more than one metadata source; ` +
                        `the ${entries.find((entry) => entry.employee.employeeId === employee.employeeId)?.origin ?? 'earlier'} entry was kept.`,
                );
                continue;
            }
            seenEmployeeIds.add(employee.employeeId);
            entries.push({ employee, origin, provenance });
            added += 1;
        }
        if (added > 0 && !origins.includes(origin)) origins.push(origin);
        if (added > 0) log.info(`Loaded ${added} workforce metadata entr${added === 1 ? 'y' : 'ies'} from ${origin}`);
    };

    add(input.employeeMetadata, 'input-inline', 'workforce-metadata');

    if (input.employeeMetadataUrl !== null) {
        add(await fetchMetadataFromUrl(input.employeeMetadataUrl, deps), 'input-url', 'workforce-metadata');
    }

    if (input.employeeMetadataStoreKey !== null) {
        add(
            await readMetadataFromStore(input.employeeMetadataStoreId, input.employeeMetadataStoreKey, deps),
            'key-value-store',
            'workforce-metadata',
        );
    }

    // The demo roster is only meaningful when the demo source produced the people it describes.
    const shiftTypes = [...input.shiftTypeMetadata];
    if (input.mode === 'demo') {
        add(demoRosterMetadata(), 'demo', 'demo-workforce-metadata');
        // Requirements for the demo event types, so the demo has role-aware uncovered shifts.
        // Operator-supplied mappings come first and therefore win in the index.
        shiftTypes.push(...demoShiftTypeMetadata());
    }

    if (entries.length === 0 && !input.useDemoWorkforceMetadata) {
        warnings.push(
            'No workforce metadata source is configured. Workers will carry real Cal.com identity but no ' +
                'employeeId, role, department, skills or contracted hours, which is usually not enough for ' +
                'eligibility rules. Configure "employeeMetadata", "employeeMetadataUrl" or ' +
                '"employeeMetadataStoreKey", or switch on "useDemoWorkforceMetadata" for a demo.',
        );
    }

    return { entries, shiftTypes, origins, warnings };
}

async function fetchMetadataFromUrl(url: string, deps: MetadataLoaderDeps): Promise<EmployeeMetadata[]> {
    const fetchImpl = deps.fetchImpl ?? ((target: string, init: RequestInit) => fetch(target, init));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: controller.signal,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new MetadataSourceError(`Could not fetch employee metadata from the configured URL: ${message}`, { url });
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        throw new MetadataSourceError(
            `The employee metadata URL returned HTTP ${response.status}. Fix the URL or remove it from the input.`,
            { url, status: response.status },
        );
    }

    let payload: unknown;
    try {
        payload = JSON.parse(await response.text());
    } catch {
        throw new MetadataSourceError('The employee metadata URL did not return valid JSON.', { url });
    }

    return parseEmployeeMetadataList(payload, 'employeeMetadataUrl');
}

async function readMetadataFromStore(
    storeId: string | null,
    key: string,
    deps: MetadataLoaderDeps,
): Promise<EmployeeMetadata[]> {
    const read =
        deps.readStoreValue ??
        (async (id: string | null, valueKey: string) => {
            const store = id === null ? await Actor.openKeyValueStore() : await Actor.openKeyValueStore(id);
            return store.getValue(valueKey);
        });

    let value: unknown;
    try {
        value = await read(storeId, key);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new MetadataSourceError(`Could not read employee metadata from the key-value store: ${message}`, {
            storeId,
            key,
        });
    }

    if (value === null || value === undefined) {
        throw new MetadataSourceError(
            `Key "${key}" holds no value in ${storeId === null ? "the run's key-value store" : `key-value store "${storeId}"`}.`,
            { storeId, key },
        );
    }

    return parseEmployeeMetadataList(value, `key-value-store:${key}`);
}

/** Case-insensitive, multi-key lookup from a Cal.com person to a metadata entry. */
export class MetadataIndex {
    private readonly byEmail = new Map<string, MetadataEntry>();

    private readonly byUsername = new Map<string, MetadataEntry>();

    private readonly byUserId = new Map<number, MetadataEntry>();

    /** Entries that never matched anybody in the snapshot. */
    private readonly matched = new Set<string>();

    constructor(
        private readonly entries: MetadataEntry[],
        private readonly synthesize: boolean,
    ) {
        for (const entry of entries) {
            const { employee } = entry;
            if (employee.email !== null && !this.byEmail.has(employee.email)) this.byEmail.set(employee.email, entry);
            if (employee.calUsername !== null && !this.byUsername.has(employee.calUsername)) {
                this.byUsername.set(employee.calUsername, entry);
            }
            if (employee.calUserId !== null && !this.byUserId.has(employee.calUserId)) {
                this.byUserId.set(employee.calUserId, entry);
            }
        }
    }

    /**
     * Resolves metadata for a person, preferring email, then username, then the numeric ID.
     * Returns null when nothing matches and synthesis is off.
     */
    lookup(person: SourcePerson): MetadataEntry | null {
        const email = person.email === null ? null : person.email.toLowerCase();
        const username = person.username === null ? null : person.username.toLowerCase();

        const match =
            (email === null ? undefined : this.byEmail.get(email)) ??
            (username === null ? undefined : this.byUsername.get(username)) ??
            (person.externalId === null ? undefined : this.byUserId.get(person.externalId));

        if (match !== undefined) {
            this.matched.add(match.employee.employeeId);
            return match;
        }
        if (!this.synthesize) return null;
        return {
            employee: synthesizeMetadata(person),
            origin: 'demo',
            provenance: 'demo-workforce-metadata',
        };
    }

    /** Roster entries that matched nobody: usually a typo in an email or a stale roster. */
    unmatchedEntries(): MetadataEntry[] {
        return this.entries.filter((entry) => !this.matched.has(entry.employee.employeeId));
    }
}

/** Lookup from a Cal.com event type to the shift requirements it represents. */
export class ShiftTypeIndex {
    private readonly byId = new Map<number, ShiftTypeMetadata>();

    private readonly bySlug = new Map<string, ShiftTypeMetadata>();

    constructor(entries: ShiftTypeMetadata[]) {
        for (const entry of entries) {
            if (entry.eventTypeId !== null) this.byId.set(entry.eventTypeId, entry);
            if (entry.eventTypeSlug !== null) this.bySlug.set(entry.eventTypeSlug, entry);
        }
    }

    lookup(eventTypeId: number | null, eventTypeSlug: string | null): ShiftTypeMetadata | null {
        if (eventTypeId !== null) {
            const byId = this.byId.get(eventTypeId);
            if (byId !== undefined) return byId;
        }
        if (eventTypeSlug !== null) {
            const bySlug = this.bySlug.get(eventTypeSlug.toLowerCase());
            if (bySlug !== undefined) return bySlug;
        }
        return null;
    }

    get size(): number {
        return this.byId.size + this.bySlug.size;
    }
}
