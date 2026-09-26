/**
 * Cal.com response fixtures.
 *
 * Shapes follow the published OpenAPI document (api.cal.com/v2), including the `{status, data}`
 * envelope, the cursor pagination metadata on `/v2/bookings`, and the fields this Actor reads.
 */

import { parseInput, type ResolvedInput } from '../../src/input.js';
import type { CalBooking, CalEventType, CalMembership, CalSchedule, CalTeam } from '../../src/sources/calcom/client.js';
import type { MockRoute } from './mock-http.js';

/** Fixed reference instant so every fixture and assertion is deterministic. */
export const NOW = new Date('2026-09-26T09:00:00.000Z');

export const ME = {
    id: 501,
    username: 'head-of-nursing',
    email: 'lead@hospital.example',
    name: 'Alex Lead',
    timeZone: 'Europe/Amsterdam',
    defaultScheduleId: 77,
    organizationId: 12,
};

export const TEAMS: CalTeam[] = [
    { id: 12, name: 'Hospital Org', slug: 'hospital', isOrganization: true },
    { id: 31, name: 'ICU rota', slug: 'icu-rota', isOrganization: false, timeZone: 'Europe/Amsterdam' },
];

export const MEMBERSHIPS: CalMembership[] = [
    {
        id: 1,
        userId: 501,
        teamId: 31,
        accepted: true,
        role: 'ADMIN',
        user: { email: 'lead@hospital.example', username: 'head-of-nursing', name: 'Alex Lead' },
    },
    {
        id: 2,
        userId: 502,
        teamId: 31,
        accepted: true,
        role: 'MEMBER',
        user: { email: 'sarah@hospital.example', username: 'sarah-v', name: 'Sarah V' },
    },
    {
        id: 3,
        userId: 503,
        teamId: 31,
        accepted: true,
        role: 'MEMBER',
        user: { email: 'jonas@hospital.example', username: 'jonas-b', name: 'Jonas B' },
    },
    {
        // Pending invitation: not somebody who can be asked to cover a shift.
        id: 4,
        userId: 504,
        teamId: 31,
        accepted: false,
        role: 'MEMBER',
        user: { email: 'pending@hospital.example', username: 'pending-p', name: 'Pending P' },
    },
];

export const EVENT_TYPES: CalEventType[] = [
    {
        id: 900,
        slug: 'icu-night-shift',
        title: 'ICU night shift',
        lengthInMinutes: 480,
        teamId: 31,
        scheduleId: 77,
        users: [
            { id: 502, username: 'sarah-v', name: 'Sarah V' },
            { id: 503, username: 'jonas-b', name: 'Jonas B' },
        ],
    },
    {
        id: 901,
        slug: 'icu-day-shift',
        title: 'ICU day shift',
        lengthInMinutes: 480,
        teamId: 31,
        users: [{ id: 502, username: 'sarah-v', name: 'Sarah V' }],
    },
];

export const SCHEDULES: CalSchedule[] = [
    {
        id: 77,
        ownerId: 501,
        name: 'Weekdays',
        timeZone: 'Europe/Amsterdam',
        isDefault: true,
        // 09:00-17:00 local. Amsterdam is UTC+2 on 2026-09-26 (CEST), so 07:00-15:00 UTC.
        availability: [
            { days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], startTime: '09:00', endTime: '17:00' },
        ],
        overrides: [{ date: '2026-09-28', startTime: '12:00', endTime: '20:00' }],
    },
];

export function booking(overrides: Partial<CalBooking> = {}): CalBooking {
    return {
        id: 1001,
        uid: 'bk-1001',
        title: 'ICU night shift',
        status: 'accepted',
        start: '2026-09-26T18:00:00.000Z',
        end: '2026-09-27T02:00:00.000Z',
        duration: 480,
        eventTypeId: 900,
        eventType: { id: 900, slug: 'icu-night-shift' },
        absentHost: false,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-20T10:00:00.000Z',
        hosts: [
            {
                id: 502,
                name: 'Sarah V',
                email: 'sarah@hospital.example',
                username: 'sarah-v',
                timeZone: 'Europe/Amsterdam',
            },
        ],
        attendees: [],
        ...overrides,
    };
}

export const BOOKINGS: CalBooking[] = [
    booking(),
    booking({
        id: 1002,
        uid: 'bk-1002',
        title: 'ICU day shift',
        start: '2026-09-27T05:00:00.000Z',
        end: '2026-09-27T13:00:00.000Z',
        eventTypeId: 901,
        eventType: { id: 901, slug: 'icu-day-shift' },
        hosts: [
            {
                id: 503,
                name: 'Jonas B',
                email: 'jonas@hospital.example',
                username: 'jonas-b',
                timeZone: 'Europe/Amsterdam',
            },
        ],
    }),
    booking({
        id: 1003,
        uid: 'bk-1003',
        title: 'ICU night shift',
        status: 'pending',
        start: '2026-09-28T18:00:00.000Z',
        end: '2026-09-29T02:00:00.000Z',
        // Nobody assigned: exactly the gap a shift-recovery workflow has to fill.
        hosts: [],
    }),
];

export const EMPLOYEE_METADATA = [
    {
        employeeId: 'E101',
        email: 'sarah@hospital.example',
        role: 'ICU_NURSE',
        department: 'ICU',
        skills: ['ICU', 'BLS'],
        contractedHoursPerWeek: 36,
    },
    {
        employeeId: 'E102',
        calUsername: 'jonas-b',
        role: 'ICU_NURSE',
        department: 'ICU',
        skills: ['ICU'],
        contractedHoursPerWeek: 32,
    },
];

export const SHIFT_TYPE_METADATA = [
    { eventTypeSlug: 'icu-night-shift', role: 'ICU_NURSE', department: 'ICU', requiredSkills: ['ICU', 'BLS'] },
    { eventTypeId: 901, role: 'ICU_NURSE', department: 'ICU', requiredSkills: ['ICU'] },
];

/** A fully resolved input for tests, with everything deterministic. */
export function testInput(overrides: Record<string, unknown> = {}): ResolvedInput {
    return parseInput(
        {
            mode: 'live',
            apiKey: 'cal_test_0123456789abcdef',
            startTime: '2026-09-26T00:00:00Z',
            endTime: '2026-10-03T00:00:00Z',
            bookingStatuses: ['upcoming'],
            ...overrides,
        },
        { now: NOW, env: {} },
    );
}

/** The routes a complete happy-path Cal.com run needs. */
export function happyPathRoutes(): MockRoute[] {
    return [
        [/\/v2\/me$/, () => ({ body: { status: 'success', data: ME } })],
        [/\/v2\/teams$/, () => ({ body: { status: 'success', data: TEAMS } })],
        [/\/v2\/teams\/\d+\/memberships$/, () => ({ body: { status: 'success', data: MEMBERSHIPS } })],
        [/\/v2\/teams\/\d+\/event-types$/, () => ({ body: { status: 'success', data: EVENT_TYPES } })],
        [/\/v2\/event-types$/, () => ({ body: { status: 'success', data: [] } })],
        [/\/v2\/schedules$/, () => ({ body: { status: 'success', data: SCHEDULES } })],
        [
            /\/v2\/bookings$/,
            () => ({ body: { status: 'success', data: BOOKINGS, pagination: { nextCursor: null, hasMore: false } } }),
        ],
    ];
}
