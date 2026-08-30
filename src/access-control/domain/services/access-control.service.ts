import { Inject, Injectable } from '@nestjs/common';
import { ORG_GRAPH_READER_PORT } from '../interfaces/org-graph-reader.port';
import type { OrgGraphReaderPort } from '../interfaces/org-graph-reader.port';
import { POLICY_READER_PORT } from '../interfaces/policy-reader.port';
import type { PolicyReaderPort } from '../interfaces/policy-reader.port';
import { mergeAccessLevels, SECTION_MATRIX } from '../section-matrix';
import { AccessLevel, Audience, SectionId } from '../types';
import { AudienceResolverService } from './audience-resolver.service';

// CAP-1: the single facade entry point every bounded context must go
// through for functional-permission, audience, and base section decisions.
// AD-1: only domain/services/ may inject a port token.
@Injectable()
export class AccessControlService {
  constructor(
    @Inject(ORG_GRAPH_READER_PORT)
    private readonly orgGraph: OrgGraphReaderPort,
    @Inject(POLICY_READER_PORT)
    private readonly policyReader: PolicyReaderPort,
    private readonly audienceResolver: AudienceResolverService,
  ) {}

  /** AD-17: due actor/target check, exposed for write-gate use by consumers. */
  async isDeparted(userId: string): Promise<boolean> {
    return this.orgGraph.isDeparted(userId);
  }

  /** AD-26: narrower manual-write rule for S9 — direct manager only, not transitive. */
  async isDirectManager(actorId: string, targetId: string): Promise<boolean> {
    return this.orgGraph.isDirectManager(actorId, targetId);
  }

  /** Phase 1: direct-assigned PP endpoint only. */
  async isAssignedPP(actorId: string, targetId: string): Promise<boolean> {
    return this.orgGraph.isAssignedPP(actorId, targetId);
  }

  /**
   * Exposes the resolved audience set for consumers that need to project a
   * response differently per audience (e.g. S11 colleague name-only, S16
   * per-field visibility tiers, S7/S8 flag filtering) beyond the single
   * none/read/write decision canAccessSection returns. Still resolved live,
   * still fail-closed the same way (empty set only if target missing/actor
   * departed — callers should already have gone through canAccessSection).
   */
  async getAudiences(actorId: string, targetId: string): Promise<Audience[]> {
    if (await this.orgGraph.isDeparted(actorId)) return [];
    if (!(await this.orgGraph.userExists(targetId))) return [];
    const audiences = await this.audienceResolver.resolveAudiences(
      actorId,
      targetId,
    );
    return Array.from(audiences);
  }

  /**
   * CAP-3: live FR decision from Policy/Permission/UserPolicy, independent
   * of audience data. Fail-closed on a due actor.
   */
  async isAllowed(actorId: string, permissionName: string): Promise<boolean> {
    if (await this.orgGraph.isDeparted(actorId)) return false;
    return this.policyReader.hasPermission(actorId, permissionName);
  }

  /**
   * CAP-4: live none/read/write decision for one section and target,
   * merged per AD-14 across whichever audiences the actor qualifies for.
   */
  async canAccessSection(
    actorId: string,
    targetId: string,
    section: SectionId,
  ): Promise<AccessLevel> {
    if (await this.orgGraph.isDeparted(actorId)) return 'none';
    if (!(await this.orgGraph.userExists(targetId))) return 'none';

    const audiences = await this.audienceResolver.resolveAudiences(
      actorId,
      targetId,
    );
    const cell = SECTION_MATRIX[section];
    const levels = Array.from(audiences).map((audience) => cell[audience]);
    return mergeAccessLevels(levels);
  }

  /**
   * Dual-gate helper (SPEC Constraint: "a mutation requires both live FR
   * permission and write section access"). An actor with zero explicit
   * Policy attachments is the ordinary-employee baseline and is not further
   * restricted by this check — matrix write access already governs them.
   * Once an admin has explicitly attached a Policy to someone, that Policy's
   * permission set becomes the authoritative narrower command rule for
   * section-write commands, matching the functional-permission suite's
   * "attachment exists, it just doesn't include this one" fixture shape.
   */
  async hasSectionWritePermission(
    actorId: string,
    section: SectionId,
  ): Promise<boolean> {
    if (await this.orgGraph.isDeparted(actorId)) return false;
    if (!(await this.policyReader.hasAnyPolicyAttached(actorId))) return true;
    return this.policyReader.hasPermission(actorId, `section:${section}:write`);
  }

  /** AD-9: /roles admin catalog read. */
  async listPolicies(): Promise<{ id: string; name: string }[]> {
    return this.policyReader.listPolicies();
  }

  /** AD-9: revoke one policy attachment. */
  async revokeUserPolicy(userId: string, policyId: string): Promise<void> {
    return this.policyReader.revokeUserPolicy(userId, policyId);
  }
}
