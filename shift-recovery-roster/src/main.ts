/**
 * Actor entry point.
 *
 * Deliberately thin: read input, run the pipeline, report the outcome. All the logic lives in
 * `src/pipeline/run.ts` so it can be tested without an Actor runtime.
 *
 * The failure path matters as much as the happy path. This Actor is the sensing layer of an
 * autonomous workflow, so an API outage must never look like "there are no staff available".
 * Any failure writes a `summary` record with `status: "failure"` and a machine-readable
 * `errorCode`, then fails the run - so both the Actor run status and the dataset say the same
 * thing.
 */

import { Actor, log } from 'apify';

import { toRosterError } from './errors.js';
import { describeConfig, parseInput, type ResolvedInput } from './input.js';
import { writeFailure } from './output/dataset.js';
import { runPipeline } from './pipeline/run.js';
import { buildSummary } from './pipeline/summary.js';

await Actor.init();

const startedAt = Date.now();
let resolvedInput: ResolvedInput | null = null;

try {
    resolvedInput = parseInput(await Actor.getInput());
    if (resolvedInput.debug) log.setLevel(log.LEVELS.DEBUG);

    const configuration = describeConfig(resolvedInput);
    // Never log the raw input: it carries the API key. This view has it reduced to a boolean.
    log.info('Run configuration', configuration);

    const { summary } = await runPipeline(resolvedInput, { configuration });

    await Actor.exit({
        statusMessage:
            `${summary.status}: ${summary.counts.workersRetrieved} worker(s), ` +
            `${summary.counts.shiftsRetrieved} shift(s), ${summary.counts.eventsRetrieved} event(s) from ` +
            `${summary.sourceSystem}${summary.emptyResult ? ' (empty but successful)' : ''}`,
    });
} catch (err) {
    const error = toRosterError(err);
    log.error(`Run failed [${error.code}]: ${error.message}`, error.context);

    if (resolvedInput !== null) {
        const summary = buildSummary({
            input: resolvedInput,
            snapshot: null,
            bundle: { workers: [], shifts: [], events: [] },
            metadataOrigins: [],
            discardedCount: 0,
            rejectedCount: 0,
            duplicatesDropped: 0,
            workersWithoutMetadata: 0,
            warnings: [
                'This run FAILED. The dataset holds no roster data - do not interpret it as "no staff available".',
            ],
            durationMs: Date.now() - startedAt,
            retrievedAt: new Date(startedAt).toISOString(),
            error,
        });

        // Best effort: a broken storage backend must not mask the original failure.
        try {
            await writeFailure(summary, {
                summary,
                resources: {},
                discarded: [],
                rejected: [],
                repaired: [],
                configuration: describeConfig(resolvedInput),
            });
        } catch (writeErr) {
            log.warning(`Could not persist the failure summary: ${toRosterError(writeErr).message}`);
        }
    }

    await Actor.fail({ statusMessage: `${error.code}: ${error.message}`.slice(0, 1000) });
}
