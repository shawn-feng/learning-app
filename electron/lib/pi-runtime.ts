import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getAuthPath } from "./config";
import fs from "fs";

const cacheKey = "__learningAppModelRuntime";

export async function getSharedRuntime(): Promise<ModelRuntime> {
  const g = globalThis as any;
  if (!g[cacheKey]) {
    const authPath = getAuthPath();
    // Ensure auth.json exists with valid structure
    if (!fs.existsSync(authPath) || fs.statSync(authPath).size < 4) {
      fs.writeFileSync(authPath, "{}", "utf-8");
    }
    g[cacheKey] = await ModelRuntime.create({ authPath });
  }
  return g[cacheKey];
}

export async function getAvailableModels() {
  const runtime = await getSharedRuntime();
  return runtime.getAvailable();
}

export async function checkProviderAuth(providerId: string) {
  const runtime = await getSharedRuntime();
  return runtime.checkAuth(providerId);
}

export async function setProviderApiKey(providerId: string, apiKey: string) {
  // Pi SDK reads credentials from auth.json directly.
  // Write API key to auth.json, then recreate the runtime singleton.
  const authPath = getAuthPath();
  let auth: Record<string, any> = {};
  try {
    if (fs.existsSync(authPath)) {
      auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    }
  } catch {
    auth = {};
  }

  auth[providerId] = { type: "api_key", key: apiKey };

  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8");

  // Invalidate cached runtime so next call picks up new credentials
  const g = globalThis as any;
  if (g[cacheKey]) {
    try { g[cacheKey].dispose?.(); } catch {}
    delete g[cacheKey];
  }
}
