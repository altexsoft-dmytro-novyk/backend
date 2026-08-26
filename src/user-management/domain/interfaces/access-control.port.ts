export interface AccessControlPort {
  isAllowed(userId: string, feature: string): Promise<boolean>;
  isAllowedForTarget(
    userId: string,
    feature: string,
    targetUserId: string,
  ): Promise<boolean>;
}

export const ACCESS_CONTROL_PORT = Symbol('ACCESS_CONTROL_PORT');
