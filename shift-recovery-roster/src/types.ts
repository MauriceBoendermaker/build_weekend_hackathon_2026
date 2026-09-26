/**
 * The normalized output contract.
 *
 * Everything the downstream n8n workflow relies on is declared here. Fields are
 * deliberately stable: a value that could not be retrieved is `null` (scalars) or
 * `[]` (collections) - never omitted, never guessed.
 *
 * Provenance is first-class. `source` says where the record as a whole came from and
 * `fieldSources` says where each individual value came from, so the decision layer can
 * never mistake supplemental workforce metadata for data that Cal.com actually returned.
 */

/** Where a value came from. `derived:*` means this Actor computed it from other retrieved data. */
export type Provenance = 'cal.com' | 'workforce-metadata' | 'demo-workforce-metadata' | 'demo' | `derived:${string}`;

export type RecordType = 'worker' | 'shift' | 'schedulingEvent' | 'summary';

/** The scheduling system a record was retrieved from. */
export type SourceSystem = 'cal.com' | 'demo';

export type ShiftStatus = 'scheduled' | 'pending' | 'cancelled' | 'completed' | 'unknown';

export type CoverageStatus = 'covered' | 'uncovered';

export interface TimeWindow {
    /** ISO-8601, UTC, milliseconds included. */
    start: string;
    /** ISO-8601, UTC, milliseconds included. */
    end: string;
    /** Where this window came from. */
    source: Provenance;
}

export interface EventParticipant {
    name: string | null;
    email: string | null;
    /** Role in the scheduling event itself, not the clinical role. */
    participantRole: 'host' | 'attendee' | 'guest';
    /** Resolved employee ID when the participant could be matched to the workforce. */
    employeeId: string | null;
    timeZone: string | null;
}

export interface BaseRecord {
    recordType: RecordType;
    source: Provenance;
    /** ISO-8601 UTC timestamp of the run. */
    retrievedAt: string;
    /** True when any value on the record is synthetic demo data. */
    synthetic: boolean;
}

export interface WorkerRecord extends BaseRecord {
    recordType: 'worker';
    employeeId: string;
    name: string | null;
    email: string | null;
    role: string | null;
    department: string | null;
    skills: string[];
    /** Windows in which the worker is available, in UTC. */
    availability: TimeWindow[];
    /** IDs of shift records inside the requested window that are assigned to this worker. */
    scheduledShifts: string[];
    /** Scheduled hours in the ISO week containing the window start; null when unknown. */
    hoursThisWeek: number | null;
    contractedHoursPerWeek: number | null;
    /** IANA time zone as reported by the scheduling system. */
    timeZone: string | null;
    sourceSystem: SourceSystem;
    /** Identifiers as they exist in the source system. */
    sourceIds: {
        calUserId: number | null;
        calUsername: string | null;
    };
    /** Which sources contributed to this record. */
    dataSources: Provenance[];
    fieldSources: Record<string, Provenance>;
    lastUpdated: string | null;
}

export interface ShiftRecord extends BaseRecord {
    recordType: 'shift';
    shiftId: string;
    start: string;
    end: string;
    durationMinutes: number;
    role: string | null;
    department: string | null;
    requiredSkills: string[];
    assignedEmployeeId: string | null;
    assignedWorkerEmail: string | null;
    status: ShiftStatus;
    coverageStatus: CoverageStatus;
    sourceSystem: SourceSystem;
    sourceIds: {
        bookingId: number | null;
        bookingUid: string | null;
        eventTypeId: number | null;
        eventTypeSlug: string | null;
        teamId: number | null;
    };
    fieldSources: Record<string, Provenance>;
    lastUpdated: string | null;
}

export interface SchedulingEventRecord extends BaseRecord {
    recordType: 'schedulingEvent';
    eventId: string;
    /** Human-readable title from the scheduling system. */
    name: string | null;
    start: string;
    end: string;
    durationMinutes: number;
    /** Raw status string from the scheduling system, lower-cased. */
    status: string;
    participants: EventParticipant[];
    /** The participant treated as the working person, i.e. the first host. */
    primaryWorkerEmployeeId: string | null;
    sourceSystem: SourceSystem;
    sourceIds: {
        bookingId: number | null;
        bookingUid: string | null;
        eventTypeId: number | null;
        eventTypeSlug: string | null;
    };
    fieldSources: Record<string, Provenance>;
    lastUpdated: string | null;
}

export type RunStatus = 'success' | 'partial' | 'failure';

export interface RunCounts {
    pagesFetched: number;
    apiRequests: number;
    rawEventsRetrieved: number;
    rawWorkersDiscovered: number;
    workersRetrieved: number;
    shiftsRetrieved: number;
    eventsRetrieved: number;
    recordsNormalized: number;
    recordsDiscarded: number;
    duplicatesDropped: number;
    workersWithoutMetadata: number;
}

export interface SummaryRecord extends BaseRecord {
    recordType: 'summary';
    status: RunStatus;
    mode: 'live' | 'hybrid' | 'demo';
    sourceSystem: SourceSystem;
    /** Which metadata source supplied role/department/skills, if any. */
    workforceMetadataSource: 'input-inline' | 'input-url' | 'key-value-store' | 'demo' | 'mixed' | 'none';
    dateRange: { start: string; end: string };
    counts: RunCounts;
    /**
     * True when the source responded successfully but produced no worker records.
     * An API failure never produces this - it fails the run instead.
     */
    emptyResult: boolean;
    /** Non-fatal problems: hit page caps, records discarded, unmatched workers, and so on. */
    warnings: string[];
    /** Set only when status is 'failure'. Credential-free. */
    errorCode: string | null;
    errorMessage: string | null;
    durationMs: number;
    actorVersion: string;
}

export type RosterRecord = WorkerRecord | ShiftRecord | SchedulingEventRecord;

export type AnyRecord = RosterRecord | SummaryRecord;

/** The bundle a source adapter hands to the normalizer. */
export interface NormalizedBundle {
    workers: WorkerRecord[];
    shifts: ShiftRecord[];
    events: SchedulingEventRecord[];
}
