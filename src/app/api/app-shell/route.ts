import { errorResponse } from "@/lib/api-request";
import { keyEncryptionReady } from "@/lib/geo/crypto";
import { providerKeyStatuses } from "@/lib/geo/keys";
import { loadPlan } from "@/lib/geo/plan";
import { loadKeySettings, loadWorkspace } from "@/lib/geo/store";
import { inWorkspace, resolveWorkspaceAccess } from "@/lib/geo/team";
import { readData, withWorkspace } from "@/lib/portal-db";
import { contactProvider } from "@/lib/prospecting/contacts";
import { modelEnabled } from "@/lib/prospecting/model";
import { loadState } from "@/lib/prospecting/store";
import { searchAvailable } from "@/lib/prospecting/web";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// One side-effect-free read for everything the signed-in portal shell needs at
// mount: workspace state, the caller's theme preference, provider key status
// and the prospecting snapshot. It replaces four separate mount requests with
// a single invocation and a single token verification. Each section mirrors
// its standalone route exactly (those routes stay in place for refreshes,
// edits and deep links) and fails independently, so one broken section never
// takes down the rest of the shell. Nothing here writes; the welcome email
// stays a separate POST to /api/email/lifecycle.

type Section<T> = T | { error: string };

async function section<T>(load: () => Promise<T>): Promise<Section<T>> {
  try {
    return await load();
  } catch (error) {
    return { error: error instanceof Error ? error.message : "This section could not be loaded." };
  }
}

function prospectingCapabilities() {
  const provider = contactProvider();
  return { search: searchAvailable(), model: modelEnabled(), contactProvider: provider ? provider.label : null };
}

export async function GET(request: Request) {
  try {
    const access = await resolveWorkspaceAccess(request, "view");

    // Theme is per-user storage keyed by the caller's own uid (mirrors
    // /api/geo/ui-prefs) and intentionally lives outside the workspace context.
    const uiPrefs = await section(async () => {
      if (access.identity.idToken === "demo-token") return { theme: "dark" as const };
      const prefs = await withWorkspace(access.identity.uid, access.identity.idToken, () =>
        readData<{ theme?: unknown }>("ui")
      );
      return { theme: (prefs?.theme === "light" ? "light" : "dark") as "light" | "dark" };
    });

    return await inWorkspace(access, async () => {
      const [state, keys, prospecting] = await Promise.all([
        section(async () => {
          const [workspace, keySettings, plan] = await Promise.all([
            loadWorkspace(),
            loadKeySettings(),
            loadPlan(access.identity.email),
          ]);
          workspace.providers = providerKeyStatuses(keySettings);
          // Ops visibility: when the daily cron ran and what it did (counts only).
          let lastCron: unknown = null;
          try {
            if (access.identity.idToken !== "demo-token") {
              const { adminConfigured, getAdminDatabase } = await import("@/lib/geo/admin-store");
              if (adminConfigured()) lastCron = (await (await getAdminDatabase()).ref("geo/ops/lastCron").get()).val();
            }
          } catch {
            lastCron = null;
          }
          return {
            ...workspace,
            plan,
            lastCron,
            team: {
              role: access.role,
              shared: access.shared,
              teamsEnabled: access.teamsEnabled,
              workspaceOwner: access.shared ? undefined : access.identity.name,
            },
          };
        }),
        section(async () => {
          const settings = await loadKeySettings();
          return { providers: providerKeyStatuses(settings), keyEncryption: keyEncryptionReady() };
        }),
        section(async () => ({ state: await loadState(), capabilities: prospectingCapabilities() })),
      ]);
      return Response.json({ sections: { state, uiPrefs, keys, prospecting } }, { headers: NO_STORE });
    });
  } catch (error) {
    return errorResponse(error, "App shell");
  }
}
