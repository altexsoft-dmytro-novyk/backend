// DI token for the magic-link token lifetime, in minutes (DEC-UM-004:
// configuration-owned). The module binds it from `MAGIC_LINK_TTL_MINUTES` env
// via `ConfigService` so the domain service never imports config infrastructure.
export const MAGIC_LINK_TTL_MINUTES = Symbol('MAGIC_LINK_TTL_MINUTES');
