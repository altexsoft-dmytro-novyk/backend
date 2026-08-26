export interface MagicLinkDispatcherPort {
  dispatch(workEmail: string): Promise<void>;
}

export const MAGIC_LINK_DISPATCHER_PORT = Symbol('MAGIC_LINK_DISPATCHER_PORT');
