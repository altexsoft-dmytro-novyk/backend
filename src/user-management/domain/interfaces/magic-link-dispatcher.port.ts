// Outbound port for sending a magic-link email (AD-15 external integration).
// Story 2.1 widened `dispatch(workEmail)` → `dispatch(workEmail, token)`: a real
// adapter needs the raw token to build the emailed link (auth/README decision 6).
export interface MagicLinkDispatcherPort {
  dispatch(workEmail: string, token: string): Promise<void>;
}

export const MAGIC_LINK_DISPATCHER_PORT = Symbol('MAGIC_LINK_DISPATCHER_PORT');
