import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { DepartureService } from '../../domain/services/departure.service';
import { UserService } from '../../domain/services/user.service';
import { DepartureReparentingDto } from '../dtos/departure-reparenting.dto';

/** The `POST /users/:id/departure-reparenting` success body. */
export interface DepartureReparentingResponse {
  reassigned: {
    directReports: number;
    departmentManager: boolean;
    peoplePartnerAssignments: number;
  };
  remainingExternalBlockers: number;
}

// Story 5.1 — the explicit, user-confirmed blocker remediation. Same capability
// gate as recording (`employee:departure:record`). It never records a
// departure. `targetId === :id` → `400`; unknown target → `404`; inactive
// target → `422` (mirrors Epic 4); a recomputed digest that no longer matches
// `expectedBlockerVersion` → `409 { error: 'blocker_version_stale' }`.
@Injectable()
export class ReparentDepartureAction {
  constructor(
    private readonly departures: DepartureService,
    private readonly userService: UserService,
  ) {}

  async execute(
    actorId: string,
    subjectId: string,
    dto: DepartureReparentingDto,
  ): Promise<DepartureReparentingResponse> {
    if (dto.targetId === subjectId) {
      throw new BadRequestException(
        'the re-parent target cannot be the departing employee',
      );
    }

    const target = await this.userService.findById(dto.targetId);
    if (!target) {
      throw new NotFoundException();
    }
    if (target.isActive === false) {
      throw new UnprocessableEntityException(
        'the re-parent target is not an active user',
      );
    }

    const result = await this.departures.reparent({
      userId: subjectId,
      targetId: dto.targetId,
      actorId,
      expectedBlockerVersion: dto.expectedBlockerVersion,
    });

    if (result.outcome === 'stale') {
      throw new ConflictException({ error: 'blocker_version_stale' });
    }

    return {
      reassigned: result.counts,
      remainingExternalBlockers: 0,
    };
  }
}
