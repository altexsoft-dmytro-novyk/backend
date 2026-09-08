// The section keys User Management declares at its route gates
// (`@RequireSectionAccess`) and asks the `ACCESS_CONTROL_PORT` about. Human
// keys per SCP 2026-09-04 D4 — `S<n>` is a §3.2 matrix-row citation only,
// never an identifier passed across the port (PLAT-E4-S4.1b renamed the kernel
// side; this constant is the single spelling on the User Management side).
//
// Only sections with a live route consumer belong here. `profile:leave` /
// `profile:projects` have rows in the kernel's `SECTION_ACCESS_MATRIX` but no
// endpoint reads them, so they are deliberately absent — a key with no
// consumer is speculative surface.
export const PROFILE_IDENTITY_SECTION = 'profile:identity';
