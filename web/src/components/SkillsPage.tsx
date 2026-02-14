import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { PluginInfo, SkillInfo, SkillsResponse } from "../api.js";

// ─── SkillBadge ───────────────────────────────────────────────────────────────

function SkillBadge({ type }: { type: SkillInfo["type"] }) {
  const styles = {
    skill: "text-blue-400 bg-blue-400/10",
    command: "text-purple-400 bg-purple-400/10",
    agent: "text-amber-400 bg-amber-400/10",
  };
  return (
    <span className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] ${styles[type]}`}>
      {type}
    </span>
  );
}

// ─── InstalledSkillCard ───────────────────────────────────────────────────────

function InstalledSkillCard({
  skill,
  onUninstall,
  uninstalling,
}: {
  skill: SkillInfo;
  onUninstall: (skill: SkillInfo) => void;
  uninstalling: boolean;
}) {
  return (
    <div className="rounded-xl border border-cc-border bg-cc-card p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-cc-fg truncate">{skill.name}</span>
            <SkillBadge type={skill.type} />
          </div>
          {skill.description && (
            <p className="text-xs text-cc-muted mt-0.5 line-clamp-2">{skill.description}</p>
          )}
        </div>
        <button
          onClick={() => onUninstall(skill)}
          disabled={uninstalling}
          className="shrink-0 text-[11px] font-medium px-2 py-1 rounded-md text-cc-error/80 hover:text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {uninstalling ? "..." : "Remove"}
        </button>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-cc-muted">
        {skill.pluginName && (
          <span className="flex items-center gap-1">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5 opacity-50">
              <path d="M8.5 1.5A.5.5 0 009 1h0a.5.5 0 00-.5.5v5.243a4.5 4.5 0 11-1 0V1.5A.5.5 0 018 1h0a.5.5 0 01.5.5z" />
            </svg>
            {skill.pluginName}
          </span>
        )}
        <span className="px-1.5 rounded bg-cc-hover">
          {skill.installedScope === "user" ? "user" : "project"}
        </span>
      </div>
    </div>
  );
}

// ─── PluginCard ───────────────────────────────────────────────────────────────

function PluginCard({
  plugin,
  onInstall,
  onInstallSkill,
  installing,
}: {
  plugin: PluginInfo;
  onInstall: (plugin: PluginInfo, scope: "user" | "project") => void;
  onInstallSkill: (plugin: PluginInfo, skillName: string, scope: "user" | "project") => void;
  installing: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState<string | null>(null);
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const setButtonRef = useCallback((key: string) => (el: HTMLButtonElement | null) => {
    if (el) buttonRefs.current.set(key, el);
    else buttonRefs.current.delete(key);
  }, []);

  const getAnchorRef = useCallback((key: string) => ({
    current: buttonRefs.current.get(key) ?? null,
  }), []);

  const allItems = [...plugin.skills, ...plugin.commands, ...plugin.agents];
  const installableItems = allItems.filter((s) => s.name && !s.installed);
  const installedCount = allItems.filter((s) => s.installed).length;
  const totalCount = allItems.length;

  return (
    <div className="rounded-xl border border-cc-border bg-cc-card overflow-visible">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-cc-hover/50 transition-colors cursor-pointer rounded-xl"
      >
        {/* Plugin icon */}
        <div className="w-9 h-9 shrink-0 rounded-lg bg-cc-accent/10 flex items-center justify-center mt-0.5">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-cc-accent">
            <path d="M8.5 1.5A.5.5 0 009 1h0a.5.5 0 00-.5.5v5.243a4.5 4.5 0 11-1 0V1.5A.5.5 0 018 1h0a.5.5 0 01.5.5z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-cc-fg truncate">{plugin.name}</span>
            {plugin.installed && (
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] text-cc-success bg-cc-success/10">
                installed
              </span>
            )}
          </div>
          {plugin.description && (
            <p className="text-xs text-cc-muted mt-0.5 line-clamp-2">{plugin.description}</p>
          )}
          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-cc-muted">
            {plugin.author?.name && (
              <span>{plugin.author.name}</span>
            )}
            <span>
              {totalCount} {totalCount === 1 ? "item" : "items"}
              {installedCount > 0 && ` (${installedCount} installed)`}
            </span>
          </div>
        </div>
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3.5 h-3.5 text-cc-muted shrink-0 mt-1 transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-cc-border px-4 py-3 space-y-3">
          {/* Install All button */}
          <div className="flex justify-end mt-2">
            <button
              ref={setButtonRef(`__plugin__${plugin.name}`)}
              onClick={() => setScopeMenuOpen(scopeMenuOpen === `__plugin__${plugin.name}` ? null : `__plugin__${plugin.name}`)}
              disabled={installing === plugin.name || installableItems.length === 0}
              className="text-[11px] font-medium px-3 py-1.5 rounded-md bg-cc-accent text-white hover:bg-cc-accent/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {installing === plugin.name ? "Installing..." : `Install All (${installableItems.length})`}
            </button>
            {scopeMenuOpen === `__plugin__${plugin.name}` && (
              <ScopeMenu
                anchorRef={getAnchorRef(`__plugin__${plugin.name}`)}
                onSelect={(scope) => {
                  setScopeMenuOpen(null);
                  onInstall(plugin, scope);
                }}
                onClose={() => setScopeMenuOpen(null)}
              />
            )}
          </div>

          {/* Individual installable items */}
          {installableItems.map((item) => (
            <div
              key={`${item.type}-${item.name}`}
              className="flex items-center gap-2 py-1.5"
            >
              <SkillBadge type={item.type} />
              <span className="text-[12px] text-cc-fg flex-1 min-w-0 truncate">{item.name}</span>
              {item.description && (
                <span className="text-[10px] text-cc-muted hidden sm:block max-w-[200px] truncate">
                  {item.description}
                </span>
              )}
              <button
                ref={setButtonRef(item.name)}
                onClick={() => setScopeMenuOpen(scopeMenuOpen === item.name ? null : item.name)}
                disabled={installing === item.name}
                className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-md text-cc-accent hover:bg-cc-accent/10 transition-colors cursor-pointer disabled:opacity-50"
              >
                {installing === item.name ? "..." : "Install"}
              </button>
              {scopeMenuOpen === item.name && (
                <ScopeMenu
                  anchorRef={getAnchorRef(item.name)}
                  onSelect={(scope) => {
                    setScopeMenuOpen(null);
                    onInstallSkill(plugin, item.name, scope);
                  }}
                  onClose={() => setScopeMenuOpen(null)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ScopeMenu ────────────────────────────────────────────────────────────────

function ScopeMenu({
  onSelect,
  onClose,
  anchorRef,
}: {
  onSelect: (scope: "user" | "project") => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const menuHeight = 100; // approximate height of menu
    const spaceBelow = window.innerHeight - rect.bottom;
    // Show above if not enough room below
    if (spaceBelow < menuHeight) {
      setPos({ top: rect.top - menuHeight, left: rect.right - 160 });
    } else {
      setPos({ top: rect.bottom + 4, left: rect.right - 160 });
    }
  }, [anchorRef]);

  if (!pos) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[9998]" onClick={onClose} />
      <div
        ref={menuRef}
        className="fixed z-[9999] bg-cc-card border border-cc-border rounded-lg shadow-lg py-1 min-w-[160px]"
        style={{ top: pos.top, left: Math.max(8, pos.left) }}
      >
        <button
          onClick={() => onSelect("user")}
          className="w-full px-3 py-2 text-left text-[12px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <div className="font-medium">User-level</div>
          <div className="text-[10px] text-cc-muted">Available in all projects</div>
        </button>
        <button
          onClick={() => onSelect("project")}
          className="w-full px-3 py-2 text-left text-[12px] text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          <div className="font-medium">Project-level</div>
          <div className="text-[10px] text-cc-muted">Only for this project</div>
        </button>
      </div>
    </>,
    document.body,
  );
}

// ─── SkillsPage ───────────────────────────────────────────────────────────────

/** Get current session cwd from store (bridge state or sdkSessions) */
function useSessionCwd(): string | undefined {
  const currentSessionId = useStore((s) => s.currentSessionId);
  const sessions = useStore((s) => s.sessions);
  const sdkSessions = useStore((s) => s.sdkSessions);

  if (!currentSessionId) return undefined;
  return (
    sessions.get(currentSessionId)?.cwd ||
    sdkSessions.find((s) => s.sessionId === currentSessionId)?.cwd ||
    undefined
  );
}

export function SkillsPage() {
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const cwd = useSessionCwd();

  const load = () => {
    setLoading(true);
    setError("");
    api
      .listSkills(cwd)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [cwd]);

  const showFeedback = (type: "success" | "error", message: string) => {
    setActionFeedback({ type, message });
    setTimeout(() => setActionFeedback(null), 3000);
  };

  // Filter by search
  const filteredPlugins = useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase().trim();
    if (!q) return data.plugins;
    return data.plugins.filter((p) => {
      const haystack = [
        p.name,
        p.description,
        ...p.skills.map((s) => s.name),
        ...p.skills.map((s) => s.description),
        ...p.commands.map((s) => s.name),
        ...p.commands.map((s) => s.description),
        ...p.agents.map((s) => s.name),
        ...p.agents.map((s) => s.description),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [data, search]);

  const filteredInstalled = useMemo(() => {
    if (!data) return [];
    const all = [...data.userSkills, ...data.projectSkills];
    const q = search.toLowerCase().trim();
    if (!q) return all;
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [data, search]);

  async function handleInstallPlugin(plugin: PluginInfo, scope: "user" | "project") {
    setInstalling(plugin.name);
    try {
      const result = await api.installSkill({ pluginName: plugin.name, scope, cwd });
      showFeedback("success", `Installed ${result.installed.length} item(s) from ${plugin.name}`);
      load();
    } catch (e: unknown) {
      showFeedback("error", e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
    }
  }

  async function handleInstallSkill(plugin: PluginInfo, skillName: string, scope: "user" | "project") {
    setInstalling(skillName);
    try {
      await api.installSkill({ pluginName: plugin.name, skillName, scope, cwd });
      showFeedback("success", `Installed "${skillName}"`);
      load();
    } catch (e: unknown) {
      showFeedback("error", e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling(null);
    }
  }

  async function handleUninstall(skill: SkillInfo) {
    setUninstalling(skill.name);
    try {
      await api.uninstallSkill({
        name: skill.name,
        scope: skill.installedScope || "user",
        cwd,
      });
      showFeedback("success", `Removed "${skill.name}"`);
      load();
    } catch (e: unknown) {
      showFeedback("error", e instanceof Error ? e.message : String(e));
    } finally {
      setUninstalling(null);
    }
  }

  return (
    <div className="h-[100dvh] bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-6 sm:py-10">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-6">
          <h1 className="text-lg font-semibold">Skills</h1>
          <button
            onClick={() => { window.location.hash = ""; }}
            className="px-3 py-1.5 rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            Back
          </button>
        </div>

        {/* Search */}
        <div className="mb-6">
          <div className="relative">
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="w-4 h-4 text-cc-muted absolute left-3 top-1/2 -translate-y-1/2"
            >
              <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85-.017.016zm-5.242.656a5 5 0 110-10 5 5 0 010 10z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search skills, plugins, commands..."
              className="w-full pl-10 pr-4 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-xl text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
            />
          </div>
        </div>

        {/* Feedback toast */}
        {actionFeedback && (
          <div
            className={`mb-4 px-3 py-2 rounded-lg text-xs border ${
              actionFeedback.type === "success"
                ? "bg-cc-success/10 border-cc-success/20 text-cc-success"
                : "bg-cc-error/10 border-cc-error/20 text-cc-error"
            }`}
          >
            {actionFeedback.message}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="text-center py-12 text-sm text-cc-muted">
            Scanning skills...
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="px-4 py-3 rounded-xl bg-cc-error/10 border border-cc-error/20 text-sm text-cc-error mb-6">
            {error}
          </div>
        )}

        {/* Content */}
        {data && !loading && (
          <div className="space-y-8">
            {/* Installed skills */}
            {filteredInstalled.length > 0 && (
              <section>
                <h2 className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider mb-3">
                  Installed ({filteredInstalled.length})
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {filteredInstalled.map((skill) => (
                    <InstalledSkillCard
                      key={`${skill.installedScope}-${skill.name}`}
                      skill={skill}
                      onUninstall={handleUninstall}
                      uninstalling={uninstalling === skill.name}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Marketplace plugins */}
            <section>
              <h2 className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider mb-3">
                Available Plugins ({filteredPlugins.length})
              </h2>
              {filteredPlugins.length === 0 ? (
                <p className="text-sm text-cc-muted text-center py-8">
                  {search
                    ? "No plugins match your search."
                    : "No marketplace plugins found. Run Claude Code to sync the marketplace."}
                </p>
              ) : (
                <div className="space-y-2">
                  {filteredPlugins.map((plugin) => (
                    <PluginCard
                      key={plugin.name}
                      plugin={plugin}
                      onInstall={handleInstallPlugin}
                      onInstallSkill={handleInstallSkill}
                      installing={installing}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
