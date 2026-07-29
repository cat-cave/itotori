import type { AuthorizationActor } from "../authorization.js";
import type { ItotoriDatabase } from "../connection.js";
import { AuthMemberManagementRepositoryOperations } from "./auth-member-management-repository-operations.js";
import type {
  AcceptMemberInvitationInput,
  InviteMemberInput,
  ItotoriAuthMemberManagementRepositoryPort,
  MemberInvitationRecord,
  MemberRecord,
  RemoveMemberInput,
} from "./auth-member-management-repository-types.js";

export {
  authMembersManagePermission,
  ItotoriAuthMemberManagementRepositoryError,
} from "./auth-member-management-repository-types.js";
export type {
  AcceptMemberInvitationInput,
  InviteMemberInput,
  ItotoriAuthMemberManagementRepositoryPort,
  MemberInvitationRecord,
  MemberRecord,
  RemoveMemberInput,
} from "./auth-member-management-repository-types.js";

export class ItotoriAuthMemberManagementRepository implements ItotoriAuthMemberManagementRepositoryPort {
  private readonly operations: AuthMemberManagementRepositoryOperations;

  constructor(db: ItotoriDatabase) {
    this.operations = new AuthMemberManagementRepositoryOperations(db);
  }

  async inviteMember(
    actor: AuthorizationActor,
    input: InviteMemberInput,
  ): Promise<MemberInvitationRecord> {
    return this.operations.inviteMember(actor, input);
  }

  async acceptInvitation(
    actor: AuthorizationActor,
    input: AcceptMemberInvitationInput,
  ): Promise<MemberRecord> {
    return this.operations.acceptInvitation(actor, input);
  }

  async listMembers(actor: AuthorizationActor, accountId: string): Promise<MemberRecord[]> {
    return this.operations.listMembers(actor, accountId);
  }

  async removeMember(actor: AuthorizationActor, input: RemoveMemberInput): Promise<MemberRecord> {
    return this.operations.removeMember(actor, input);
  }
}
