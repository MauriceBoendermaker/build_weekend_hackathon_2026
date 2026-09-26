/**
 * Synthetic workforce metadata.
 *
 * Cal.com has no notion of an employee ID, a clinical role, a department, a skill set or a
 * contracted week. When the operator has not wired a roster source in yet, this module can
 * invent that layer so a demo has something to reason about.
 *
 * Two hard rules:
 *
 * 1. Anything produced here is labelled `demo-workforce-metadata` and flags the record
 *    `synthetic: true`. It is never attributed to Cal.com.
 * 2. It holds role, department, skills and contracted hours only. No medical information, no
 *    absence reasons, no patient data - none of that belongs in a roster feed.
 *
 * Values are derived from a stable hash of the person's key, so the same Cal.com user always
 * gets the same synthetic profile across runs.
 */

import type { EmployeeMetadata, ShiftTypeMetadata } from '../input.js';
import { demoEmail, demoShiftTypeCatalog, demoStaff } from '../sources/demo/source.js';
import type { SourcePerson } from '../sources/source.js';

interface RoleProfile {
    role: string;
    department: string;
    skills: string[];
    contractedHoursPerWeek: number;
}

/** The archetypes a synthesized worker can be assigned. Mirrors the demo roster's shape. */
const ROLE_PROFILES: RoleProfile[] = [
    { role: 'ICU_NURSE', department: 'ICU', skills: ['ICU', 'BLS', 'VENTILATOR'], contractedHoursPerWeek: 36 },
    { role: 'ER_NURSE', department: 'ER', skills: ['ER', 'TRIAGE', 'BLS'], contractedHoursPerWeek: 36 },
    { role: 'WARD_NURSE', department: 'WARD_A', skills: ['WARD', 'BLS', 'WOUND_CARE'], contractedHoursPerWeek: 32 },
    { role: 'DOCTOR', department: 'ICU', skills: ['ICU', 'ALS', 'PRESCRIBING'], contractedHoursPerWeek: 40 },
    { role: 'CHARGE_NURSE', department: 'ICU', skills: ['ICU', 'BLS', 'COORDINATION'], contractedHoursPerWeek: 36 },
];

/** FNV-1a. Small, dependency-free and stable across Node versions. */
export function stableHash(value: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/** Workforce metadata for the built-in demo roster. Matched by email. */
export function demoRosterMetadata(): EmployeeMetadata[] {
    return demoStaff().map((member) => ({
        employeeId: member.employeeId,
        email: demoEmail(member).toLowerCase(),
        calUsername: member.username,
        calUserId: member.calUserId,
        name: member.name,
        role: member.role,
        department: member.department,
        skills: [...member.skills],
        contractedHoursPerWeek: member.contractedHoursPerWeek,
        availability: [],
    }));
}

/** What each demo department needs from whoever covers one of its shifts. */
const DEPARTMENT_REQUIREMENTS: Record<string, { role: string; requiredSkills: string[] }> = {
    ICU: { role: 'ICU_NURSE', requiredSkills: ['ICU', 'BLS'] },
    ER: { role: 'ER_NURSE', requiredSkills: ['ER', 'TRIAGE', 'BLS'] },
    WARD_A: { role: 'WARD_NURSE', requiredSkills: ['WARD', 'BLS'] },
    WARD_B: { role: 'WARD_NURSE', requiredSkills: ['WARD', 'BLS'] },
};

/**
 * Shift requirements for the demo event types.
 *
 * Cal.com event types carry no clinical requirements, so this is workforce metadata like any
 * other and is labelled `demo-workforce-metadata`. Night shifts additionally require ALS, which
 * gives the decision layer a genuine eligibility filter to apply rather than a trivial one.
 */
export function demoShiftTypeMetadata(): ShiftTypeMetadata[] {
    return demoShiftTypeCatalog().map((entry) => {
        const requirement = DEPARTMENT_REQUIREMENTS[entry.department] ?? {
            role: 'WARD_NURSE',
            requiredSkills: ['WARD', 'BLS'],
        };
        const requiredSkills = [...requirement.requiredSkills];
        if (entry.patternCode === 'NIGHT') requiredSkills.push('ALS');

        return {
            eventTypeId: entry.externalId,
            eventTypeSlug: entry.slug,
            role: requirement.role,
            department: entry.department,
            requiredSkills,
            provenance: 'demo-workforce-metadata',
        };
    });
}

/**
 * Invents a plausible profile for a real Cal.com user that no roster entry covers.
 *
 * Used only when `useDemoWorkforceMetadata` is on (always in `hybrid` and `demo` modes). The
 * employee ID is prefixed `DEMO-` so it can never be mistaken for a real payroll number.
 */
export function synthesizeMetadata(person: SourcePerson): EmployeeMetadata {
    const seed = stableHash(person.key);
    const profile = ROLE_PROFILES[seed % ROLE_PROFILES.length] as RoleProfile;

    return {
        employeeId: `DEMO-${(seed % 100_000).toString().padStart(5, '0')}`,
        email: person.email === null ? null : person.email.toLowerCase(),
        calUsername: person.username === null ? null : person.username.toLowerCase(),
        calUserId: person.externalId,
        name: null, // The real name comes from Cal.com; never overwrite it with a fake one.
        role: profile.role,
        department: profile.department,
        skills: [...profile.skills],
        contractedHoursPerWeek: profile.contractedHoursPerWeek,
        availability: [],
    };
}
