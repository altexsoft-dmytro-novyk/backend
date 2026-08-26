import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { User } from '../../../generated/prisma/client';
import type { UserEntity } from '../../domain/entities/user.entity';
import { UserService } from '../../domain/services/user.service';
import type { CreateUserDto } from '../dtos/create-user.dto';

@Injectable()
export class RegisterUserAction {
  private readonly logger = new Logger(RegisterUserAction.name);

  constructor(private readonly userService: UserService) {}

  async execute(dto: CreateUserDto, createdBy: string): Promise<User> {
    // um-reg-04 requires "email already registered" to take priority over
    // "other required fields missing" for the same request — so the
    // duplicate check runs before completeness validation, not after.
    const existing = await this.userService.findByWorkEmail(dto.workEmail);
    if (existing) {
      throw new ConflictException('A user with this workEmail already exists');
    }

    const missingFields = (
      ['position', 'country', 'city', 'companyJoinDate'] as const
    ).filter((field) => !dto[field]);
    if (missingFields.length > 0) {
      throw new BadRequestException(
        missingFields.map((field) => `${field} is required`),
      );
    }

    const props: UserEntity = {
      firstName: dto.firstName,
      lastName: dto.lastName,
      position: dto.position!,
      country: dto.country!,
      city: dto.city!,
      workEmail: dto.workEmail,
      workPhone: dto.workPhone,
      birthDay: dto.birthDay,
      birthMonth: dto.birthMonth,
      companyJoinDate: new Date(dto.companyJoinDate!),
      ttId: dto.ttId,
    };

    const user = await this.userService.create(props, createdBy);

    const dispatchError = await this.userService.dispatchMagicLink(
      user.workEmail,
    );
    if (dispatchError) {
      const message =
        dispatchError instanceof Error
          ? dispatchError.message
          : 'unknown error';
      this.logger.warn(
        `Magic-link dispatch failed for ${user.workEmail}: ${message}`,
      );
    }

    return user;
  }
}
