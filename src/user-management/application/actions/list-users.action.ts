import { Injectable } from '@nestjs/common';
import type {
  UserListFilter,
  UserListPage,
} from '../../domain/interfaces/user.repository.port';
import { UserService } from '../../domain/services/user.service';
import type { ListUsersQueryDto } from '../dtos/list-users-query.dto';

@Injectable()
export class ListUsersAction {
  constructor(private readonly userService: UserService) {}

  execute(query: ListUsersQueryDto): Promise<UserListPage> {
    const filter: UserListFilter = {};
    if (query.firstName !== undefined) filter.firstName = query.firstName;
    if (query.lastName !== undefined) filter.lastName = query.lastName;
    if (query.position !== undefined) filter.position = query.position;
    if (query.country !== undefined) filter.country = query.country;
    if (query.city !== undefined) filter.city = query.city;
    if (query.workEmail !== undefined) filter.workEmail = query.workEmail;
    if (query.workPhone !== undefined) filter.workPhone = query.workPhone;
    if (query.birthDay !== undefined) filter.birthDay = query.birthDay;
    if (query.birthMonth !== undefined) filter.birthMonth = query.birthMonth;
    if (query.companyJoinDate !== undefined) {
      filter.companyJoinDate = new Date(query.companyJoinDate);
    }
    if (query.ttId !== undefined) filter.ttId = query.ttId;
    if (query.isActive !== undefined) filter.isActive = query.isActive;

    return this.userService.list(filter, query.page, query.pageSize);
  }
}
