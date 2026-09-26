/**
 * Output validation.
 *
 * The last gate before the dataset. It enforces the part of the contract that downstream
 * automation cannot work around - a record without an ID, or with a broken timestamp, would
 * make the decision layer do something wrong rather than fail loudly.
 *
 * It is deliberately permissive about everything else. A worker with no role is still a worker
 * worth reporting; a shift with no required skills is still a real gap in the rota. Missing
 * optional data is normalized to `null` or `[]` and the record survives, because dropping
 * partial scheduling data loses information the agent needs.
 */

import { log } from 'apify';

import type { NormalizedBundle, SchedulingEventRecord, ShiftRecord, TimeWindow, WorkerRecord } from '../types.js';

export interface ValidationIssue {
    kind: 'worker' | 'shift' | 'schedulingEvent';
    identifier: string;
    reason: string;
}

export interface ValidationResult {
    bundle: NormalizedBundle;
    /** Records rejected outright. */
    rejected: ValidationIssue[];
    /** Records kept after a value was repaired, e.g. a malformed availability window removed. */
    repaired: ValidationIssue[];
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function validateBundle(bundle: NormalizedBundle): ValidationResult {
    const rejected: ValidationIssue[] = [];
    const repaired: ValidationIssue[] = [];

    const workers = bundle.workers.filter((worker) => validateWorker(worker, rejected, repaired));
    const shifts = bundle.shifts.filter((shift) => validateShift(shift, rejected));
    const events = bundle.events.filter((event) => validateEvent(event, rejected));

    if (rejected.length > 0) {
        log.warning(
            `Validation rejected ${rejected.length} record(s): ` +
                rejected
                    .slice(0, 5)
                    .map((issue) => `${issue.kind} ${issue.identifier} (${issue.reason})`)
                    .join('; '),
        );
    }
    if (repaired.length > 0) {
        log.warning(`Validation repaired ${repaired.length} record(s) rather than discarding them.`);
    }

    return { bundle: { workers, shifts, events }, rejected, repaired };
}

function validateWorker(worker: WorkerRecord, rejected: ValidationIssue[], repaired: ValidationIssue[]): boolean {
    const reject = (reason: string): false => {
        rejected.push({ kind: 'worker', identifier: worker.employeeId || '(no employeeId)', reason });
        return false;
    };

    if (typeof worker.employeeId !== 'string' || worker.employeeId.trim() === '') {
        return reject('employeeId is missing, so nothing downstream could join on this worker');
    }
    // A worker with neither an email nor a name cannot be contacted or identified by a human,
    // which makes the record actively misleading in a call-out workflow.
    if (worker.email === null && worker.name === null) {
        return reject('neither an email address nor a name is known, so the worker cannot be contacted');
    }
    if (worker.email !== null && !looksLikeEmail(worker.email)) {
        return reject(`email ${JSON.stringify(worker.email)} is not a valid address`);
    }
    if (!isIsoUtc(worker.retrievedAt)) return reject('retrievedAt is not an ISO-8601 UTC timestamp');

    // Repairs: drop only the broken parts, keep the worker.
    const validWindows = worker.availability.filter((window) => isValidWindow(window));
    if (validWindows.length !== worker.availability.length) {
        repaired.push({
            kind: 'worker',
            identifier: worker.employeeId,
            reason: `${worker.availability.length - validWindows.length} malformed availability window(s) removed`,
        });
        worker.availability = validWindows;
    }
    if (worker.hoursThisWeek !== null && (!Number.isFinite(worker.hoursThisWeek) || worker.hoursThisWeek < 0)) {
        repaired.push({
            kind: 'worker',
            identifier: worker.employeeId,
            reason: 'hoursThisWeek was not a valid number',
        });
        worker.hoursThisWeek = null;
    }
    if (!Array.isArray(worker.skills)) {
        repaired.push({ kind: 'worker', identifier: worker.employeeId, reason: 'skills was not an array' });
        worker.skills = [];
    }

    return true;
}

function validateShift(shift: ShiftRecord, rejected: ValidationIssue[]): boolean {
    const reject = (reason: string): false => {
        rejected.push({ kind: 'shift', identifier: shift.shiftId || '(no shiftId)', reason });
        return false;
    };

    if (typeof shift.shiftId !== 'string' || shift.shiftId.trim() === '') return reject('shiftId is missing');
    if (!isIsoUtc(shift.start)) return reject(`start ${JSON.stringify(shift.start)} is not an ISO-8601 UTC timestamp`);
    if (!isIsoUtc(shift.end)) return reject(`end ${JSON.stringify(shift.end)} is not an ISO-8601 UTC timestamp`);
    if (Date.parse(shift.end) <= Date.parse(shift.start)) return reject('end is at or before start');
    if (!Number.isFinite(shift.durationMinutes) || shift.durationMinutes <= 0) {
        return reject(`durationMinutes ${shift.durationMinutes} is not a positive number`);
    }
    if (shift.coverageStatus === 'covered' && shift.assignedEmployeeId === null) {
        return reject('coverageStatus is "covered" but no employee is assigned');
    }
    return true;
}

function validateEvent(event: SchedulingEventRecord, rejected: ValidationIssue[]): boolean {
    const reject = (reason: string): false => {
        rejected.push({ kind: 'schedulingEvent', identifier: event.eventId || '(no eventId)', reason });
        return false;
    };

    if (typeof event.eventId !== 'string' || event.eventId.trim() === '') return reject('eventId is missing');
    if (!isIsoUtc(event.start)) return reject('start is not an ISO-8601 UTC timestamp');
    if (!isIsoUtc(event.end)) return reject('end is not an ISO-8601 UTC timestamp');
    if (Date.parse(event.end) <= Date.parse(event.start)) return reject('end is at or before start');
    return true;
}

export function isIsoUtc(value: unknown): boolean {
    return typeof value === 'string' && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function isValidWindow(window: TimeWindow): boolean {
    return isIsoUtc(window.start) && isIsoUtc(window.end) && Date.parse(window.end) > Date.parse(window.start);
}

/**
 * Deliberately loose: this checks that a value is shaped like an address, not that it is
 * deliverable. Rejecting an unusual but valid address would remove a reachable worker.
 */
export function looksLikeEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}
