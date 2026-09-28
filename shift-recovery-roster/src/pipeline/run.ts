/**
 * The pipeline, assembled.
 *
 *   SOURCE -> FETCH -> NORMALIZE -> ENRICH -> DEDUPE -> VALIDATE -> DATASET
 *
 * Kept separate from `main.ts` so the whole thing can be exercised in a test with a mocked
 * source and mocked output, without an Actor runtime.
 */

import { log } from 'apify';

import { EmptyResultError } from '../errors.js';
import { sourceSystemFor, type ResolvedInput } from '../input.js';
import { loadWorkforceMetadata, MetadataIndex, ShiftTypeIndex, type MetadataLoaderDeps } from '../metadata/loader.js';
import { writeOutput, type OutputDeps, type RunReport } from '../output/dataset.js';
import { CalComSource } from '../sources/calcom/source.js';
import { DemoRosterSource } from '../sources/demo/source.js';
import { IcalSource } from '../sources/ical/source.js';
import type { RosterSource } from '../sources/source.js';
import type { NormalizedBundle, SummaryRecord } from '../types.js';
import { dedupeBundle } from './dedupe.js';
import { normalize } from './normalize.js';
import { buildSummary } from './summary.js';
import { validateBundle } from './validate.js';

export interface RunDeps {
    /** Overrides the source factory; used to drive the pipeline from fixtures in tests. */
    source?: RosterSource;
    metadata?: MetadataLoaderDeps;
    output?: OutputDeps;
    configuration?: Record<string, unknown>;
}

export interface RunResult {
    summary: SummaryRecord;
    bundle: NormalizedBundle;
    report: RunReport;
}

/** Picks the adapter for the configured mode. The only place a source is chosen. */
export function createSource(input: ResolvedInput): RosterSource {
    const system = sourceSystemFor(input);
    if (system === 'demo') return new DemoRosterSource(input);
    if (system === 'ical') return new IcalSource({ input });
    return new CalComSource({ input });
}

export async function runPipeline(input: ResolvedInput, deps: RunDeps = {}): Promise<RunResult> {
    const startedAt = Date.now();
    const retrievedAt = new Date(startedAt).toISOString();

    const source = deps.source ?? createSource(input);
    log.info(`Source adapter: ${source.id}`);

    // FETCH - throws a typed error rather than returning partial data.
    const snapshot = await source.fetch();
    log.info(
        `Snapshot: ${snapshot.people.length} person record(s), ${snapshot.events.length} scheduling event(s), ` +
            `${snapshot.shiftTypes.length} shift type(s), ${snapshot.stats.pagesFetched} page(s) over ` +
            `${snapshot.stats.apiRequests} API request(s)`,
    );

    // ENRICH - workforce metadata that the scheduling system cannot supply.
    const metadata = await loadWorkforceMetadata(input, deps.metadata);
    const metadataIndex = new MetadataIndex(metadata.entries, input.useDemoWorkforceMetadata);
    const shiftTypeIndex = new ShiftTypeIndex(metadata.shiftTypes);

    // NORMALIZE
    const normalized = normalize(snapshot, {
        input,
        metadata: metadataIndex,
        shiftTypes: shiftTypeIndex,
        retrievedAt,
    });

    // DEDUPE
    const deduped = dedupeBundle(normalized.bundle);
    if (deduped.duplicatesDropped > 0) {
        log.info(`Deduplication merged ${deduped.duplicatesDropped} duplicate record(s)`);
    }

    // VALIDATE
    const validated = validateBundle(deduped.bundle);

    const warnings = [...snapshot.warnings, ...metadata.warnings, ...normalized.warnings];
    const summary = buildSummary({
        input,
        snapshot,
        bundle: validated.bundle,
        metadataOrigins: metadata.origins,
        discardedCount: normalized.discarded.length,
        rejectedCount: validated.rejected.length,
        duplicatesDropped: deduped.duplicatesDropped,
        workersWithoutMetadata: normalized.workersWithoutMetadata,
        warnings,
        durationMs: Date.now() - startedAt,
        retrievedAt,
    });

    const report: RunReport = {
        summary,
        resources: snapshot.stats.resources,
        discarded: normalized.discarded,
        rejected: validated.rejected,
        repaired: validated.repaired,
        configuration: deps.configuration ?? {},
    };

    // DATASET
    await writeOutput(validated.bundle, summary, report, deps.output);

    logRunSummary(summary);

    // The dataset is already written, so an operator can see exactly what an empty run produced
    // before the run is marked failed.
    if (input.failOnEmptyResult && summary.emptyResult) {
        throw new EmptyResultError(
            'The source responded successfully but produced zero worker records, and "failOnEmptyResult" is on. ' +
                'Widen the time window, relax the scope filters, or check that the API key can see the team.',
            { dateRange: summary.dateRange },
        );
    }

    return { summary, bundle: validated.bundle, report };
}

function logRunSummary(summary: SummaryRecord): void {
    const { counts } = summary;
    log.info('--- Run summary -------------------------------------------------');
    log.info(`  status                 ${summary.status}${summary.emptyResult ? ' (EMPTY SUCCESS)' : ''}`);
    log.info(`  source                 ${summary.sourceSystem} (mode=${summary.mode})`);
    log.info(`  workforce metadata     ${summary.workforceMetadataSource}`);
    log.info(`  window                 ${summary.dateRange.start} .. ${summary.dateRange.end}`);
    log.info(`  api requests / pages   ${counts.apiRequests} / ${counts.pagesFetched}`);
    log.info(`  raw from source        ${counts.rawWorkersDiscovered} people, ${counts.rawEventsRetrieved} events`);
    log.info(`  normalized             ${counts.recordsNormalized} record(s)`);
    log.info(`  discarded              ${counts.recordsDiscarded}`);
    log.info(`  duplicates merged      ${counts.duplicatesDropped}`);
    log.info(`  final workers          ${counts.workersRetrieved}`);
    log.info(`  final shifts           ${counts.shiftsRetrieved}`);
    log.info(`  final events           ${counts.eventsRetrieved}`);
    log.info(`  workers w/o metadata   ${counts.workersWithoutMetadata}`);
    log.info(`  duration               ${summary.durationMs} ms`);
    for (const warning of summary.warnings) log.warning(`  ! ${warning}`);
    log.info('-----------------------------------------------------------------');
}
