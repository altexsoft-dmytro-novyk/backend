import { Injectable } from '@nestjs/common';

// Epic 5 Story 5.2 (AD-20) — the in-process tallies the `GET /health/departures`
// surface exposes alongside the counters computed live from the `departures`
// table. Deliberately in-memory and per-process (AD-20 defers the shared
// observability vendor); a process restart resets them.
@Injectable()
export class DepartureMetricsService {
  private _reclaimedLeaseCount = 0;
  private _requestTimeCutoffDenialsTotal = 0;

  get reclaimedLeaseCount(): number {
    return this._reclaimedLeaseCount;
  }

  get requestTimeCutoffDenialsTotal(): number {
    return this._requestTimeCutoffDenialsTotal;
  }

  recordReclaimedLease(count = 1): void {
    this._reclaimedLeaseCount += count;
  }

  recordRequestTimeCutoffDenial(): void {
    this._requestTimeCutoffDenialsTotal += 1;
  }
}
