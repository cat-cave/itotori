// shell-org-identity-switch — browser-side selected account scope.
//
// The server owns identity resolution; the shell owns the operator's active
// account choice for the current browser session and forwards it on typed API
// reads so routed surfaces reload under the selected organization.

export const ITOTORI_SELECTED_ACCOUNT_HEADER = "x-itotori-selected-account-id";

const selectedAccountStorageKey = "itotori.shell.selectedAccountId";

export function loadSelectedAccountId(): string | null {
  const storage = browserSessionStorage();
  if (storage === null) {
    return null;
  }
  const value = storage.getItem(selectedAccountStorageKey);
  return value === null || value.trim() === "" ? null : value;
}

export function saveSelectedAccountId(accountId: string | null): void {
  const storage = browserSessionStorage();
  if (storage === null) {
    return;
  }
  if (accountId === null || accountId.trim() === "") {
    storage.removeItem(selectedAccountStorageKey);
    return;
  }
  storage.setItem(selectedAccountStorageKey, accountId);
}

export function withSelectedAccountScope(init: RequestInit | undefined): RequestInit | undefined {
  const accountId = loadSelectedAccountId();
  if (accountId === null) {
    return init;
  }
  const headers = new Headers(init?.headers);
  headers.set(ITOTORI_SELECTED_ACCOUNT_HEADER, accountId);
  return { ...init, headers };
}

function browserSessionStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
