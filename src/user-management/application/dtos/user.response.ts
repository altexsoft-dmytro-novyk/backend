import type { User } from '../../../generated/prisma/client';

export type UserResponse = Omit<User, 'companyJoinDate'> & {
  companyJoinDate: string;
};

// `companyJoinDate` is `@db.Date` (no time component) — serialize it as
// the date-only string the column actually represents, not a full
// datetime with a spurious midnight-UTC time.
export function toUserResponse(user: User): UserResponse {
  return {
    ...user,
    companyJoinDate: user.companyJoinDate.toISOString().slice(0, 10),
  };
}
