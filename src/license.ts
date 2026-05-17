// Lemon Squeezy license activation.
//
// Flow:
//   1. User pastes their license_key (from the LS receipt).
//   2. activate() POSTs to /v1/licenses/activate with key + instance_name.
//      LS returns an instance.id which we persist alongside the key.
//   3. validate() refreshes status on launch; offline we trust the cache.
//   4. deactivate() releases the instance so the seat frees up.
//
// Key + instance_id live in Windows Credential Manager via the secret_*
// Tauri commands. A non-sensitive snapshot (masked key, email, status,
// last-validated timestamp) is cached in localStorage so the UI can render
// before the network probe finishes.

import { useCallback, useEffect, useState } from "react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";

export const LS_CHECKOUT_URL =
  "https://drknowhow.lemonsqueezy.com/checkout/buy/627f5ad5-2aa2-4503-b79a-245e53abdbb3";

const API_BASE = "https://api.lemonsqueezy.com/v1/licenses";
const KEYRING_KEY = "r3write-license-key";
const KEYRING_INSTANCE = "r3write-license-instance";
const CACHE_KEY = "r3write.license.v1";

export type LicenseStatus = "unknown" | "unlicensed" | "active" | "invalid";

export interface LicenseState {
  status: LicenseStatus;
  customerEmail?: string;
  productName?: string;
  keyMasked?: string;
  activationLimit?: number | null;
  activationUsage?: number;
  lastValidatedAt?: number;
  errorMessage?: string;
}

const UNLICENSED: LicenseState = { status: "unlicensed" };

function maskKey(key: string): string {
  const tail = key.slice(-4) || "????";
  return `••••-••••-••••-••••-••••••••${tail}`;
}

function readCache(): LicenseState {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { status: "unknown" };
    return JSON.parse(raw) as LicenseState;
  } catch {
    return { status: "unknown" };
  }
}

function writeCache(s: LicenseState): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(s));
  } catch (e) {
    console.error("[r3write] license cache write failed:", e);
  }
}

function clearCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}

async function getStoredKey(): Promise<string> {
  try {
    const v = await invoke<string | null>("secret_get", { name: KEYRING_KEY });
    return v ?? "";
  } catch (e) {
    console.error("[r3write] license keyring read failed:", e);
    return "";
  }
}

async function getStoredInstance(): Promise<string> {
  try {
    const v = await invoke<string | null>("secret_get", { name: KEYRING_INSTANCE });
    return v ?? "";
  } catch (e) {
    console.error("[r3write] license keyring read failed:", e);
    return "";
  }
}

async function setStored(key: string, instance: string): Promise<void> {
  await invoke("secret_set", { name: KEYRING_KEY, value: key });
  await invoke("secret_set", { name: KEYRING_INSTANCE, value: instance });
}

async function clearStored(): Promise<void> {
  try {
    await invoke("secret_delete", { name: KEYRING_KEY });
  } catch (e) {
    console.error("[r3write] secret_delete license key:", e);
  }
  try {
    await invoke("secret_delete", { name: KEYRING_INSTANCE });
  } catch (e) {
    console.error("[r3write] secret_delete license instance:", e);
  }
}

interface LSLicenseResponse {
  activated?: boolean;
  deactivated?: boolean;
  valid?: boolean;
  error?: string | null;
  license_key?: {
    status?: string;
    key?: string;
    activation_limit?: number | null;
    activation_usage?: number;
  };
  instance?: { id?: string; name?: string };
  meta?: { product_name?: string; customer_email?: string };
}

function instanceName(): string {
  // Sent only on the first activate(); the LS dashboard surfaces it so the
  // user can tell their installs apart. Include a short random suffix so a
  // re-activation on the same box still gets a distinct row instead of
  // clobbering the previous one.
  const platform = navigator.platform || "unknown";
  const suffix = Math.random().toString(36).slice(2, 8);
  return `R3write — ${platform} — ${suffix}`;
}

async function postLS(
  path: "activate" | "validate" | "deactivate",
  body: Record<string, string>,
): Promise<LSLicenseResponse> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.append(k, v);
  const res = await tauriFetch(`${API_BASE}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as LSLicenseResponse;
  if (!res.ok && !data.error) {
    throw new Error(`Lemon Squeezy HTTP ${res.status}`);
  }
  return data;
}

function stateFromResponse(data: LSLicenseResponse, key: string): LicenseState {
  const lk = data.license_key;
  const ok = Boolean((data.activated || data.valid) && lk?.status === "active");
  return {
    status: ok ? "active" : "invalid",
    keyMasked: maskKey(key),
    customerEmail: data.meta?.customer_email,
    productName: data.meta?.product_name,
    activationLimit: lk?.activation_limit ?? null,
    activationUsage: lk?.activation_usage,
    lastValidatedAt: Date.now(),
    errorMessage: ok ? undefined : data.error || `License status: ${lk?.status ?? "unknown"}`,
  };
}

export async function activate(rawKey: string): Promise<LicenseState> {
  const key = rawKey.trim();
  if (!key) return { status: "invalid", errorMessage: "Enter a license key" };
  const data = await postLS("activate", {
    license_key: key,
    instance_name: instanceName(),
  });
  if (data.error) {
    return { status: "invalid", errorMessage: data.error, keyMasked: maskKey(key) };
  }
  const instance = data.instance?.id ?? "";
  if (!instance) {
    return {
      status: "invalid",
      errorMessage: "No instance returned by Lemon Squeezy",
      keyMasked: maskKey(key),
    };
  }
  await setStored(key, instance);
  const next = stateFromResponse(data, key);
  writeCache(next);
  return next;
}

export async function validate(): Promise<LicenseState> {
  const key = await getStoredKey();
  if (!key) return UNLICENSED;
  const instance = await getStoredInstance();
  const body: Record<string, string> = { license_key: key };
  if (instance) body.instance_id = instance;
  try {
    const data = await postLS("validate", body);
    if (data.error) {
      const next: LicenseState = {
        status: "invalid",
        keyMasked: maskKey(key),
        errorMessage: data.error,
        lastValidatedAt: Date.now(),
      };
      writeCache(next);
      return next;
    }
    const next = stateFromResponse(data, key);
    writeCache(next);
    return next;
  } catch (e) {
    // Offline / unreachable — trust the cache so a paid user isn't locked out
    // when their network drops. The next online check that returns invalid
    // will gate them.
    console.warn("[r3write] license /validate failed, using cache:", e);
    const cached = readCache();
    if (cached.status === "active") return cached;
    return cached.status === "unknown" ? { status: "unknown" } : cached;
  }
}

export async function deactivate(): Promise<void> {
  const key = await getStoredKey();
  const instance = await getStoredInstance();
  if (key && instance) {
    try {
      await postLS("deactivate", { license_key: key, instance_id: instance });
    } catch (e) {
      // Best-effort: clear local state regardless so the user can re-enter.
      console.warn("[r3write] license /deactivate failed, clearing locally:", e);
    }
  }
  await clearStored();
  clearCache();
}

export interface UseLicense {
  state: LicenseState;
  loading: boolean;
  refresh: () => Promise<void>;
  activate: (key: string) => Promise<LicenseState>;
  deactivate: () => Promise<void>;
}

export function useLicense(): UseLicense {
  const [state, setState] = useState<LicenseState>(() => readCache());
  const [loading, setLoading] = useState(state.status === "unknown");

  const refresh = useCallback(async () => {
    const next = await validate();
    setState(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doActivate = useCallback(async (key: string) => {
    setLoading(true);
    try {
      const next = await activate(key);
      setState(next);
      return next;
    } finally {
      setLoading(false);
    }
  }, []);

  const doDeactivate = useCallback(async () => {
    setLoading(true);
    try {
      await deactivate();
      setState(UNLICENSED);
    } finally {
      setLoading(false);
    }
  }, []);

  return { state, loading, refresh, activate: doActivate, deactivate: doDeactivate };
}
