// Story 1.1 (epics.md): imports the seeded employee population. AD-19: each
// employee's `joined_company` UserEvents row is written synchronously, in
// the same transaction as its User insert — this script's own transaction,
// never an HTTP request, never an event bus. AD-12/FR-1: this is the only
// path in the system that assigns the first HR Admin functional role; there
// is no HTTP user-creation/registration flow (AD-25 retires POST /users).
//
// This is a small, representative synthetic population for local/test use.
// The real delivered seeded timetracker list (§4.17) is not available in
// this environment, so the entries below are illustrative S1 identity-card
// rows only — no real employee data (project-requirements.md §7 "Personal
// data"). Field values follow DEC-UM-007 (workEmail: trim + lowercase,
// normalized before storage/uniqueness comparison). DEC-UM-003/006/009 are
// registration-flow (`POST /users`) decisions for a create path AD-25
// retires entirely — they describe client-payload handling this script
// never does (it never accepts a client-supplied id/createdAt/customFields
// payload to strip or reject), so they have no bearing here.
//
// Re-runnable: every write is upsert-by-natural-key (workEmail for users,
// name for departments/policies, name for permissions), so running this
// script twice against the same database is a no-op the second time rather
// than a duplicate-row error.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

type DepartmentKey = 'hr' | 'engineering' | 'design' | 'sales';

interface SeedEmployee {
  firstName: string;
  lastName: string;
  position: string;
  country: string;
  city: string;
  workEmail: string;
  workPhone: string;
  birthDay: number;
  birthMonth: number;
  companyJoinDate: string;
  ttId: string;
  department: DepartmentKey;
}

const ROOT_WORK_EMAIL = normalizeEmail(
  process.env.ROOT_WORK_EMAIL ?? 'root@company.example',
);

const POPULATION: SeedEmployee[] = [
  {
    firstName: 'Root',
    lastName: 'Admin',
    position: 'HR Administrator',
    country: 'Poland',
    city: 'Warsaw',
    workEmail: ROOT_WORK_EMAIL,
    workPhone: '+48-100-000-001',
    birthDay: 1,
    birthMonth: 1,
    companyJoinDate: '2020-01-01',
    ttId: 'tt-0001',
    department: 'hr',
  },
  {
    firstName: 'Alice',
    lastName: 'Nowak',
    position: 'Senior Engineer',
    country: 'Poland',
    city: 'Warsaw',
    workEmail: 'alice.nowak@company.example',
    workPhone: '+48-100-000-002',
    birthDay: 12,
    birthMonth: 4,
    companyJoinDate: '2021-03-15',
    ttId: 'tt-0002',
    department: 'engineering',
  },
  {
    firstName: 'Bob',
    lastName: 'Kowalski',
    position: 'Engineering Manager',
    country: 'Poland',
    city: 'Krakow',
    workEmail: 'bob.kowalski@company.example',
    workPhone: '+48-100-000-003',
    birthDay: 22,
    birthMonth: 9,
    companyJoinDate: '2019-06-01',
    ttId: 'tt-0003',
    department: 'engineering',
  },
  {
    firstName: 'Paula',
    lastName: 'Petrova',
    position: 'People Partner',
    country: 'Poland',
    city: 'Warsaw',
    workEmail: 'paula.petrova@company.example',
    workPhone: '+48-100-000-004',
    birthDay: 3,
    birthMonth: 11,
    companyJoinDate: '2020-08-10',
    ttId: 'tt-0004',
    department: 'hr',
  },
  {
    firstName: 'Colin',
    lastName: 'Baker',
    position: 'QA Engineer',
    country: 'Germany',
    city: 'Berlin',
    workEmail: 'colin.baker@company.example',
    workPhone: '+49-100-000-005',
    birthDay: 18,
    birthMonth: 7,
    companyJoinDate: '2022-02-01',
    ttId: 'tt-0005',
    department: 'engineering',
  },
  {
    firstName: 'Nina',
    lastName: 'Volkova',
    position: 'UX Designer',
    country: 'Poland',
    city: 'Gdansk',
    workEmail: 'nina.volkova@company.example',
    workPhone: '+48-100-000-006',
    birthDay: 27,
    birthMonth: 2,
    companyJoinDate: '2023-05-01',
    ttId: 'tt-0006',
    department: 'design',
  },
  {
    firstName: 'Tomas',
    lastName: 'Novak',
    position: 'Account Executive',
    country: 'Czechia',
    city: 'Prague',
    workEmail: 'tomas.novak@company.example',
    workPhone: '+420-100-000-007',
    birthDay: 9,
    birthMonth: 12,
    companyJoinDate: '2021-11-20',
    ttId: 'tt-0007',
    department: 'sales',
  },
  {
    firstName: 'Ida',
    lastName: 'Schmidt',
    position: 'IT Support Specialist',
    country: 'Germany',
    city: 'Munich',
    workEmail: 'ida.schmidt@company.example',
    workPhone: '+49-100-000-008',
    birthDay: 14,
    birthMonth: 6,
    companyJoinDate: '2022-09-01',
    ttId: 'tt-0008',
    department: 'engineering',
  },
];

const DEPARTMENTS: { key: DepartmentKey; name: string; isHr: boolean }[] = [
  { key: 'hr', name: 'Human Resources', isHr: true },
  { key: 'engineering', name: 'Engineering', isHr: false },
  { key: 'design', name: 'Design', isHr: false },
  { key: 'sales', name: 'Sales', isHr: false },
];

// AD-9: closed permission catalog — Permission rows are seeded only from
// this fixed list (§2.3's named feature permissions, plus one
// `section:sN:write` row per S1-S16 for AccessControlService's
// hasSectionWritePermission narrowing). No admin-facing create-permission
// path exists anywhere in this build.
const NAMED_PERMISSIONS = [
  'manage_roles',
  'change organisational relationships',
  'record a departure',
  'manage departments',
  'edit the career timeline',
  'maintain CDS records',
  'assign and end mentorships',
  'create form campaigns',
  'create action items',
  'create feedback',
  'manage custom fields',
  'approve or reject proposed candidates',
];
const SECTION_WRITE_PERMISSIONS = Array.from(
  { length: 16 },
  (_, i) => `section:s${i + 1}:write`,
);
const CLOSED_PERMISSION_CATALOG = [
  ...NAMED_PERMISSIONS,
  ...SECTION_WRITE_PERMISSIONS,
];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run the seed script.');
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    const departmentIds = new Map<DepartmentKey, string>();
    for (const dept of DEPARTMENTS) {
      const existing = await prisma.department.findFirst({
        where: { name: dept.name },
      });
      const row =
        existing ??
        (await prisma.department.create({
          data: { name: dept.name, isHrDepartment: dept.isHr },
        }));
      departmentIds.set(dept.key, row.id);
    }

    // One User row + one joined_company UserEvents row per entry, written
    // in the same transaction (AD-19). Upsert-by-workEmail keeps this
    // script safely re-runnable.
    for (const employee of POPULATION) {
      const workEmail = normalizeEmail(employee.workEmail);
      const departmentId = departmentIds.get(employee.department);
      if (!departmentId) {
        throw new Error(`Unknown department key: ${employee.department}`);
      }

      await prisma.$transaction(async (tx) => {
        const user = await tx.user.upsert({
          where: { workEmail },
          update: {},
          create: {
            firstName: employee.firstName,
            lastName: employee.lastName,
            position: employee.position,
            country: employee.country,
            city: employee.city,
            workEmail,
            workPhone: employee.workPhone,
            birthDay: employee.birthDay,
            birthMonth: employee.birthMonth,
            companyJoinDate: new Date(employee.companyJoinDate),
            ttId: employee.ttId,
            departmentId,
          },
        });

        const existingEvent = await tx.userEvents.findFirst({
          where: { userId: user.id, type: 'joined_company' },
        });
        if (!existingEvent) {
          await tx.userEvents.create({
            data: {
              userId: user.id,
              type: 'joined_company',
              source: 'system',
              eventDate: new Date(employee.companyJoinDate),
              details: {},
              createdBy: user.id,
            },
          });
        }
      });
    }

    // Closed permission catalog (idempotent by name).
    const permissionIds = new Map<string, string>();
    for (const name of CLOSED_PERMISSION_CATALOG) {
      const permission = await prisma.permission.upsert({
        where: { name },
        update: {},
        create: { name },
      });
      permissionIds.set(name, permission.id);
    }

    // HR Admin functional role (idempotent by name), carrying the full
    // permission set.
    const hrAdminPolicy = await prisma.policy.upsert({
      where: { name: 'HR Admin' },
      update: {},
      create: { name: 'HR Admin' },
    });
    for (const name of CLOSED_PERMISSION_CATALOG) {
      const permissionId = permissionIds.get(name);
      if (!permissionId) continue;
      await prisma.policyPermission.upsert({
        where: {
          policyId_permissionId: {
            policyId: hrAdminPolicy.id,
            permissionId,
          },
        },
        update: {},
        create: { policyId: hrAdminPolicy.id, permissionId },
      });
    }

    // AD-12/FR-1: exactly one bootstrap User holds HR Admin, assigned here
    // — no other path in this domain may grant a functional role.
    const root = await prisma.user.findUniqueOrThrow({
      where: { workEmail: ROOT_WORK_EMAIL },
    });
    const alreadyAssigned = await prisma.userPolicy.findUnique({
      where: {
        userId_policyId: { userId: root.id, policyId: hrAdminPolicy.id },
      },
    });
    if (!alreadyAssigned) {
      await prisma.userPolicy.create({
        data: { userId: root.id, policyId: hrAdminPolicy.id },
      });
    }

    // eslint-disable-next-line no-console
    console.log(
      `Seed complete: ${POPULATION.length} users imported, HR Admin bootstrap = ${ROOT_WORK_EMAIL}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
