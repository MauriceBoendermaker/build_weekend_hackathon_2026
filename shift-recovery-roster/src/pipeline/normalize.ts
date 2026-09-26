/**
 * Normalization.
 *
 * Takes a source-shaped {@link RawSnapshot} and produces the stable output contract, joining in
 * workforce metadata as it goes. Three invariants govern everything here:
 *
 * - **Identifiers are deterministic.** The same worker or shift always gets the same ID, in
 *   this run and the next, so the decision layer can join across runs. Nothing is random.
 * - **Provenance is preserved.** Every value records where it came from in `fieldSources`. A
 *   role that came from the roster file is never presented as something Cal.com returned.
 * - **Absent means absent.** A value the sources do not have is `null` or `[]`, never a guess
 *   and never a silently dropped key.
 */

import { log } from 'apify';

import type { ResolvedInput } from '../input.js';
import { stableHash } from '../metadata/demo-metadata.js';
import type { MetadataEntry, MetadataIndex, ShiftTypeIndex } from '../metadata/loader.js';
import type { RawSnapshot, SourceEvent, SourcePerson } from '../sources/source.js';
import { clipToRange, durationMinutes, isoWeekBounds, mergeWindows, overlapMs, toIsoUtc } from '../time.js';
import type {
    CoverageStatus,
    EventParticipant,
    NormalizedBundle,
    Provenance,
    SchedulingEventRecord,
    ShiftRecord,
    ShiftStatus,
    SourceSystem,
    TimeWindow,
    WorkerRecord,
} from '../types.js';

/** A record the pipeline refused to emit, with the reason, for the run report. */
export interface DiscardedRecord {
    kind: 'event' | 'worker';
    identifier: string;
    reason: string;
}

export interface NormalizeContext {
    input: ResolvedInput;
    metadata: MetadataIndex;
    shiftTypes: ShiftTypeIndex;
    /** ISO-8601 UTC timestamp stamped onto every record in this run. */
    retrievedAt: string;
}

export interface NormalizeResult {
    bundle: NormalizedBundle;
    discarded: DiscardedRecord[];
    warnings: string[];
    workersWithoutMetadata: number;
}

const MS_PER_HOUR = 3_600_000;

/** Cal.com booking statuses mapped onto the output contract. */
const STATUS_MAP: Record<string, ShiftStatus> = {
    accepted: 'scheduled',
    pending: 'pending',
    awaiting_host: 'pending',
    cancelled: 'cancelled',
    canceled: 'cancelled',
    rejected: 'cancelled',
};

export function normalize(snapshot: RawSnapshot, context: NormalizeContext): NormalizeResult {
    const discarded: DiscardedRecord[] = [];
    const warnings: string[] = [];

    const identities = resolveIdentities(snapshot, context);
    const events = normalizeEvents(snapshot, context, identities, discarded);
    const shifts = buildShifts(events, snapshot, context, identities);
    const { workers, withoutMetadata } = buildWorkers(snapshot, context, identities, shifts, warnings);

    log.info(
        `Normalized ${workers.length} worker(s), ${shifts.length} shift(s), ${events.length} scheduling event(s); ` +
            `${discarded.length} source record(s) discarded`,
    );

    return {
        bundle: { workers, shifts, events: context.input.emitSchedulingEvents ? events : [] },
        discarded,
        warnings,
        workersWithoutMetadata: withoutMetadata,
    };
}

/** Resolved identity of one person: who they are in the source and in the workforce. */
interface Identity {
    person: SourcePerson;
    employeeId: string;
    metadata: MetadataEntry | null;
    /** Where the employee ID came from. */
    employeeIdProvenance: Provenance;
}

/**
 * Builds the person-key -> identity map.
 *
 * A worker's `employeeId` is the join key for the whole downstream workflow, so it is resolved
 * once, up front, and reused everywhere. When no roster entry supplies one, a deterministic ID
 * is derived from the source's own stable identifiers - deterministic so that re-running the
 * Actor does not renumber the workforce.
 */
function resolveIdentities(snapshot: RawSnapshot, context: NormalizeContext): Map<string, Identity> {
    const identities = new Map<string, Identity>();
    const prefix = idPrefix(snapshot.sourceSystem);

    for (const person of snapshot.people) {
        const metadata = context.metadata.lookup(person);
        const employeeId = metadata?.employee.employeeId ?? derivedEmployeeId(person, prefix);
        identities.set(person.key, {
            person,
            employeeId,
            metadata,
            employeeIdProvenance: metadata === null ? 'derived:source-identity' : metadata.provenance,
        });
    }
    return identities;
}

function idPrefix(sourceSystem: SourceSystem): string {
    return sourceSystem === 'cal.com' ? 'CAL' : 'DEMO';
}

/** Deterministic fallback employee ID, derived from the most stable identifier available. */
export function derivedEmployeeId(person: SourcePerson, prefix: string): string {
    if (person.externalId !== null) return `${prefix}-U${person.externalId}`;
    if (person.email !== null && person.email.trim() !== '') {
        return `${prefix}-E${stableHash(person.email.toLowerCase()).toString(36)}`;
    }
    if (person.username !== null && person.username.trim() !== '') {
        return `${prefix}-N${stableHash(person.username.toLowerCase()).toString(36)}`;
    }
    return `${prefix}-K${stableHash(person.key).toString(36)}`;
}

function normalizeEvents(
    snapshot: RawSnapshot,
    context: NormalizeContext,
    identities: Map<string, Identity>,
    discarded: DiscardedRecord[],
): SchedulingEventRecord[] {
    const records: SchedulingEventRecord[] = [];
    const { range } = context.input;
    const provenance: Provenance = snapshot.sourceSystem === 'demo' ? 'demo' : 'cal.com';

    for (const event of snapshot.events) {
        const identifier = eventIdentifier(event);
        const start = toIsoUtc(event.start);
        const end = toIsoUtc(event.end);

        if (start === null || end === null) {
            discarded.push({
                kind: 'event',
                identifier,
                reason: `unparseable start/end (${JSON.stringify(event.start)} .. ${JSON.stringify(event.end)})`,
            });
            continue;
        }
        if (Date.parse(end) <= Date.parse(start)) {
            discarded.push({ kind: 'event', identifier, reason: `end (${end}) is at or before start (${start})` });
            continue;
        }
        // Keep anything that overlaps the window, not just what starts inside it: a shift that
        // began before the window still consumes hours inside it.
        if (overlapMs(Date.parse(start), Date.parse(end), range.startMs, range.endMs) === 0) {
            discarded.push({ kind: 'event', identifier, reason: `outside the requested window (${start} .. ${end})` });
            continue;
        }

        const participants = buildParticipants(event, identities);
        const primaryHost = event.hosts[0];
        const primaryIdentity =
            primaryHost?.key === null || primaryHost?.key === undefined ? undefined : identities.get(primaryHost.key);

        records.push({
            recordType: 'schedulingEvent',
            eventId: `EVT-${idPrefix(snapshot.sourceSystem)}-${identifier}`,
            name: event.title ?? null,
            start,
            end,
            durationMinutes: event.durationMinutes ?? durationMinutes(start, end),
            status: (event.status ?? 'unknown').toLowerCase(),
            participants,
            primaryWorkerEmployeeId: primaryIdentity?.employeeId ?? null,
            sourceSystem: snapshot.sourceSystem,
            sourceIds: {
                bookingId: event.externalId,
                bookingUid: event.uid,
                eventTypeId: event.eventTypeId,
                eventTypeSlug: event.eventTypeSlug,
            },
            source: provenance,
            synthetic: snapshot.sourceSystem === 'demo',
            retrievedAt: context.retrievedAt,
            lastUpdated: toIsoUtc(event.updatedAt) ?? toIsoUtc(event.createdAt),
            fieldSources: {
                start: provenance,
                end: provenance,
                status: provenance,
                participants: provenance,
                primaryWorkerEmployeeId:
                    primaryIdentity === undefined ? 'derived:source-identity' : primaryIdentity.employeeIdProvenance,
            },
        });
    }
    return records;
}

/** Stable identifier for an event: the source's own UID first, then a content hash. */
export function eventIdentifier(event: SourceEvent): string {
    if (event.uid !== null && event.uid.trim() !== '') return event.uid.trim();
    if (event.externalId !== null) return String(event.externalId);
    // No stable ID in the source: derive one from the content so re-runs agree.
    const basis = [
        event.eventTypeId ?? '',
        event.eventTypeSlug ?? '',
        String(event.start ?? ''),
        String(event.end ?? ''),
        event.hosts[0]?.email ?? event.hosts[0]?.username ?? '',
    ].join('|');
    return `H${stableHash(basis).toString(36)}`;
}

function buildParticipants(event: SourceEvent, identities: Map<string, Identity>): EventParticipant[] {
    const participants: EventParticipant[] = [];
    for (const host of event.hosts) {
        participants.push({
            name: host.name,
            email: host.email,
            participantRole: 'host',
            employeeId: host.key === null ? null : (identities.get(host.key)?.employeeId ?? null),
            timeZone: host.timeZone,
        });
    }
    for (const attendee of event.attendees) {
        participants.push({
            name: attendee.name,
            email: attendee.email,
            participantRole: 'attendee',
            // Attendees are the counterparty, not staff: they are never given an employee ID.
            employeeId: null,
            timeZone: attendee.timeZone,
        });
    }
    return participants;
}

/**
 * Derives shift records from scheduling events.
 *
 * A shift is the operational view of a booking: when it is, what it needs, and who holds it.
 * Role, department and required skills come from the shift-type mapping when one is
 * configured, otherwise they fall back to the assignee's own role and department - labelled as
 * a derivation, not as source data.
 */
function buildShifts(
    events: SchedulingEventRecord[],
    snapshot: RawSnapshot,
    context: NormalizeContext,
    identities: Map<string, Identity>,
): ShiftRecord[] {
    const provenance: Provenance = snapshot.sourceSystem === 'demo' ? 'demo' : 'cal.com';
    const eventsBySourceId = new Map(snapshot.events.map((event) => [eventIdentifier(event), event]));
    const identityByEmployeeId = new Map([...identities.values()].map((identity) => [identity.employeeId, identity]));
    const nowMs = Date.parse(context.retrievedAt);

    return events.map((event) => {
        const identifier = event.eventId.replace(/^EVT-[A-Z]+-/, '');
        const sourceEvent = eventsBySourceId.get(identifier);
        const shiftType = context.shiftTypes.lookup(event.sourceIds.eventTypeId, event.sourceIds.eventTypeSlug);
        const assignee =
            event.primaryWorkerEmployeeId === null
                ? undefined
                : identityByEmployeeId.get(event.primaryWorkerEmployeeId);

        const status = resolveShiftStatus(event.status, Date.parse(event.end), nowMs);
        const fieldSources: Record<string, Provenance> = {
            start: provenance,
            end: provenance,
            status: provenance,
        };

        let role: string | null = null;
        let department: string | null = null;
        let requiredSkills: string[] = [];
        if (shiftType !== null) {
            role = shiftType.role;
            department = shiftType.department;
            requiredSkills = [...shiftType.requiredSkills];
            if (role !== null) fieldSources.role = shiftType.provenance;
            if (department !== null) fieldSources.department = shiftType.provenance;
            if (requiredSkills.length > 0) fieldSources.requiredSkills = shiftType.provenance;
        }
        // Fall back to the assignee's profile so a shift is never role-less when we do know who
        // holds it - but say plainly that it was inferred.
        if (role === null && assignee?.metadata != null) {
            role = assignee.metadata.employee.role;
            if (role !== null) fieldSources.role = 'derived:assigned-worker';
        }
        if (department === null && assignee?.metadata != null) {
            department = assignee.metadata.employee.department;
            if (department !== null) fieldSources.department = 'derived:assigned-worker';
        }

        const assignedEmployeeId = status === 'cancelled' ? null : (event.primaryWorkerEmployeeId ?? null);
        if (assignedEmployeeId !== null) {
            fieldSources.assignedEmployeeId = assignee?.employeeIdProvenance ?? 'derived:source-identity';
        }

        const coverageStatus: CoverageStatus = assignedEmployeeId === null ? 'uncovered' : 'covered';

        return {
            recordType: 'shift',
            shiftId: `SHIFT-${idPrefix(snapshot.sourceSystem)}-${identifier}`,
            start: event.start,
            end: event.end,
            durationMinutes: event.durationMinutes,
            role,
            department,
            requiredSkills,
            assignedEmployeeId,
            assignedWorkerEmail: assignee?.person.email ?? null,
            status,
            coverageStatus,
            sourceSystem: snapshot.sourceSystem,
            sourceIds: {
                bookingId: event.sourceIds.bookingId,
                bookingUid: event.sourceIds.bookingUid,
                eventTypeId: event.sourceIds.eventTypeId,
                eventTypeSlug: event.sourceIds.eventTypeSlug,
                teamId: sourceEvent?.teamId ?? null,
            },
            source: provenance,
            synthetic: snapshot.sourceSystem === 'demo',
            retrievedAt: context.retrievedAt,
            lastUpdated: event.lastUpdated,
            fieldSources,
        };
    });
}

export function resolveShiftStatus(rawStatus: string, endMs: number, nowMs: number): ShiftStatus {
    const mapped = STATUS_MAP[rawStatus.toLowerCase()] ?? 'unknown';
    // A confirmed shift whose end has passed is reported as completed; this is the only
    // temporal interpretation the Actor makes, and it is recorded as a derivation.
    if (mapped === 'scheduled' && Number.isFinite(endMs) && endMs <= nowMs) return 'completed';
    return mapped;
}

function buildWorkers(
    snapshot: RawSnapshot,
    context: NormalizeContext,
    identities: Map<string, Identity>,
    shifts: ShiftRecord[],
    warnings: string[],
): { workers: WorkerRecord[]; withoutMetadata: number } {
    const { range } = context.input;
    const week = isoWeekBounds(range.startMs);
    const availabilityByPerson = new Map(snapshot.availability.map((entry) => [entry.personKey, entry]));

    const shiftsByEmployee = new Map<string, ShiftRecord[]>();
    for (const shift of shifts) {
        if (shift.assignedEmployeeId === null) continue;
        const list = shiftsByEmployee.get(shift.assignedEmployeeId) ?? [];
        list.push(shift);
        shiftsByEmployee.set(shift.assignedEmployeeId, list);
    }

    const workers: WorkerRecord[] = [];
    let withoutMetadata = 0;

    for (const identity of identities.values()) {
        const { person, metadata } = identity;
        const employee = metadata?.employee ?? null;
        const metadataProvenance = metadata?.provenance ?? null;
        const sourceProvenance: Provenance = snapshot.sourceSystem === 'demo' ? 'demo' : 'cal.com';
        if (metadata === null) withoutMetadata += 1;

        const fieldSources: Record<string, Provenance> = { employeeId: identity.employeeIdProvenance };

        const name = person.name ?? employee?.name ?? null;
        if (name !== null)
            fieldSources.name = person.name !== null ? sourceProvenance : (metadataProvenance as Provenance);

        const email = person.email ?? employee?.email ?? null;
        if (email !== null)
            fieldSources.email = person.email !== null ? sourceProvenance : (metadataProvenance as Provenance);

        if (employee?.role != null) fieldSources.role = metadataProvenance as Provenance;
        if (employee?.department != null) fieldSources.department = metadataProvenance as Provenance;
        if (employee !== null && employee.skills.length > 0) fieldSources.skills = metadataProvenance as Provenance;
        if (employee?.contractedHoursPerWeek != null) {
            fieldSources.contractedHoursPerWeek = metadataProvenance as Provenance;
        }
        if (person.timeZone !== null) fieldSources.timeZone = sourceProvenance;

        const availability = buildAvailability(
            availabilityByPerson.get(person.key)?.windows ?? [],
            sourceProvenance,
            employee?.availability ?? [],
            metadataProvenance,
            range.startMs,
            range.endMs,
        );
        if (availability.length > 0) fieldSources.availability = availability[0]?.source ?? sourceProvenance;

        const assignedShifts = shiftsByEmployee.get(identity.employeeId) ?? [];
        const scheduledShifts = assignedShifts.map((shift) => shift.shiftId).sort();
        if (scheduledShifts.length > 0) fieldSources.scheduledShifts = sourceProvenance;

        const hoursThisWeek = computeHoursThisWeek(assignedShifts, week.startMs, week.endMs);
        fieldSources.hoursThisWeek = 'derived:scheduled-shifts-in-window';

        const dataSources: Provenance[] = [sourceProvenance];
        if (metadataProvenance !== null) dataSources.push(metadataProvenance);

        workers.push({
            recordType: 'worker',
            employeeId: identity.employeeId,
            name,
            email,
            role: employee?.role ?? null,
            department: employee?.department ?? null,
            skills: employee === null ? [] : [...employee.skills],
            availability,
            scheduledShifts,
            hoursThisWeek,
            contractedHoursPerWeek: employee?.contractedHoursPerWeek ?? null,
            timeZone: person.timeZone,
            sourceSystem: snapshot.sourceSystem,
            sourceIds: { calUserId: person.externalId, calUsername: person.username },
            dataSources,
            source: sourceProvenance,
            synthetic: snapshot.sourceSystem === 'demo' || metadataProvenance === 'demo-workforce-metadata',
            retrievedAt: context.retrievedAt,
            lastUpdated: null,
            fieldSources,
        });
    }

    const unmatched = context.metadata.unmatchedEntries();
    if (unmatched.length > 0) {
        warnings.push(
            `${unmatched.length} workforce metadata entr${unmatched.length === 1 ? 'y' : 'ies'} matched no user in ` +
                `the scheduling system (first few: ${unmatched
                    .slice(0, 5)
                    .map((entry) => entry.employee.employeeId)
                    .join(', ')}). Check the email addresses in the roster.`,
        );
    }
    if (withoutMetadata > 0) {
        warnings.push(
            `${withoutMetadata} worker(s) have no workforce metadata, so their role, department, skills and ` +
                'contracted hours are null. Eligibility rules that need those fields will skip them.',
        );
    }

    return { workers, withoutMetadata };
}

/**
 * Combines availability from the scheduling system and from the roster file.
 *
 * Windows are merged within each provenance group but never across groups, so a window's
 * `source` always tells the truth about where it came from.
 */
export function buildAvailability(
    sourceWindows: { start: string; end: string }[],
    sourceProvenance: Provenance,
    metadataWindows: { start: string; end: string }[],
    metadataProvenance: Provenance | null,
    rangeStartMs: number,
    rangeEndMs: number,
): TimeWindow[] {
    const clip = (windows: { start: string; end: string }[], provenance: Provenance): TimeWindow[] =>
        mergeWindows(windows)
            .map((window) => clipToRange(window.start, window.end, rangeStartMs, rangeEndMs))
            .filter((window): window is { start: string; end: string } => window !== null)
            .map((window) => ({ ...window, source: provenance }));

    const combined = [
        ...clip(sourceWindows, sourceProvenance),
        ...(metadataProvenance === null ? [] : clip(metadataWindows, metadataProvenance)),
    ];
    return combined.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/**
 * Scheduled hours inside the ISO week containing the window start.
 *
 * Only shifts that were actually retrieved count, so a narrow window under-reports. The README
 * spells this out and `fieldSources.hoursThisWeek` marks it as a derivation rather than a
 * figure the scheduling system vouched for.
 */
export function computeHoursThisWeek(shifts: ShiftRecord[], weekStartMs: number, weekEndMs: number): number {
    const totalMs = shifts
        .filter((shift) => shift.status !== 'cancelled')
        .reduce(
            (sum, shift) => sum + overlapMs(Date.parse(shift.start), Date.parse(shift.end), weekStartMs, weekEndMs),
            0,
        );
    return Math.round((totalMs / MS_PER_HOUR) * 100) / 100;
}
