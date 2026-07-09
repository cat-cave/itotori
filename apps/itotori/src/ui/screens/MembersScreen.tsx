import { useState, type FormEvent, type ReactNode } from "react";
import { Badge, DataTable, Panel, StatReadout } from "@itotori/ds";
import type {
  ApiAuthBillingSeatUsageResponse,
  ApiMemberRecord,
  ApiMemberInvitationResponse,
  ApiPermissionSetRecord,
  ApiPrincipalPermissionSetGrantResponse,
} from "../../api-schema.js";
import type { ApiCallSettledState } from "../../api-client.js";
import { apiClient } from "../client.js";
import { loadSelectedAccountId } from "../shell-account-scope.js";
import { useApiQuery } from "../use-api-resource.js";
import { EmptyState, ErrorState, LoadingState, ShellHeader } from "../states.js";
import "./MembersScreen.css";

export const membersRoutePathRegex = /^\/members\/?$/u;

export type MembersRouteParams = {
  accountId: string | null;
};

export function parseMembersRoute(pathname: string, search: string): MembersRouteParams | null {
  if (!membersRoutePathRegex.test(pathname)) {
    return null;
  }
  const params = new URLSearchParams(search);
  const raw = params.get("accountId");
  return { accountId: raw !== null && raw.length > 0 ? raw : null };
}

export function MembersScreen({ route }: { route: MembersRouteParams }): ReactNode {
  if (route.accountId !== null) {
    return <MembersForAccount accountId={route.accountId} />;
  }
  return <MembersFromIdentity />;
}

function MembersFromIdentity(): ReactNode {
  const identity = useApiQuery("auth.identity", {}, "members:identity");
  if (identity.state === "loading") {
    return (
      <main className="itotori-shell members-screen" data-screen="members" data-state="loading">
        <ShellHeader eyebrow="Account permissions" title="Members" />
        <LoadingState label="Loading account identity..." />
      </main>
    );
  }
  if (identity.state === "error") {
    return (
      <main className="itotori-shell members-screen" data-screen="members" data-state="error">
        <ShellHeader eyebrow="Account permissions" title="Members" />
        <ErrorState title="Members" error={identity.error} />
      </main>
    );
  }
  const selectedAccountId = loadSelectedAccountId();
  const account =
    identity.state === "ready"
      ? (identity.data.accounts.find((entry) => entry.accountId === selectedAccountId) ??
        identity.data.accounts[0] ??
        null)
      : null;
  if (account === null) {
    return (
      <main className="itotori-shell members-screen" data-screen="members" data-state="empty">
        <ShellHeader eyebrow="Account permissions" title="Members" />
        <EmptyState title="No account" message="No account memberships were returned." />
      </main>
    );
  }
  return <MembersForAccount accountId={account.accountId} accountName={account.accountName} />;
}

function MembersForAccount({
  accountId,
  accountName,
}: {
  accountId: string;
  accountName?: string;
}): ReactNode {
  const [revision, setRevision] = useState(0);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [lastInvitedEmail, setLastInvitedEmail] = useState<string | null>(null);
  const members = useApiQuery(
    "auth.members.list",
    { query: { accountId } },
    `members:list:${accountId}:${revision}`,
  );
  const permissionSets = useApiQuery(
    "auth.permissionSets.list",
    { query: { accountId } },
    `members:permission-sets:${accountId}:${revision}`,
  );
  const billing = useApiQuery(
    "auth.billing.seatUsage",
    { query: { accountId } },
    `members:billing:${accountId}:${revision}`,
  );

  const state =
    members.state === "error" || permissionSets.state === "error" || billing.state === "error"
      ? "error"
      : members.state === "loading" ||
          permissionSets.state === "loading" ||
          billing.state === "loading"
        ? "loading"
        : members.state === "empty"
          ? "empty"
          : permissionSets.state === "empty"
            ? "empty"
            : "ready";

  const applyGrantChange = async (input: {
    member: ApiMemberRecord;
    permissionSet: ApiPermissionSetRecord;
    currentlyGranted: boolean;
  }): Promise<void> => {
    const key = grantToggleKey(input.member.principalId, input.permissionSet.permissionSetId);
    setPendingKey(key);
    setMutationError(null);
    const routeId = input.currentlyGranted
      ? "auth.permissionSets.revoke"
      : "auth.permissionSets.grant";
    const result: ApiCallSettledState<ApiPrincipalPermissionSetGrantResponse> =
      await apiClient.request(routeId, {
        pathParams: {
          principalId: input.member.principalId,
          permissionSetId: input.permissionSet.permissionSetId,
        },
        body: { reason: null, requestId: null },
      });
    setPendingKey(null);
    if (result.state === "ready") {
      setRevision((value) => value + 1);
      return;
    }
    if (result.state === "error") {
      setMutationError(
        result.error.message ??
          `Permission update failed with status ${String(result.error.status)}.`,
      );
      return;
    }
    setMutationError("Permission update returned no member record.");
  };

  return (
    <main
      className="itotori-shell members-screen"
      data-screen="members"
      data-state={state}
      data-account-id={accountId}
    >
      <ShellHeader eyebrow="Account permissions" title="Members">
        <Badge status="active">{accountName ?? accountId}</Badge>
      </ShellHeader>
      {state === "loading" && <LoadingState label="Loading members..." />}
      {members.state === "error" && <ErrorState title="Members" error={members.error} />}
      {permissionSets.state === "error" && (
        <ErrorState title="Permission sets" error={permissionSets.error} />
      )}
      {billing.state === "error" && <ErrorState title="Billing" error={billing.error} />}
      {state === "empty" && (
        <EmptyState
          title="Members"
          message="No members or permission sets were returned for this account."
        />
      )}
      {state === "ready" &&
        members.state === "ready" &&
        permissionSets.state === "ready" &&
        billing.state === "ready" && (
          <MembersReady
            members={members.data.members}
            billing={billing.data}
            permissionSets={permissionSets.data.permissionSets}
            pendingKey={pendingKey}
            mutationError={mutationError}
            lastInvitedEmail={lastInvitedEmail}
            onInvited={(email) => {
              setLastInvitedEmail(email);
              setRevision((value) => value + 1);
            }}
            onGrantChange={applyGrantChange}
          />
        )}
    </main>
  );
}

function MembersReady({
  members,
  billing,
  permissionSets,
  pendingKey,
  mutationError,
  lastInvitedEmail,
  onInvited,
  onGrantChange,
}: {
  members: readonly ApiMemberRecord[];
  billing: ApiAuthBillingSeatUsageResponse;
  permissionSets: readonly ApiPermissionSetRecord[];
  pendingKey: string | null;
  mutationError: string | null;
  lastInvitedEmail: string | null;
  onInvited(email: string): void;
  onGrantChange(input: {
    member: ApiMemberRecord;
    permissionSet: ApiPermissionSetRecord;
    currentlyGranted: boolean;
  }): Promise<void>;
}): ReactNode {
  return (
    <section className="members-screen__body" aria-label="Members and permission sets">
      {mutationError !== null && (
        <Panel title="Permission update" eyebrow="Unavailable" tone="sakura">
          <p role="alert">{mutationError}</p>
        </Panel>
      )}
      <BillingSeatPanel billing={billing} />
      <InviteMemberPanel
        accountId={billing.accountId}
        permissionSets={permissionSets}
        lastInvitedEmail={lastInvitedEmail}
        onInvited={onInvited}
      />
      <Panel
        title="Permission grants"
        eyebrow="Permission sets"
        lamps={<Badge status="active">{`${members.length} members`}</Badge>}
      >
        <DataTable
          caption="Members and granted permission sets"
          rows={members}
          getRowKey={(member) => member.membershipId}
          columns={[
            {
              key: "member",
              header: "Member",
              render: (member) => (
                <div className="members-screen__member">
                  <strong>{member.displayName}</strong>
                  <span>{member.email ?? member.userId}</span>
                </div>
              ),
            },
            {
              key: "principal",
              header: "Principal",
              render: (member) => (
                <code className="members-screen__principal">{member.principalId}</code>
              ),
            },
            {
              key: "grants",
              header: "Permission sets",
              render: (member) => (
                <div className="members-screen__grant-grid">
                  {permissionSets.map((permissionSet) => {
                    const checked = member.permissionSetIds.includes(permissionSet.permissionSetId);
                    const key = grantToggleKey(member.principalId, permissionSet.permissionSetId);
                    return (
                      <label
                        key={permissionSet.permissionSetId}
                        className="members-screen__grant-toggle"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={pendingKey !== null}
                          aria-label={`${checked ? "Revoke" : "Grant"} ${permissionSet.name} for ${member.displayName}`}
                          onChange={() => {
                            void onGrantChange({
                              member,
                              permissionSet,
                              currentlyGranted: checked,
                            });
                          }}
                        />
                        <span>{permissionSet.name}</span>
                        {pendingKey === key && <span role="status">updating</span>}
                      </label>
                    );
                  })}
                </div>
              ),
            },
          ]}
        />
      </Panel>
    </section>
  );
}

function BillingSeatPanel({ billing }: { billing: ApiAuthBillingSeatUsageResponse }): ReactNode {
  return (
    <Panel
      title="Plan and seats"
      eyebrow={billing.planName}
      lamps={
        <Badge status={billing.overSeatLimit ? "failed" : "active"}>
          {billing.overSeatLimit ? "over limit" : billing.planId}
        </Badge>
      }
    >
      <div className="members-screen__billing-grid">
        <StatReadout label="Used seats" value={billing.usedSeats} unit={`/ ${billing.seatLimit}`} />
        <StatReadout label="Available" value={billing.availableSeats} unit="seats" />
        <StatReadout label="Pending invites" value={billing.pendingInvitations} />
        <StatReadout label="Billing" value={formatBillingPeriod(billing.billingPeriod)} />
      </div>
    </Panel>
  );
}

function InviteMemberPanel({
  accountId,
  permissionSets,
  lastInvitedEmail,
  onInvited,
}: {
  accountId: string;
  permissionSets: readonly ApiPermissionSetRecord[];
  lastInvitedEmail: string | null;
  onInvited(email: string): void;
}): ReactNode {
  const [email, setEmail] = useState("");
  const [selectedPermissionSetIds, setSelectedPermissionSetIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ApiMemberInvitationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submitInvite = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (trimmedEmail.length === 0 || pending) {
      return;
    }
    setPending(true);
    setResult(null);
    setError(null);
    const invitation = await apiClient.request("auth.members.invite", {
      body: {
        accountId,
        email: trimmedEmail,
        initialPermissionSetIds: selectedPermissionSetIds,
        expiresAt: inviteExpiryIso(),
        reason: null,
        requestId: null,
      },
    });
    setPending(false);
    if (invitation.state === "ready") {
      setEmail("");
      setSelectedPermissionSetIds([]);
      setResult(invitation.data);
      onInvited(invitation.data.email);
      return;
    }
    if (invitation.state === "error") {
      setError(
        invitation.error.message ?? `Invite failed with status ${String(invitation.error.status)}.`,
      );
      return;
    }
    setError("Invite returned no invitation record.");
  };

  return (
    <Panel
      title="Invite member"
      eyebrow="Auth member API"
      lamps={result === null ? undefined : <Badge status="active">sent</Badge>}
    >
      <form className="members-screen__invite" onSubmit={(event) => void submitInvite(event)}>
        <label className="members-screen__field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            disabled={pending}
            required
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <fieldset className="members-screen__invite-sets" disabled={pending}>
          <legend>Initial permission sets</legend>
          <div className="members-screen__grant-grid">
            {permissionSets.map((permissionSet) => {
              const checked = selectedPermissionSetIds.includes(permissionSet.permissionSetId);
              return (
                <label key={permissionSet.permissionSetId} className="members-screen__grant-toggle">
                  <input
                    type="checkbox"
                    checked={checked}
                    aria-label={`Include ${permissionSet.name}`}
                    onChange={() => {
                      setSelectedPermissionSetIds((current) =>
                        checked
                          ? current.filter((id) => id !== permissionSet.permissionSetId)
                          : [...current, permissionSet.permissionSetId].sort(),
                      );
                    }}
                  />
                  <span>{permissionSet.name}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="members-screen__actions">
          <button type="submit" disabled={pending || email.trim().length === 0}>
            {pending ? "Sending..." : "Send invite"}
          </button>
          {(result !== null || lastInvitedEmail !== null) && (
            <span role="status">{`Invite sent to ${result?.email ?? lastInvitedEmail}`}</span>
          )}
          {error !== null && <span role="alert">{error}</span>}
        </div>
      </form>
    </Panel>
  );
}

function grantToggleKey(principalId: string, permissionSetId: string): string {
  return `${principalId}:${permissionSetId}`;
}

function inviteExpiryIso(): string {
  return new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
}

function formatBillingPeriod(period: ApiAuthBillingSeatUsageResponse["billingPeriod"]): string {
  switch (period) {
    case "annual":
      return "Annual";
    case "manual":
      return "Manual";
    case "monthly":
      return "Monthly";
  }
}
