import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { User } from '../../../generated/prisma/client';

export class UserEntity implements User {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'user@example.com' })
  email!: string;

  @ApiPropertyOptional({ example: 'John Doe', nullable: true, type: String })
  name!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}
