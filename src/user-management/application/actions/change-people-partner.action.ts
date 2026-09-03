import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { OrgRelationshipService } from '../../domain/services/org-relationship.service';
import { DepartureService } from '../../domain/services/departure.service';
import { UserService } from '../../domain/services/user.service';
import { UpdatePeoplePartnerDto } from '../dtos/update-people-partner.dto';
import {
  toRelationshipResponse,
  type RelationshipResponse,
} from '../dtos/relationship.response';

// Story 4.2 — the `PUT /users/:employeeId/relationships/people-partner` handler
// (create-or-atomically-replace). The capability gate (`org:relationships:write`)
// is `AccessControlGuard` via `@RequireFeature` (no-target `isAllowed` —
// DEC-UM-002, never a `User.position` / role-name check); `SessionGuard` gives
// the `401`. This action owns the self-assignment rejection (`400`), the target
// eligibility checks (unknown → `404`, inactive → `422`; scenario-stage
// proposal, spec-4-2 §3), and the `stale` → `409` mapping. The create-vs-replace
// decision and the same-transaction edge+journal write are in the repository.
@Injectable()
export class ChangePeoplePartnerAction {
  constructor(
    private readonly orgRelationships: OrgRelationshipService,
    private readonly userService: UserService,
    private readonly departures: DepartureService,
  ) {}

  async execute(
    viewerId: string,
    employeeId: string,
    dto: UpdatePeoplePartnerDto,
  ): Promise<RelationshipResponse> {
    if (employeeId === dto.targetId) {
      // App-level pre-check before the transaction opens; the
      // `userId <> reportsToUserId` CHECK is the backstop (never a raw 500).
      throw new BadRequestException(
        'an employee cannot be their own people partner',
      );
    }

    const target = await this.userService.findById(dto.targetId);
    if (!target) {
      // Leak-free: an unknown target is a plain 404, no 404-vs-403 surface.
      throw new NotFoundException();
    }
    if (target.isActive === false) {
      // Well-formed request, ineligible target: the PP audience is edge-derived,
      // but the endpoint of the edge must be an active user.
      throw new UnprocessableEntityException(
        'the people partner target is not an active user',
      );
    }

    // Post-schedule forward guard (Story 5.1 / spec §7).
    if (await this.departures.hasNonAppliedDeparture(dto.targetId)) {
      throw new ConflictException({ error: 'target_has_scheduled_departure' });
    }

    const result = await this.orgRelationships.changePeoplePartner({
      subjectId: employeeId,
      targetId: dto.targetId,
      expectedCurrentTargetId: dto.expectedCurrentTargetId,
      actorId: viewerId,
    });

    if (result.outcome === 'stale') {
      throw new ConflictException(
        'the current people partner does not match expectedCurrentTargetId',
      );
    }

    return toRelationshipResponse(result.relationship);
  }
}
