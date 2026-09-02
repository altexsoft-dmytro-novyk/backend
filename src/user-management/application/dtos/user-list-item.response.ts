import type { UserListRow } from '../../domain/interfaces/user.repository.port';

// um-list-08 — the fixed, fail-closed list-row projection: EXACTLY the 12
// `GET /users/:id` S1-card fields plus `employmentStatus`. Deliberately NOT
// `toUserResponse` (whole-row spread leaks `ttId`/`isActive`/`customFields`/
// `createdAt`/`createdBy`) and NOT the `{ data, canEdit }` card envelope (that
// is the detail route). Uniform for every viewer — per-row audience resolution
// is deferred (deferred-work §3.3.1).
export interface UserListItem {
  id: string;
  firstName: string;
  lastName: string;
  photo: string | null;
  position: string;
  country: string;
  city: string | null;
  workEmail: string;
  workPhone: string | null;
  birthDay: number | null;
  birthMonth: number | null;
  companyJoinDate: string;
  employmentStatus: 'active' | 'dismissed';
}

export function toUserListItem(row: UserListRow): UserListItem {
  const current = row.employmentStatuses[0];
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    photo: row.photo,
    position: row.position,
    country: row.country,
    city: row.city,
    workEmail: row.workEmail,
    workPhone: row.workPhone,
    birthDay: row.birthDay,
    birthMonth: row.birthMonth,
    // `@db.Date` column — serialize date-only, matching `toUserCardResponse`.
    companyJoinDate: row.companyJoinDate.toISOString().slice(0, 10),
    employmentStatus: current?.status === 'dismissed' ? 'dismissed' : 'active',
  };
}
