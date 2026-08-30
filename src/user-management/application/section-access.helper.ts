import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AccessControlAction } from '../../access-control/application/actions/access-control.action';
import { SectionId } from '../../access-control/domain/types';

// AD-3/AD-23: every read/write in this controller-bearing module goes
// through AccessControl first. Shared so every route applies the same
// leak-safe denial convention (404 no-access, 403 write-on-read-only or
// missing FR) instead of re-deriving it per route.
export async function assertSectionRead(
  accessControl: AccessControlAction,
  actorId: string,
  targetId: string,
  section: SectionId,
): Promise<void> {
  const level = await accessControl.canAccessSection(
    actorId,
    targetId,
    section,
  );
  if (level === 'none') throw new NotFoundException();
}

export async function assertSectionWrite(
  accessControl: AccessControlAction,
  actorId: string,
  targetId: string,
  section: SectionId,
): Promise<void> {
  const level = await accessControl.canAccessSection(
    actorId,
    targetId,
    section,
  );
  if (level === 'none') throw new NotFoundException();
  if (level !== 'write') throw new ForbiddenException();

  // AD-17: a departed target's profile is write-denied for everyone, reads
  // stay unaffected.
  if (await accessControl.isDeparted(targetId)) throw new ForbiddenException();

  // SPEC Constraint: a mutation requires both live FR permission and write
  // section access.
  const hasPermission = await accessControl.hasSectionWritePermission(
    actorId,
    section,
  );
  if (!hasPermission) throw new ForbiddenException();
}
