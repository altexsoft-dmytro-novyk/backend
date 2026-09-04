// The startup-validated `BUSINESS_TIME_ZONE` IANA string, provided to the
// `domain/services/` layer as a value token (mirrors `MAGIC_LINK_TTL_MINUTES`)
// so `DepartureService` never reads `process.env` or injects `ConfigService`.
// Wired in `user-management.module.ts` via `config.getOrThrow('BUSINESS_TIME_ZONE')`.
export const BUSINESS_TIME_ZONE = Symbol('BUSINESS_TIME_ZONE');
