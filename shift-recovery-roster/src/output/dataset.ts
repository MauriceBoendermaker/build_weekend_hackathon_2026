/**
 * Dataset output.
 *
 * Write order is part of the contract: workers, then shifts, then scheduling events, then
 * exactly one summary. The summary is last on purpose - if a run dies halfway, the dataset has
 * no summary and the decision layer can tell that what it is reading is incomplete rather than
 * final.
 *
 * The same summary also goes to the `SUMMARY` key-value store record, with a fuller
 * `RUN_REPORT` beside it, so an n8n workflow can check the outcome with one cheap request
 * instead of paging the dataset.
 */

import { Actor, log } from 'apify';

import type { AnyRecord, NormalizedBundle, SummaryRecord } from '../types.js';

export interface OutputDeps {
    /** Injected in tests. Defaults to `Actor.pushData`. */
    pushData?: (records: AnyRecord[]) => Promise<void>;
    /** Injected in tests. Defaults to `Actor.setValue`. */
    setValue?: (key: string, value: unknown) => Promise<void>;
}

export interface RunReport {
    summary: SummaryRecord;
    /** Per-resource page and record counts from the source adapter. */
    resources: Record<string, { pages: number; records: number; truncated: boolean }>;
    discarded: { kind: string; identifier: string; reason: string }[];
    rejected: { kind: string; identifier: string; reason: string }[];
    repaired: { kind: string; identifier: string; reason: string }[];
    /** Log-safe echo of the run configuration. Contains no credential. */
    configuration: Record<string, unknown>;
}

export async function writeOutput(
    bundle: NormalizedBundle,
    summary: SummaryRecord,
    report: RunReport,
    deps: OutputDeps = {},
): Promise<void> {
    const pushData = deps.pushData ?? ((records: AnyRecord[]) => Actor.pushData(records));
    const setValue = deps.setValue ?? ((key: string, value: unknown) => Actor.setValue(key, value));

    const records: AnyRecord[] = [...bundle.workers, ...bundle.shifts, ...bundle.events];
    if (records.length > 0) await pushData(records);

    // Always last, and always exactly one.
    await pushData([summary]);

    await setValue('SUMMARY', summary);
    await setValue('RUN_REPORT', report);

    log.info(
        `Dataset written: ${bundle.workers.length} worker(s), ${bundle.shifts.length} shift(s), ` +
            `${bundle.events.length} scheduling event(s), 1 summary (status=${summary.status})`,
    );
}

/** Writes only the failure summary, so a failed run still says why in the dataset. */
export async function writeFailure(summary: SummaryRecord, report: RunReport, deps: OutputDeps = {}): Promise<void> {
    const pushData = deps.pushData ?? ((records: AnyRecord[]) => Actor.pushData(records));
    const setValue = deps.setValue ?? ((key: string, value: unknown) => Actor.setValue(key, value));

    await pushData([summary]);
    await setValue('SUMMARY', summary);
    await setValue('RUN_REPORT', report);
}
