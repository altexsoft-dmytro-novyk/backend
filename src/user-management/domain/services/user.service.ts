import { Inject, Injectable } from '@nestjs/common';
import type { User } from '../../../generated/prisma/client';
import type { UserEntity } from '../entities/user.entity';
import {
  USER_REPOSITORY_PORT,
  type UserEditPatch,
  type UserListFilter,
  type UserListPage,
  type UserRepositoryPort,
} from '../interfaces/user.repository.port';

// The only holder of this context's repository/dispatcher ports (AD-2) —
// application/actions/ depend on this service, never on a port token
// directly. `@Injectable`/`@Inject` are DI wiring, not transport: this
// class still never imports Prisma, HTTP types, or an adapter class by
// name, only the port interfaces declared in domain/interfaces/.
@Injectable()
export class UserService {
  constructor(
    @Inject(USER_REPOSITORY_PORT)
    private readonly userRepository: UserRepositoryPort,
  ) {}

  findByWorkEmail(workEmail: string): Promise<User | null> {
    return this.userRepository.findByWorkEmail(workEmail);
  }

  findById(id: string): Promise<User | null> {
    return this.userRepository.findById(id);
  }

  create(props: UserEntity, createdBy: string): Promise<User> {
    return this.userRepository.create(props, createdBy);
  }

  update(id: string, patch: UserEditPatch): Promise<User> {
    return this.userRepository.update(id, patch);
  }

  deactivate(id: string): Promise<User> {
    return this.userRepository.deactivate(id);
  }

  list(
    filter: UserListFilter,
    page: number,
    pageSize: number,
  ): Promise<UserListPage> {
    return this.userRepository.list(filter, page, pageSize);
  }
}
