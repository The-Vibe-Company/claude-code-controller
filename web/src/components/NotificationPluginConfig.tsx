import { useState, useCallback } from "react";
import { api, type PluginRuntimeInfo } from "../api.js";

interface NotificationsConfig {
  onSessionCreated: boolean;
  onSessionEnded: boolean;
  onResultSuccess: boolean;
  onResultError: boolean;
  onPermissionRequest: boolean;
  onPermissionResponse: boolean;
  onToolLifecycle: boolean;
}

function parseConfig(raw: unknown): NotificationsConfig {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    onSessionCreated: src.onSessionCreated === true,
    onSessionEnded: src.onSessionEnded !== false,
    onResultSuccess: src.onResultSuccess === true,
    onResultError: src.onResultError !== false,
    onPermissionRequest: src.onPermissionRequest !== false,
    onPermissionResponse: src.onPermissionResponse !== false,
    onToolLifecycle: src.onToolLifecycle === true,
  };
}

function Toggle({ checked, onChange, label, description }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg text-left bg-cc-hover/50 hover:bg-cc-hover transition-colors cursor-pointer"
    >
      <div className="min-w-0">
        <span className="text-[13px] font-medium text-cc-fg">{label}</span>
        <p className="text-[11px] text-cc-muted mt-0.5">{description}</p>
      </div>
      <div className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${checked ? "bg-cc-primary" : "bg-cc-muted/30"}`}>
        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${checked ? "left-[18px]" : "left-0.5"}`} />
      </div>
    </button>
  );
}

interface Props {
  plugin: PluginRuntimeInfo;
  onRefresh: () => void;
}

export function NotificationPluginConfig({ plugin, onRefresh }: Props) {
  const [config, setConfig] = useState<NotificationsConfig>(() => parseConfig(plugin.config));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = useCallback(async (nextConfig: NotificationsConfig) => {
    setConfig(nextConfig);
    setSaving(true);
    setSaved(false);
    try {
      await api.updatePluginConfig(plugin.id, nextConfig);
      onRefresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch {
      // revert on error
      setConfig(parseConfig(plugin.config));
    } finally {
      setSaving(false);
    }
  }, [plugin.id, plugin.config, onRefresh]);

  const toggle = (key: keyof NotificationsConfig) => {
    const next = { ...config, [key]: !config[key] };
    save(next);
  };

  return (
    <div className="space-y-4">
      {/* Session Events */}
      <div>
        <h3 className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider mb-2 px-1">Session Events</h3>
        <div className="space-y-1">
          <Toggle
            checked={config.onSessionCreated}
            onChange={() => toggle("onSessionCreated")}
            label="Session created"
            description="Notify when a new session starts"
          />
          <Toggle
            checked={config.onSessionEnded}
            onChange={() => toggle("onSessionEnded")}
            label="Session ended"
            description="Notify when a session is killed, archived, or deleted"
          />
        </div>
      </div>

      {/* Execution Events */}
      <div>
        <h3 className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider mb-2 px-1">Execution Events</h3>
        <div className="space-y-1">
          <Toggle
            checked={config.onResultSuccess}
            onChange={() => toggle("onResultSuccess")}
            label="Task completed"
            description="Notify on successful execution completion"
          />
          <Toggle
            checked={config.onResultError}
            onChange={() => toggle("onResultError")}
            label="Execution error"
            description="Notify when an execution encounters an error"
          />
        </div>
      </div>

      {/* Permission Events */}
      <div>
        <h3 className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider mb-2 px-1">Permission Events</h3>
        <div className="space-y-1">
          <Toggle
            checked={config.onPermissionRequest}
            onChange={() => toggle("onPermissionRequest")}
            label="Permission requested"
            description="Notify when a tool needs approval"
          />
          <Toggle
            checked={config.onPermissionResponse}
            onChange={() => toggle("onPermissionResponse")}
            label="Permission responded"
            description="Notify when a permission is granted or denied"
          />
        </div>
      </div>

      {/* Tool Events */}
      <div>
        <h3 className="text-[11px] font-semibold text-cc-muted uppercase tracking-wider mb-2 px-1">Tool Events</h3>
        <div className="space-y-1">
          <Toggle
            checked={config.onToolLifecycle}
            onChange={() => toggle("onToolLifecycle")}
            label="Tool lifecycle"
            description="Notify when tools start and finish (verbose)"
          />
        </div>
      </div>

      {/* Status indicator */}
      <div className="flex items-center justify-end px-1">
        {saving && <span className="text-[11px] text-cc-muted">Saving...</span>}
        {saved && <span className="text-[11px] text-cc-success">Saved</span>}
      </div>
    </div>
  );
}
