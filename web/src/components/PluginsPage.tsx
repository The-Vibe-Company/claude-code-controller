import { useEffect, useState } from "react";
import { api, type PluginRuntimeInfo } from "../api.js";
import { useStore } from "../store.js";
import { NotificationPluginConfig } from "./NotificationPluginConfig.js";

// Custom config renderers for specific plugins. Falls back to JSON textarea if not listed.
const customConfigRenderers: Record<string, React.FC<{ plugin: PluginRuntimeInfo; onRefresh: () => void }>> = {
  notifications: NotificationPluginConfig,
};

interface PluginsPageProps {
  embedded?: boolean;
}

function stringifyConfig(config: unknown): string {
  try {
    return JSON.stringify(config ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export function PluginsPage({ embedded = false }: PluginsPageProps) {
  const plugins = useStore((s) => s.plugins);
  const setPlugins = useStore((s) => s.setPlugins);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const taskbarPluginPins = useStore((s) => s.taskbarPluginPins);
  const setTaskbarPluginPinned = useStore((s) => s.setTaskbarPluginPinned);
  const setTaskbarPluginFocus = useStore((s) => s.setTaskbarPluginFocus);
  const setTaskPanelOpen = useStore((s) => s.setTaskPanelOpen);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [draftById, setDraftById] = useState<Map<string, string>>(new Map());

  async function refreshPlugins(options?: { preserveDrafts?: boolean }) {
    const list = await api.listPlugins();
    setPlugins(list);
    const preserveDrafts = options?.preserveDrafts ?? false;
    setDraftById((prev) => {
      const next = new Map<string, string>();
      for (const plugin of list) {
        const serverDraft = stringifyConfig(plugin.config);
        const currentDraft = prev.get(plugin.id);
        if (preserveDrafts && currentDraft !== undefined && currentDraft !== serverDraft) {
          next.set(plugin.id, currentDraft);
        } else {
          next.set(plugin.id, serverDraft);
        }
      }
      return next;
    });
    return list;
  }

  useEffect(() => {
    refreshPlugins()
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  // refreshPlugins updates global and local plugin states.
  }, []);

  async function updatePlugin(plugin: PluginRuntimeInfo, enabled: boolean) {
    setSavingId(plugin.id);
    setError("");
    try {
      if (enabled) {
        await api.enablePlugin(plugin.id);
      } else {
        await api.disablePlugin(plugin.id);
      }
      await refreshPlugins({ preserveDrafts: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  async function saveConfig(plugin: PluginRuntimeInfo) {
    setSavingId(plugin.id);
    setError("");
    try {
      const raw = draftById.get(plugin.id) || "{}";
      const parsed = JSON.parse(raw) as unknown;
      const updated = await api.updatePluginConfig(plugin.id, parsed);
      await refreshPlugins({ preserveDrafts: true });
      setDraftById((prev) => {
        const next = new Map(prev);
        next.set(plugin.id, stringifyConfig(updated.config));
        return next;
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Plugins</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Enable automations and configure event-based triggers.
            </p>
          </div>
          {!embedded && (
            <button
              onClick={() => {
                window.location.hash = "";
              }}
              className="px-3 py-1.5 rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Back
            </button>
          )}
        </div>

        {error && <p className="text-sm text-cc-error">{error}</p>}

        {plugins.map((plugin) => (
          <section key={plugin.id} className="bg-cc-card border border-cc-border rounded-xl p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-cc-fg">{plugin.name}</h2>
                <p className="text-xs text-cc-muted">{plugin.description}</p>
                <p className="text-[11px] text-cc-muted mt-1">
                  id: <code className="font-mono-code">{plugin.id}</code> · v{plugin.version}
                </p>
                <p className="text-[11px] text-cc-muted mt-1">
                  priority: {plugin.priority} · mode: {plugin.blocking ? "blocking" : "non-blocking"}
                </p>
                <p className="text-[11px] text-cc-muted mt-1">
                  timeout: {plugin.timeoutMs}ms · fail policy: {plugin.failPolicy}
                </p>
              </div>
              <button
                onClick={() => updatePlugin(plugin, !plugin.enabled)}
                disabled={savingId === plugin.id}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  plugin.enabled
                    ? "bg-cc-success/10 text-cc-success hover:bg-cc-success/20"
                    : "bg-cc-hover text-cc-muted hover:text-cc-fg"
                }`}
              >
                {savingId === plugin.id ? "Saving..." : plugin.enabled ? "Enabled" : "Disabled"}
              </button>
            </div>

            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-cc-muted">
                Taskbar: expose a quick action in the top bar for this plugin.
              </p>
              <div className="flex items-center gap-2">
                {currentSessionId && (
                  <button
                    onClick={() => {
                      setTaskPanelOpen(true);
                      setTaskbarPluginFocus(plugin.id);
                    }}
                    className="px-2.5 py-1 rounded-lg text-[11px] text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                  >
                    Open in panel
                  </button>
                )}
                <button
                  onClick={() => setTaskbarPluginPinned(plugin.id, !taskbarPluginPins.has(plugin.id))}
                  className={`px-2.5 py-1 rounded-lg text-[11px] transition-colors cursor-pointer ${
                    taskbarPluginPins.has(plugin.id)
                      ? "bg-cc-primary/15 text-cc-primary hover:bg-cc-primary/20"
                      : "bg-cc-hover text-cc-muted hover:text-cc-fg"
                  }`}
                >
                  {taskbarPluginPins.has(plugin.id) ? "Pinned" : "Pin to taskbar"}
                </button>
              </div>
            </div>

            <div>
              <p className="text-[11px] text-cc-muted mb-1">Events: {plugin.events.join(", ")}</p>
              {customConfigRenderers[plugin.id] ? (
                (() => {
                  const CustomRenderer = customConfigRenderers[plugin.id];
                  return <CustomRenderer plugin={plugin} onRefresh={() => refreshPlugins({ preserveDrafts: true })} />;
                })()
              ) : (
                <>
                  <textarea
                    value={draftById.get(plugin.id) || "{}"}
                    onChange={(e) => {
                      const value = e.target.value;
                      setDraftById((prev) => {
                        const next = new Map(prev);
                        next.set(plugin.id, value);
                        return next;
                      });
                    }}
                    rows={8}
                    className="w-full px-3 py-2.5 text-xs bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg font-mono-code focus:outline-none focus:border-cc-primary/60"
                  />
                  <div className="flex justify-end mt-3">
                    <button
                      onClick={() => saveConfig(plugin)}
                      disabled={savingId === plugin.id}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer disabled:bg-cc-hover disabled:text-cc-muted disabled:cursor-not-allowed"
                    >
                      Save config
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
