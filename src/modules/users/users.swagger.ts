import { applyDecorators } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { UserEntity } from './entities/user.entity';

export const SwaggerCreateUser = () =>
  applyDecorators(
    ApiCreatedResponse({ type: UserEntity }),
    ApiConflictResponse({ description: 'Email already taken' }),
  );

export const SwaggerFindAllUsers = () =>
  applyDecorators(ApiOkResponse({ type: UserEntity, isArray: true }));

export const SwaggerFindOneUser = () =>
  applyDecorators(
    ApiOkResponse({ type: UserEntity }),
    ApiNotFoundResponse({ description: 'User not found' }),
  );

export const SwaggerUpdateUser = () =>
  applyDecorators(
    ApiOkResponse({ type: UserEntity }),
    ApiNotFoundResponse({ description: 'User not found' }),
    ApiConflictResponse({ description: 'Email already taken' }),
  );

export const SwaggerDeleteUser = () =>
  applyDecorators(
    ApiNoContentResponse({ description: 'User deleted' }),
    ApiNotFoundResponse({ description: 'User not found' }),
  );
