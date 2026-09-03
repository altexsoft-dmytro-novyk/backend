import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrgRelationshipService } from '../../domain/services/org-relationship.service';
import { PeoplePartnerQueryDto } from '../dtos/people-partner-query.dto';

// Story 4.2 — the `DELETE /users/:employeeId/relationships/people-partner`
// handler. The capability gate is `AccessControlGuard` via `@RequireFeature`;
// `SessionGuard` gives the `401`. No current PP → `404` (the domain "no PP
// sub-resource" 404, leak-free). A supplied `?expectedCurrentTargetId=` that no
// longer matches the current PP → `409`. On success the hard delete and one
// `AccessJournal` row (`before:` removed-edge snapshot, `after: null`) commit
// together in the repository.
@Injectable()
export class RemovePeoplePartnerAction {
  private readonly logger = new Logger(RemovePeoplePartnerAction.name);

  constructor(private readonly orgRelationships: OrgRelationshipService) {}

  async execute(
    viewerId: string,
    employeeId: string,
    query: PeoplePartnerQueryDto,
  ): Promise<void> {
    const result = await this.orgRelationships.removePeoplePartner({
      subjectId: employeeId,
      expectedCurrentTargetId: query.expectedCurrentTargetId,
      actorId: viewerId,
    });

    if (result.outcome === 'not-found') {
      throw new NotFoundException();
    }
    if (result.outcome === 'stale') {
      throw new ConflictException(
        'the current people partner does not match expectedCurrentTargetId',
      );
    }

    this.logger.log(
      `people partner removed for ${employeeId} (by ${viewerId})`,
    );
  }
}
