import { type AuthorizationActor, type Permission, permissionValues } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";

export type InviteMemberInput = {
  actorPrincipalId: string;
  accountId: string;
  email: string;
  initialPermissionSetIds?: readonly string[];
  expiresAt: Date;
  reason?: string;
  requestId?: string;
};

export type AcceptMemberInvitationInput = {
  actorPrincipalId: string;
  invitationId: string;
  userId?: string;
  principalId?: string;
  displayName: string;
  email?: string;
  externalIdentity?: {
    provider: string;
    subject: string;
  };
  reason?: string;
  requestId?: string;
};

export type RemoveMemberInput = {
  actorPrincipalId: string;
  membershipId: string;
  reason?: string;
  requestId?: string;
};

export type MemberInvitationRecord = {
  invitationId: string;
  accountId: string;
  email: string;
  initialPermissionSetIds: string[];
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export type MemberRecord = {
  membershipId: string;
  accountId: string;
  userId: string;
  principalId: string;
  email: string | null;
  displayName: string;
  permissionSetIds: string[];
  createdAt: Date;
};

export interface ItotoriAuthMemberManagementRepositoryPort {
  inviteMember(
    actor: AuthorizationActor,
    input: InviteMemberInput,
  ): Promise<MemberInvitationRecord>;
  acceptInvitation(
    actor: AuthorizationActor,
    input: AcceptMemberInvitationInput,
  ): Promise<MemberRecord>;
  listMembers(actor: AuthorizationActor, accountId: string): Promise<MemberRecord[]>;
  removeMember(actor: AuthorizationActor, input: RemoveMemberInput): Promise<MemberRecord>;
}

export class ItotoriAuthMemberManagementRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ItotoriAuthMemberManagementRepositoryError";
  }
}

export type MemberTransaction = Parameters<Parameters<ItotoriDatabase["transaction"]>[0]>[0];

export const authMembersManagePermission = permissionValues.authMembersManage satisfies Permission;
