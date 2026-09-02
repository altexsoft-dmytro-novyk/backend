import { SetMetadata } from '@nestjs/common';

export const SELF_ONLY_KEY = 'selfOnly';

// Marks a `:id`-scoped route as a pure identity rule: the caller may act only
// on their own row (`session.userId === :id`). This is NOT a functional
// permission — it never touches the access-control facade (Open Decision vi:
// there is no `user-management:upload-photo` key). Used by `SelfOnlyGuard`.
// Mirrors `umac-09` (FR-9: Self can directly write only their own photo).
export const SelfOnly = () => SetMetadata(SELF_ONLY_KEY, true);
