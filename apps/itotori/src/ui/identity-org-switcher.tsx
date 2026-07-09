// shell-org-identity-switch — signed-in identity + organization switcher.
//
// The shell reads the actor identity through the typed API client and exposes
// the actor plus account memberships in the toolbar. Selecting an account emits
// the account id so the shell can persist the active organization scope and
// land the operator back on the home surface.

import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ApiAuthIdentityAccount, ApiAuthIdentityResponse } from "../api-schema.js";
import { useApiQuery } from "./use-api-resource.js";
import { loadSelectedAccountId } from "./shell-account-scope.js";

export type IdentityOrgSelection = {
  accountId: string | null;
};

export type IdentityOrgSwitcherProps = {
  identity?: ApiAuthIdentityResponse;
  onSelect?: (selection: IdentityOrgSelection) => void;
};

export function selectInitialAccountId(
  identity: ApiAuthIdentityResponse | null,
  preferredAccountId: string | null = null,
): string | null {
  if (
    preferredAccountId !== null &&
    identity?.accounts.some((account) => account.accountId === preferredAccountId)
  ) {
    return preferredAccountId;
  }
  return identity?.accounts[0]?.accountId ?? null;
}

export function selectedIdentityAccount(
  identity: ApiAuthIdentityResponse | null,
  selectedAccountId: string | null,
): ApiAuthIdentityAccount | null {
  if (identity === null) {
    return null;
  }
  return (
    identity.accounts.find((account) => account.accountId === selectedAccountId) ??
    identity.accounts[0] ??
    null
  );
}

export function IdentityOrgSwitcher({
  identity: identityProp,
  onSelect,
}: IdentityOrgSwitcherProps): ReactNode {
  const read = useApiQuery("auth.identity", {}, "identity-org-switcher:identity");
  const identity = identityProp ?? (read.state === "ready" ? read.data : null);
  const selectedAccountIdSeed = useMemo(
    () => selectInitialAccountId(identity, loadSelectedAccountId()),
    [identity],
  );
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(selectedAccountIdSeed);
  const effectiveSelectedAccountId = accountIdInIdentity(identity, selectedAccountId)
    ? selectedAccountId
    : selectedAccountIdSeed;
  const selectedAccount = selectedIdentityAccount(identity, effectiveSelectedAccountId);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const readPhase =
    identityProp !== undefined
      ? "ready"
      : read.state === "loading"
        ? "loading"
        : read.state === "error"
          ? "error"
          : "ready";

  const pickAccount = useCallback(
    (accountId: string) => {
      setSelectedAccountId(accountId);
      onSelect?.({ accountId });
    },
    [onSelect],
  );

  return (
    <div
      className="itotori-identity-switcher"
      data-switcher="identity-org"
      data-switcher-phase={readPhase}
      data-switcher-open={open ? "true" : "false"}
      data-selected-account-id={effectiveSelectedAccountId ?? ""}
    >
      <button
        type="button"
        className="itotori-switcher__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        data-identity-switcher-trigger="true"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        {selectedAccount?.accountName ?? identity?.displayName ?? "Identity"}
      </button>
      {open && (
        <div
          className="itotori-switcher__panel"
          role="menu"
          aria-label="Switch identity and organization"
          data-identity-switcher-panel="true"
        >
          <IdentitySection
            label="Identity"
            dataSection="identity"
            isEmpty={identity === null}
            loading={readPhase === "loading"}
            error={readPhase === "error"}
          >
            {identity !== null && (
              <IdentityReadOnlyOption dataId={identity.userId}>
                <span>{identity.displayName}</span>
                <span>{identity.email ?? identity.userId}</span>
              </IdentityReadOnlyOption>
            )}
          </IdentitySection>
          <IdentitySection
            label="Organization"
            dataSection="organization"
            isEmpty={(identity?.accounts.length ?? 0) === 0}
            loading={readPhase === "loading"}
            error={readPhase === "error"}
          >
            {identity?.accounts.map((account) => {
              const active = account.accountId === effectiveSelectedAccountId;
              return (
                <IdentityOption
                  key={account.accountId}
                  active={active}
                  dataId={account.accountId}
                  onSelect={() => {
                    pickAccount(account.accountId);
                  }}
                >
                  <span>{account.accountName}</span>
                  <span>{account.accountSlug}</span>
                </IdentityOption>
              );
            })}
          </IdentitySection>
          <div className="itotori-switcher__panel-footer">
            <button
              type="button"
              className="itotori-switcher__close"
              data-identity-switcher-close="true"
              onClick={close}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function accountIdInIdentity(
  identity: ApiAuthIdentityResponse | null,
  accountId: string | null,
): accountId is string {
  return (
    identity !== null &&
    accountId !== null &&
    identity.accounts.some((account) => account.accountId === accountId)
  );
}

function IdentitySection({
  label,
  dataSection,
  isEmpty,
  loading,
  error,
  children,
}: {
  label: string;
  dataSection: string;
  isEmpty: boolean;
  loading: boolean;
  error: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="itotori-switcher__section" data-switcher-section={dataSection}>
      <p className="itotori-switcher__section-label">{label}</p>
      {loading && <p className="itotori-switcher__pending">Loading...</p>}
      {error && <p className="itotori-switcher__unavailable">Unavailable</p>}
      {!loading && !error && isEmpty && <p className="itotori-switcher__empty">None</p>}
      {!loading && !error && !isEmpty && (
        <div className="itotori-switcher__options" role="group" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
}

function IdentityOption({
  active,
  dataId,
  onSelect,
  children,
}: {
  active: boolean;
  dataId: string;
  onSelect: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      aria-current={active ? "true" : undefined}
      className="itotori-switcher__option"
      data-switcher-option-id={dataId}
      data-switcher-option-active={active ? "true" : "false"}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

function IdentityReadOnlyOption({
  dataId,
  children,
}: {
  dataId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      role="menuitem"
      aria-disabled="true"
      className="itotori-switcher__option"
      data-switcher-option-id={dataId}
      data-switcher-option-readonly="true"
    >
      {children}
    </div>
  );
}
