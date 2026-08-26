export interface Session {
  userId: string;
}

export interface SessionResolverPort {
  resolve(authorizationHeader: string | undefined): Promise<Session | null>;
}

export const SESSION_RESOLVER_PORT = Symbol('SESSION_RESOLVER_PORT');
