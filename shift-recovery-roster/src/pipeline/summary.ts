/**
 * The summary record.
 *
 * This is the contract that lets the decision layer trust the dataset. An empty dataset is
 * ambiguous on its own - it could mean a quiet week or a dead API - so every run appends
 * exactly one summary saying which it was, and it is always the last item written. If the
 * summary is missing, the run did not finish and the dataset must not be trusted.
 */

import type { RosterError } from '../errors.js';
import type { ResolvedInput } from '../input.js';
import type { MetadataOrigin } from '../metadata/loader.js';
import type { RawSnapshot } from '../sources/source.js';
import type { NormalizedBundle, RunCounts, RunStatus, SummaryRecord } from '../types.js';

/** Bumped by hand alongside `version` in `.actor/actor.json`. */
export const ACTOR_VERSION = '1.0.0';

export interface SummaryContext {
    input: ResolvedInput;
    /** Null when retrieval failed before a snapshot existed. */
    snapshot: RawSnapshot | null;
    bundle: NormalizedBundle;
    metadataOrigins: MetadataOrigin[];
    discardedCount: number;
    rejectedCount: number;
    duplicatesDropped: number;
    workersWithoutMetadata: number;
    warnings: string[];
    durationMs: number;
    retrievedAt: string;
    error?: RosterError | null;
}

export function buildSummary(context: SummaryContext): SummaryRecord {
    const { input, snapshot, bundle, error } = context;
    const failed = error != null;

    const counts: RunCounts = {
        pagesFetched: snapshot?.stats.pagesFetched ?? 0,
        apiRequests: snapshot?.stats.apiRequests ?? 0,
        rawEventsRetrieved: snapshot?.events.length ?? 0,
        rawWorkersDiscovered: snapshot?.people.length ?? 0,
        workersRetrieved: bundle.workers.length,
        shiftsRetrieved: bundle.shifts.length,
        eventsRetrieved: bundle.events.length,
        recordsNormalized: bundle.workers.length + bundle.shifts.length + bundle.events.length,
        recordsDiscarded: context.discardedCount + context.rejectedCount,
        duplicatesDropped: context.duplicatesDropped,
        workersWithoutMetadata: context.workersWithoutMetadata,
    };

    const status: RunStatus = failed ? 'failure' : resolveStatus(snapshot, counts);
    const emptyResult = !failed && counts.workersRetrieved === 0;

    const warnings = [...context.warnings];
    if (emptyResult) {
        warnings.push(
            'The source responded successfully but produced zero worker records. This is an EMPTY SUCCESS, ' +
                'not a failure: check the time window and the scope filters before concluding that no staff exist.',
        );
    }

    return {
        recordType: 'summary',
        status,
        mode: input.mode,
        sourceSystem: snapshot?.sourceSystem ?? (input.mode === 'demo' ? 'demo' : 'cal.com'),
        source: snapshot?.sourceSystem === 'demo' ? 'demo' : 'cal.com',
        workforceMetadataSource: resolveMetadataSource(context.metadataOrigins),
        dateRange: { start: input.range.start, end: input.range.end },
        counts,
        emptyResult,
        warnings: dedupe(warnings),
        errorCode: error?.code ?? null,
        // RosterError already redacts its message, so this is safe to publish.
        errorMessage: error?.message ?? null,
        synthetic: snapshot?.sourceSystem === 'demo' || input.mode === 'demo',
        retrievedAt: context.retrievedAt,
        durationMs: context.durationMs,
        actorVersion: ACTOR_VERSION,
    };
}

function resolveStatus(snapshot: RawSnapshot | null, counts: RunCounts): RunStatus {
    if (snapshot === null) return 'failure';
    if (!snapshot.complete) return 'partial';
    // Records thrown away mean the snapshot no longer represents everything the source holds.
    if (counts.recordsDiscarded > 0) return 'partial';
    return 'success';
}

function resolveMetadataSource(origins: MetadataOrigin[]): SummaryRecord['workforceMetadataSource'] {
    if (origins.length === 0) return 'none';
    if (origins.length > 1) return 'mixed';
    return origins[0] as SummaryRecord['workforceMetadataSource'];
}

function dedupe(values: string[]): string[] {
    return [...new Set(values)];
}
