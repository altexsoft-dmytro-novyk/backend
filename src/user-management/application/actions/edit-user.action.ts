import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { User } from '../../../generated/prisma/client';
import type { UserEditPatch } from '../../domain/interfaces/user.repository.port';
import type { SystemEventInput } from '../../domain/interfaces/user-event.repository.port';
import { CareerTimelineService } from '../../domain/services/career-timeline.service';
import { UserService } from '../../domain/services/user.service';
import type { UpdateUserDto } from '../dtos/update-user.dto';

@Injectable()
export class EditUserAction {
  private readonly logger = new Logger(EditUserAction.name);

  constructor(
    private readonly userService: UserService,
    private readonly careerTimeline: CareerTimelineService,
  ) {}

  async execute(
    id: string,
    dto: UpdateUserDto,
    viewerId: string,
  ): Promise<User> {
    const existing = await this.userService.findById(id);
    if (!existing) {
      throw new NotFoundException();
    }

    // birthDay / birthMonth are "both null together or both set together"
    // (database-schema.md §User). The DTO can't enforce this — it can't see the
    // current row. Compute the RESULTING pair (current value unless the PATCH
    // supplies the key; `null` if the PATCH sets it to `null`) and reject a
    // half-set outcome. Mirrors the import writer's rule (Story 1.1).
    const resultingBirthDay =
      dto.birthDay !== undefined ? dto.birthDay : existing.birthDay;
    const resultingBirthMonth =
      dto.birthMonth !== undefined ? dto.birthMonth : existing.birthMonth;
    if ((resultingBirthDay == null) !== (resultingBirthMonth == null)) {
      throw new BadRequestException(
        'birthDay and birthMonth must both be set or both be null',
      );
    }

    const patch: UserEditPatch = {};
    if (dto.firstName !== undefined) patch.firstName = dto.firstName;
    if (dto.lastName !== undefined) patch.lastName = dto.lastName;
    if (dto.position !== undefined) patch.position = dto.position;
    if (dto.country !== undefined) patch.country = dto.country;
    if (dto.city !== undefined) patch.city = dto.city;
    if (dto.workEmail !== undefined) patch.workEmail = dto.workEmail;
    if (dto.workPhone !== undefined) patch.workPhone = dto.workPhone;
    if (dto.birthDay !== undefined) patch.birthDay = dto.birthDay;
    if (dto.birthMonth !== undefined) patch.birthMonth = dto.birthMonth;
    if (dto.companyJoinDate !== undefined) {
      patch.companyJoinDate = new Date(dto.companyJoinDate);
    }
    if (dto.ttId !== undefined) patch.ttId = dto.ttId;

    // AD-11: a real `position` change writes one `position_change` system event
    // in the SAME transaction as the `user.update`. Absent key or unchanged
    // value → no event (um-ct-02 Test 2).
    const systemEvents: SystemEventInput[] = [];
    if (dto.position !== undefined && dto.position !== existing.position) {
      systemEvents.push(
        this.careerTimeline.positionChangeEvent(id, dto.position, viewerId),
      );
    }

    const updated = await this.userService.update(id, patch, systemEvents);
    this.logger.log(
      `user ${id} updated by ${viewerId} (fields: ${Object.keys(patch).join(', ') || 'none'}` +
        `${systemEvents.length > 0 ? '; position_change event written' : ''})`,
    );
    return updated;
  }
}
