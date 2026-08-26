import { Injectable, NotFoundException } from '@nestjs/common';
import type { User } from '../../../generated/prisma/client';
import type { UserEditPatch } from '../../domain/interfaces/user.repository.port';
import { UserService } from '../../domain/services/user.service';
import type { UpdateUserDto } from '../dtos/update-user.dto';

@Injectable()
export class EditUserAction {
  constructor(private readonly userService: UserService) {}

  async execute(id: string, dto: UpdateUserDto): Promise<User> {
    const existing = await this.userService.findById(id);
    if (!existing) {
      throw new NotFoundException();
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

    return this.userService.update(id, patch);
  }
}
