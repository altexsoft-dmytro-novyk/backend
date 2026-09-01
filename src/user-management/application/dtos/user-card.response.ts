import type { User } from '../../../generated/prisma/client';

// CAP-3 — the minimal S1 identity card wrapped in the standard read envelope
// `{ data, canEdit }`, for the `GET /users/:id` handler ONLY. The shared
// `toUserResponse` (whole-row spread) is left untouched for the other five call
// sites (list items, POST, PATCH, DELETE, photo).
//
// `data` is EXACTLY these 12 S1 fields — it drops the non-S1 technical columns
// `ttId` (AD-13 external identity), `isActive` (internal row flag, not
// exposed), `customFields` (S16), `createdAt` / `createdBy` (audit, no named
// consumer).

export interface S1IdentityCard {
  id: string;
  firstName: string;
  lastName: string;
  photo: string | null;
  position: string;
  country: string;
  city: string;
  workEmail: string;
  workPhone: string | null;
  birthDay: number | null;
  birthMonth: number | null;
  // `companyJoinDate` is `@db.Date` (no time component) — serialize it as the
  // date-only string the column represents, matching `toUserResponse`.
  companyJoinDate: string;
}

export interface UserCardResponse {
  data: S1IdentityCard;
  canEdit: boolean;
}

export function toUserCardResponse(
  user: User,
  canEdit: boolean,
): UserCardResponse {
  return {
    data: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      photo: user.photo,
      position: user.position,
      country: user.country,
      city: user.city,
      workEmail: user.workEmail,
      workPhone: user.workPhone,
      birthDay: user.birthDay,
      birthMonth: user.birthMonth,
      companyJoinDate: user.companyJoinDate.toISOString().slice(0, 10),
    },
    canEdit,
  };
}
