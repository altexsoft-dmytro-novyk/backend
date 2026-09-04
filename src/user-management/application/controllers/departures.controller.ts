import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { GetDepartureAction } from '../actions/get-departure.action';
import { RecordDepartureAction } from '../actions/record-departure.action';
import { RetryDepartureAction } from '../actions/retry-departure.action';
import {
  ReparentDepartureAction,
  type DepartureReparentingResponse,
} from '../actions/reparent-departure.action';
import { CurrentSession } from '../decorators/current-session.decorator';
import { RequireFeature } from '../decorators/require-feature.decorator';
import { DepartureReparentingDto } from '../dtos/departure-reparenting.dto';
import { RecordDepartureDto } from '../dtos/record-departure.dto';
import type { DepartureView } from '../../domain/services/departure.service';
import { AccessControlGuard } from '../guards/access-control.guard';
import { SessionGuard } from '../guards/session.guard';
import type { Session } from '../../domain/interfaces/session-resolver.port';

// Epic 5 Story 5.1 (AD-20) — the departure command + status surface. A separate
// `@Controller('users')` (NestJS allows many) so it does not bloat
// `users.controller.ts`. All three routes carry the dedicated
// `employee:departure:record` capability (no-target `isAllowed` through the
// facade — DEC-UM-002, never a `User.position` / role-name check);
// `AccessControlGuard` enforces it from `@RequireFeature`, and rechecks it on
// every idempotent replay. `SessionGuard` produces every `401`.
//
// There is deliberately NO `PATCH` / `DELETE` / cancel / reschedule route
// (spine Deferred — a product decision). `.../:departureId/retry` is Story 5.2.
const RECORD_A_DEPARTURE_FEATURE = 'employee:departure:record';

@Controller('users')
@UseGuards(SessionGuard, AccessControlGuard)
export class DeparturesController {
  constructor(
    private readonly recordDepartureAction: RecordDepartureAction,
    private readonly getDepartureAction: GetDepartureAction,
    private readonly reparentDepartureAction: ReparentDepartureAction,
    private readonly retryDepartureAction: RetryDepartureAction,
  ) {}

  // Nest returns `201` for a POST; the body is the bare projection (no envelope).
  @Post(':id/departures')
  @RequireFeature(RECORD_A_DEPARTURE_FEATURE)
  async record(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: RecordDepartureDto,
  ): Promise<DepartureView> {
    return this.recordDepartureAction.execute(
      session.userId,
      id,
      dto,
      idempotencyKey,
    );
  }

  @Get(':id/departures/:departureId')
  @RequireFeature(RECORD_A_DEPARTURE_FEATURE)
  async findOne(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Param('departureId') departureId: string,
  ): Promise<DepartureView> {
    return this.getDepartureAction.execute(session.userId, id, departureId);
  }

  // Story 5.2 — accelerate a `retry_wait` departure. `202` (accepted; makes the
  // row immediately eligible and runs a synchronous fenced apply pass);
  // `409 { error: 'departure_not_retryable' }` from any other state; `404` when
  // the id is unknown or belongs to another user. Same capability gate.
  @Post(':id/departures/:departureId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireFeature(RECORD_A_DEPARTURE_FEATURE)
  async retry(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Param('departureId') departureId: string,
  ): Promise<void> {
    await this.retryDepartureAction.execute(session.userId, id, departureId);
  }

  // Explicit user-confirmed blocker remediation. `POST` defaults to `201` in
  // Nest — pin it to `200`; the command is not a resource creation.
  @Post(':id/departure-reparenting')
  @HttpCode(HttpStatus.OK)
  @RequireFeature(RECORD_A_DEPARTURE_FEATURE)
  async reparent(
    @CurrentSession() session: Session,
    @Param('id') id: string,
    @Body() dto: DepartureReparentingDto,
  ): Promise<DepartureReparentingResponse> {
    return this.reparentDepartureAction.execute(session.userId, id, dto);
  }
}
