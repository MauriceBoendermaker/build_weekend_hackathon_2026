/**
 * Demo source adapter.
 *
 * A second implementation of {@link RosterSource} that makes no network calls. It exists for
 * two reasons: it proves the adapter seam is real, and it makes the Actor demonstrable in a
 * few seconds without credentials.
 *
 * The data is deliberately, visibly synthetic:
 *
 * - every email is on `demo.hospital.invalid` (`.invalid` is reserved by RFC 2606 and can
 *   never resolve, so nothing here can reach a real person),
 * - every name is prefixed with `Demo`,
 * - every record it produces is flagged `synthetic: true` and sourced as `demo`.
 *
 * It contains no patient data, no absence reasons and no medical information about staff -
 * only role, department, skills, contracted hours and rota, which is what shift recovery needs.
 *
 * Output is deterministic: the same window always produces the same roster and the same shift
 * IDs, so a demo can be replayed and tests can assert exact values.
 */

import { log } from 'apify';

import type { ResolvedInput } from '../../input.js';
import { mergeWindows, subtractIntervals, utcDaysInRange } from '../../time.js';
import type { SourceSystem } from '../../types.js';
import {
    emptyStats,
    type RawSnapshot,
    type RosterSource,
    type SourceAvailability,
    type SourceEvent,
    type SourcePerson,
    type SourceShiftType,
} from '../source.js';

interface DemoStaffMember {
    employeeId: string;
    calUserId: number;
    username: string;
    name: string;
    role: string;
    department: string;
    skills: string[];
    contractedHoursPerWeek: number;
    timeZone: string;
}

/** Shift patterns as local wall-clock hours; the demo runs everything in UTC for clarity. */
interface DemoShiftPattern {
    code: string;
    startHour: number;
    durationHours: number;
}

const DEMO_DOMAIN = 'demo.hospital.invalid';

const DEMO_STAFF: DemoStaffMember[] = [
    {
        employeeId: 'E101',
        calUserId: 9101,
        username: 'demo-sarah-vos',
        name: 'Demo Sarah Vos',
        role: 'ICU_NURSE',
        department: 'ICU',
        skills: ['ICU', 'BLS', 'ALS', 'VENTILATOR'],
        contractedHoursPerWeek: 36,
        timeZone: 'Europe/Amsterdam',
    },
    {
        employeeId: 'E102',
        calUserId: 9102,
        username: 'demo-jonas-berg',
        name: 'Demo Jonas Berg',
        role: 'ICU_NURSE',
        department: 'ICU',
        skills: ['ICU', 'BLS', 'VENTILATOR'],
        contractedHoursPerWeek: 32,
        timeZone: 'Europe/Amsterdam',
    },
    {
        employeeId: 'E103',
        calUserId: 9103,
        username: 'demo-amina-diallo',
        name: 'Demo Amina Diallo',
        role: 'ICU_NURSE',
        department: 'ICU',
        skills: ['ICU', 'BLS', 'ALS', 'CRRT'],
        contractedHoursPerWeek: 36,
        timeZone: 'Europe/Amsterdam',
    },
    {
        employeeId: 'E104',
        calUserId: 9104,
        username: 'demo-pieter-hoek',
        name: 'Demo Pieter Hoek',
        role: 'ER_NURSE',
        department: 'ER',
        skills: ['ER', 'TRIAGE', 'BLS', 'ALS'],
        contractedHoursPerWeek: 36,
        timeZone: 'Europe/Amsterdam',
    },
    {
        employeeId: 'E105',
        calUserId: 9105,
        username: 'demo-lena-fischer',
        name: 'Demo Lena Fischer',
        role: 'ER_NURSE',
        department: 'ER',
        skills: ['ER', 'TRIAGE', 'BLS'],
        contractedHoursPerWeek: 28,
        timeZone: 'Europe/Berlin',
    },
    {
        employeeId: 'E106',
        calUserId: 9106,
        username: 'demo-tom-okafor',
        name: 'Demo Tom Okafor',
        role: 'ER_NURSE',
        department: 'ER',
        skills: ['ER', 'BLS', 'ICU'],
        contractedHoursPerWeek: 36,
        timeZone: 'Europe/Amsterdam',
    },
    {
        employeeId: 'E107',
        calUserId: 9107,
        username: 'demo-maja-novak',
        name: 'Demo Maja Novak',
        role: 'WARD_NURSE',
        department: 'WARD_A',
        skills: ['WARD', 'BLS', 'WOUND_CARE'],
        contractedHoursPerWeek: 32,
        timeZone: 'Europe/Amsterdam',
    },
    {
        employeeId: 'E108',
        calUserId: 9108,
        username: 'demo-ravi-menon',
        name: 'Demo Ravi Menon',
        role: 'WARD_NURSE',
        department: 'WARD_A',
        skills: ['WARD', 'BLS'],
        contractedHoursPerWeek: 24,
        timeZone: 'Europe/Amsterdam',
    },
    {
        employeeId: 'E109',
        calUserId: 9109,
        username: 'demo-hanna-lund',
        name: 'Demo Hanna Lund',
        role: 'WARD_NURSE',
        department: 'WARD_B',
        skills: ['WARD', 'BLS', 'GERIATRICS'],
        contractedHoursPerWeek: 36,
        timeZone: 'Europe/Stockholm',
    },
    {
        employeeId: 'E110',
        calUserId: 9110,
        username: 'demo-samuel-reyes',
        name: 'Demo Samuel Reyes',
        role: 'DOCTOR',
        department: 'ICU',
        skills: ['ICU', 'ALS', 'INTUBATION', 'PRESCRIBING'],
        contractedHoursPerWeek: 40,
        timeZone: 'Europe/Amsterdam',
    },
    {
        employeeId: 'E111',
        calUserId: 9111,
        username: 'demo-claire-dubois',
        name: 'Demo Claire Dubois',
        role: 'DOCTOR',
        department: 'ER',
        skills: ['ER', 'ALS', 'INTUBATION', 'PRESCRIBING'],
        contractedHoursPerWeek: 40,
        timeZone: 'Europe/Paris',
    },
    {
        employeeId: 'E112',
        calUserId: 9112,
        username: 'demo-noah-visser',
        name: 'Demo Noah Visser',
        role: 'CHARGE_NURSE',
        department: 'ICU',
        skills: ['ICU', 'BLS', 'ALS', 'COORDINATION'],
        contractedHoursPerWeek: 36,
        timeZone: 'Europe/Amsterdam',
    },
];

const DEMO_PATTERNS: DemoShiftPattern[] = [
    { code: 'DAY', startHour: 7, durationHours: 8 },
    { code: 'EVENING', startHour: 15, durationHours: 8 },
    { code: 'NIGHT', startHour: 23, durationHours: 8 },
];

const MS_PER_HOUR = 3_600_000;

export function demoEmail(member: DemoStaffMember): string {
    return `${member.username}@${DEMO_DOMAIN}`;
}

/** The demo roster, exposed so the metadata layer can reuse it without duplicating it. */
export function demoStaff(): DemoStaffMember[] {
    return DEMO_STAFF.map((member) => ({ ...member, skills: [...member.skills] }));
}

/** One entry per bookable kind of demo work, with the IDs the demo bookings reference. */
export interface DemoShiftTypeDefinition {
    externalId: number;
    slug: string;
    title: string;
    lengthInMinutes: number;
    teamId: number;
    department: string;
    patternCode: string;
    hostKeys: string[];
}

export function demoDepartments(): string[] {
    return [...new Set(DEMO_STAFF.map((member) => member.department))];
}

/**
 * The demo event-type catalog.
 *
 * Shared by the source (which reports these as bookable work) and by the demo metadata layer
 * (which maps them to roles and required skills), so the IDs and slugs can never drift apart.
 */
export function demoShiftTypeCatalog(): DemoShiftTypeDefinition[] {
    const departments = demoDepartments();
    const catalog: DemoShiftTypeDefinition[] = [];

    for (const [departmentIndex, department] of departments.entries()) {
        for (const [patternIndex, pattern] of DEMO_PATTERNS.entries()) {
            catalog.push({
                externalId: 7001 + departmentIndex * DEMO_PATTERNS.length + patternIndex,
                slug: `${department.toLowerCase().replace(/_/g, '-')}-${pattern.code.toLowerCase()}-shift`,
                title: `Demo ${department} ${pattern.code.toLowerCase()} shift`,
                lengthInMinutes: pattern.durationHours * 60,
                teamId: 8000 + departmentIndex,
                department,
                patternCode: pattern.code,
                hostKeys: DEMO_STAFF.filter((member) => member.department === department).map(
                    (member) => `email:${demoEmail(member)}`,
                ),
            });
        }
    }
    return catalog;
}

export class DemoRosterSource implements RosterSource {
    readonly id: SourceSystem = 'demo';

    constructor(private readonly input: ResolvedInput) {}

    async fetch(): Promise<RawSnapshot> {
        const { range } = this.input;
        log.warning(
            'Running in DEMO mode: every record is synthetic. No Cal.com API call is made and no record ' +
                'in the output describes a real person or a real shift.',
        );

        const people: SourcePerson[] = DEMO_STAFF.map((member) => ({
            key: `email:${demoEmail(member)}`,
            externalId: member.calUserId,
            username: member.username,
            name: member.name,
            email: demoEmail(member),
            timeZone: member.timeZone,
            discoveredVia: 'demo-roster',
        }));

        const shiftTypes = this.buildShiftTypes();
        const events = this.buildEvents();
        const availability = this.buildAvailability(events);

        log.info(
            `Demo roster: ${people.length} staff, ${events.length} scheduled shift(s) between ` +
                `${range.start} and ${range.end}`,
        );

        return {
            sourceSystem: 'demo',
            retrievedAt: new Date().toISOString(),
            people,
            events,
            availability,
            shiftTypes,
            stats: {
                ...emptyStats(),
                resources: { 'demo:roster': { pages: 1, records: people.length, truncated: false } },
            },
            warnings: [
                'Demo mode: all workers, shifts and availability are synthetic and must never be treated as ' +
                    'real scheduling data.',
            ],
            complete: true,
        };
    }

    private buildShiftTypes(): SourceShiftType[] {
        return demoShiftTypeCatalog().map((entry) => ({
            externalId: entry.externalId,
            slug: entry.slug,
            title: entry.title,
            lengthInMinutes: entry.lengthInMinutes,
            teamId: entry.teamId,
            hostKeys: entry.hostKeys,
        }));
    }

    /**
     * Builds the rota.
     *
     * Assignment is a deterministic rotation over the staff of each department, seeded by the
     * UTC day index so the same window always yields the same roster. Every third slot is left
     * unassigned on purpose - a realistic shift-recovery demo needs both covered shifts and a
     * gap to fill.
     */
    private buildEvents(): SourceEvent[] {
        const { range } = this.input;
        const days = utcDaysInRange(range.startMs, range.endMs);
        const departments = [...new Set(DEMO_STAFF.map((member) => member.department))];
        const events: SourceEvent[] = [];

        for (const [dayIndex, day] of days.entries()) {
            for (const [departmentIndex, department] of departments.entries()) {
                const staff = DEMO_STAFF.filter((member) => member.department === department);
                if (staff.length === 0) continue;

                for (const [patternIndex, pattern] of DEMO_PATTERNS.entries()) {
                    const startMs = Date.parse(`${day}T00:00:00.000Z`) + pattern.startHour * MS_PER_HOUR;
                    const endMs = startMs + pattern.durationHours * MS_PER_HOUR;
                    if (startMs < range.startMs || startMs >= range.endMs) continue;

                    const slot = dayIndex * DEMO_PATTERNS.length + patternIndex + departmentIndex;
                    const uid = `demo-${day}-${department.toLowerCase()}-${pattern.code.toLowerCase()}`;
                    const shiftTypeSlug = `${department.toLowerCase().replace(/_/g, '-')}-${pattern.code.toLowerCase()}-shift`;
                    const shiftTypeId = 7001 + departmentIndex * DEMO_PATTERNS.length + patternIndex;

                    // Leave roughly one slot in three open, so the demo has something to recover.
                    const assignee = slot % 3 === 2 ? undefined : staff[slot % staff.length];

                    events.push({
                        externalId: 600000 + events.length,
                        uid,
                        title: `Demo ${department} ${pattern.code.toLowerCase()} shift`,
                        start: new Date(startMs).toISOString(),
                        end: new Date(endMs).toISOString(),
                        durationMinutes: pattern.durationHours * 60,
                        status: assignee === undefined ? 'pending' : 'accepted',
                        eventTypeId: shiftTypeId,
                        eventTypeSlug: shiftTypeSlug,
                        teamId: 8000 + departmentIndex,
                        hosts:
                            assignee === undefined
                                ? []
                                : [
                                      {
                                          key: `email:${demoEmail(assignee)}`,
                                          externalId: assignee.calUserId,
                                          username: assignee.username,
                                          name: assignee.name,
                                          email: demoEmail(assignee),
                                          timeZone: assignee.timeZone,
                                          absent: false,
                                      },
                                  ],
                        attendees: [],
                        createdAt: new Date(range.startMs - 7 * 24 * MS_PER_HOUR).toISOString(),
                        updatedAt: new Date(range.startMs - 24 * MS_PER_HOUR).toISOString(),
                    });
                }
            }
        }
        return events;
    }

    /**
     * Publishes a 06:00-22:00 UTC availability window per day, minus the shifts the person is
     * already assigned.
     *
     * Subtracting rather than skipping whole days matters: a night shift runs 23:00-07:00 and so
     * eats into the following morning, and someone finishing a 07:00-15:00 day shift is genuinely
     * free afterwards. Publishing availability that overlaps the worker's own rota would let the
     * decision layer offer a shift to somebody who is already on one.
     */
    private buildAvailability(events: SourceEvent[]): SourceAvailability[] {
        const { range } = this.input;
        const days = utcDaysInRange(range.startMs, range.endMs);

        const busyByPerson = new Map<string, { start: string; end: string }[]>();
        for (const event of events) {
            const host = event.hosts[0];
            if (host?.key === null || host?.key === undefined) continue;
            const busy = busyByPerson.get(host.key) ?? [];
            busy.push({ start: String(event.start), end: String(event.end) });
            busyByPerson.set(host.key, busy);
        }

        return DEMO_STAFF.map((member) => {
            const key = `email:${demoEmail(member)}`;
            const busy = busyByPerson.get(key) ?? [];
            const windows: { start: string; end: string }[] = [];

            for (const day of days) {
                const startMs = Math.max(Date.parse(`${day}T06:00:00.000Z`), range.startMs);
                const endMs = Math.min(Date.parse(`${day}T22:00:00.000Z`), range.endMs);
                if (endMs <= startMs) continue;
                windows.push(
                    ...subtractIntervals(
                        { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() },
                        busy,
                    ),
                );
            }

            return { personKey: key, timeZone: member.timeZone, windows: mergeWindows(windows) };
        }).filter((entry) => entry.windows.length > 0);
    }
}
