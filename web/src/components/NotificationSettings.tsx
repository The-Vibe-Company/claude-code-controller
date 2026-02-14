import { useState, useEffect } from "react";
import { api } from "../api.js";
import type {
  NotificationProvider,
  ProviderConfig,
  ProviderType,
  NotificationTrigger,
} from "../../server/notification-types.js";

// ─── Provider metadata ──────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<ProviderType, string> = {
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  lark: "Lark",
  resend: "Resend (Email)",
  gotify: "Gotify",
  ntfy: "ntfy",
  pushover: "Pushover",
  custom: "Custom Webhook",
};

const PROVIDER_TYPES = Object.keys(PROVIDER_LABELS) as ProviderType[];

interface FieldDef {
  label: string;
  key: string;
  type: "text" | "password" | "number" | "select";
  required: boolean;
  placeholder: string;
  options?: string[];
}

const PROVIDER_FIELDS: Record<ProviderType, FieldDef[]> = {
  slack: [
    { label: "Webhook URL", key: "webhookUrl", type: "text", required: true, placeholder: "https://hooks.slack.com/services/..." },
    { label: "Channel", key: "channel", type: "text", required: false, placeholder: "#general (optional)" },
  ],
  telegram: [
    { label: "Bot Token", key: "botToken", type: "password", required: true, placeholder: "123456:ABC-..." },
    { label: "Chat ID", key: "chatId", type: "text", required: true, placeholder: "-100123456789" },
  ],
  discord: [
    { label: "Webhook URL", key: "webhookUrl", type: "text", required: true, placeholder: "https://discord.com/api/webhooks/..." },
  ],
  lark: [
    { label: "Webhook URL", key: "webhookUrl", type: "text", required: true, placeholder: "https://open.larksuite.com/open-apis/bot/v2/hook/..." },
  ],
  resend: [
    { label: "API Key", key: "apiKey", type: "password", required: true, placeholder: "re_..." },
    { label: "From Address", key: "fromAddress", type: "text", required: true, placeholder: "notifications@yourdomain.com" },
    { label: "To Addresses (comma-separated)", key: "toAddresses", type: "text", required: true, placeholder: "user@example.com, other@example.com" },
  ],
  gotify: [
    { label: "Server URL", key: "serverUrl", type: "text", required: true, placeholder: "https://gotify.example.com" },
    { label: "App Token", key: "appToken", type: "password", required: true, placeholder: "A..." },
    { label: "Priority", key: "priority", type: "number", required: false, placeholder: "5" },
  ],
  ntfy: [
    { label: "Server URL", key: "serverUrl", type: "text", required: true, placeholder: "https://ntfy.sh" },
    { label: "Topic", key: "topic", type: "text", required: true, placeholder: "companion-alerts" },
    { label: "Access Token", key: "accessToken", type: "password", required: false, placeholder: "(optional)" },
    { label: "Priority", key: "priority", type: "number", required: false, placeholder: "3" },
  ],
  pushover: [
    { label: "User Key", key: "userKey", type: "password", required: true, placeholder: "u..." },
    { label: "API Token", key: "apiToken", type: "password", required: true, placeholder: "a..." },
  ],
  custom: [
    { label: "Webhook URL", key: "webhookUrl", type: "text", required: true, placeholder: "https://..." },
    { label: "HTTP Method", key: "method", type: "select", required: true, placeholder: "POST", options: ["GET", "POST", "PUT"] },
  ],
};

const TRIGGER_LABELS: Record<NotificationTrigger, string> = {
  session_complete: "Session Complete",
  session_error: "Session Error",
  permission_requested: "Permission Requested",
};

const ALL_TRIGGERS: NotificationTrigger[] = [
  "session_complete",
  "session_error",
  "permission_requested",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildDefaultConfig(type: ProviderType): ProviderConfig {
  switch (type) {
    case "slack": return { type: "slack", webhookUrl: "" };
    case "telegram": return { type: "telegram", botToken: "", chatId: "" };
    case "discord": return { type: "discord", webhookUrl: "" };
    case "lark": return { type: "lark", webhookUrl: "" };
    case "resend": return { type: "resend", apiKey: "", fromAddress: "", toAddresses: [] };
    case "gotify": return { type: "gotify", serverUrl: "", appToken: "" };
    case "ntfy": return { type: "ntfy", serverUrl: "https://ntfy.sh", topic: "" };
    case "pushover": return { type: "pushover", userKey: "", apiToken: "" };
    case "custom": return { type: "custom", webhookUrl: "", headers: {}, method: "POST" };
  }
}

function getConfigValue(config: ProviderConfig, key: string): string {
  const val = (config as unknown as Record<string, unknown>)[key];
  if (Array.isArray(val)) return val.join(", ");
  if (typeof val === "object" && val !== null) {
    return Object.entries(val).map(([k, v]) => `${k}: ${v}`).join("\n");
  }
  return val != null ? String(val) : "";
}

function setConfigValue(
  config: ProviderConfig,
  key: string,
  value: string,
  fieldType: string,
): ProviderConfig {
  const clone = { ...config } as unknown as Record<string, unknown>;
  if (key === "toAddresses") {
    clone[key] = value.split(",").map((s) => s.trim()).filter(Boolean);
  } else if (fieldType === "number") {
    clone[key] = value === "" ? undefined : Number(value);
  } else {
    clone[key] = value;
  }
  return clone as unknown as ProviderConfig;
}

// ─── Header Editor (for Custom webhook) ──────────────────────────────────────

interface HeaderRow {
  key: string;
  value: string;
}

function HeaderEditor({
  headers,
  onChange,
}: {
  headers: Record<string, string>;
  onChange: (h: Record<string, string>) => void;
}) {
  const [rows, setRows] = useState<HeaderRow[]>(() => {
    const entries = Object.entries(headers).map(([key, value]) => ({ key, value }));
    return entries.length === 0 ? [{ key: "", value: "" }] : entries;
  });

  function emitHeaders(updated: HeaderRow[]) {
    const result: Record<string, string> = {};
    for (const r of updated) {
      if (r.key.trim()) result[r.key.trim()] = r.value;
    }
    onChange(result);
  }

  function update(idx: number, field: "key" | "value", val: string) {
    const next = [...rows];
    next[idx] = { ...next[idx], [field]: val };
    setRows(next);
    emitHeaders(next);
  }

  function addRow() {
    const next = [...rows, { key: "", value: "" }];
    setRows(next);
  }

  function removeRow(idx: number) {
    const next = rows.filter((_, i) => i !== idx);
    setRows(next.length === 0 ? [{ key: "", value: "" }] : next);
    emitHeaders(next);
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium">Custom Headers</label>
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2">
          <input
            type="text"
            value={row.key}
            onChange={(e) => update(i, "key", e.target.value)}
            placeholder="Header name"
            className="flex-1 px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
          />
          <input
            type="text"
            value={row.value}
            onChange={(e) => update(i, "value", e.target.value)}
            placeholder="Value"
            className="flex-1 px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
          />
          <button
            type="button"
            onClick={() => removeRow(i)}
            className="px-2 text-cc-muted hover:text-cc-error text-sm cursor-pointer"
          >
            x
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="text-xs text-cc-primary hover:underline cursor-pointer"
      >
        + Add header
      </button>
    </div>
  );
}

// ─── Provider Form ───────────────────────────────────────────────────────────

interface ProviderFormProps {
  initialType?: ProviderType;
  initialName?: string;
  initialConfig?: ProviderConfig;
  initialTriggers?: NotificationTrigger[];
  onSave: (name: string, config: ProviderConfig, triggers: NotificationTrigger[]) => Promise<void>;
  onCancel: () => void;
  saving: boolean;
}

function ProviderForm({
  initialType = "slack",
  initialName = "",
  initialConfig,
  initialTriggers = ["session_complete", "session_error", "permission_requested"],
  onSave,
  onCancel,
  saving,
}: ProviderFormProps) {
  const [providerType, setProviderType] = useState<ProviderType>(initialType);
  const [name, setName] = useState(initialName);
  const [config, setConfig] = useState<ProviderConfig>(
    initialConfig ?? buildDefaultConfig(initialType),
  );
  const [triggers, setTriggers] = useState<NotificationTrigger[]>(initialTriggers);
  const [error, setError] = useState("");

  function handleTypeChange(newType: ProviderType) {
    setProviderType(newType);
    setConfig(buildDefaultConfig(newType));
  }

  function toggleTrigger(t: NotificationTrigger) {
    setTriggers((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    try {
      await onSave(name.trim(), config, triggers);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const fields = PROVIDER_FIELDS[providerType];

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-sm font-medium mb-1">Provider Type</label>
        <select
          value={providerType}
          onChange={(e) => handleTypeChange(e.target.value as ProviderType)}
          disabled={!!initialConfig}
          className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60"
        >
          {PROVIDER_TYPES.map((t) => (
            <option key={t} value={t}>
              {PROVIDER_LABELS[t]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. My Slack Alert"
          className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
        />
      </div>

      {fields.map((field) => (
        <div key={field.key}>
          <label className="block text-sm font-medium mb-1">
            {field.label}
            {field.required && <span className="text-cc-error ml-0.5">*</span>}
          </label>
          {field.type === "select" && field.options ? (
            <select
              value={getConfigValue(config, field.key) || field.options[0]}
              onChange={(e) =>
                setConfig(setConfigValue(config, field.key, e.target.value, field.type))
              }
              className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg focus:outline-none focus:border-cc-primary/60"
            >
              {field.options.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          ) : (
            <input
              type={field.type}
              value={getConfigValue(config, field.key)}
              onChange={(e) =>
                setConfig(setConfigValue(config, field.key, e.target.value, field.type))
              }
              placeholder={field.placeholder}
              className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
            />
          )}
        </div>
      ))}

      {providerType === "custom" && (
        <HeaderEditor
          headers={(config as { headers: Record<string, string> }).headers || {}}
          onChange={(h) => setConfig({ ...config, headers: h } as ProviderConfig)}
        />
      )}

      <div>
        <label className="block text-sm font-medium mb-1.5">Triggers</label>
        <div className="flex flex-wrap gap-2">
          {ALL_TRIGGERS.map((t) => (
            <label
              key={t}
              className="flex items-center gap-1.5 text-sm cursor-pointer"
            >
              <input
                type="checkbox"
                checked={triggers.includes(t)}
                onChange={() => toggleTrigger(t)}
                className="accent-cc-primary"
              />
              {TRIGGER_LABELS[t]}
            </label>
          ))}
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
          {error}
        </div>
      )}

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            saving
              ? "bg-cc-hover text-cc-muted cursor-not-allowed"
              : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
          }`}
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </form>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

interface NotificationSettingsProps {
  embedded?: boolean;
}

export function NotificationSettings({ embedded = false }: NotificationSettingsProps) {
  const [providers, setProviders] = useState<NotificationProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; error?: string } | null>(null);

  function refresh() {
    api
      .listNotificationProviders()
      .then((list) => {
        setProviders(list);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate(
    name: string,
    config: ProviderConfig,
    triggers: NotificationTrigger[],
  ) {
    setSaving(true);
    try {
      await api.createNotificationProvider({ name, config, triggers });
      setAdding(false);
      refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(
    id: string,
    name: string,
    config: ProviderConfig,
    triggers: NotificationTrigger[],
  ) {
    setSaving(true);
    try {
      await api.updateNotificationProvider(id, { name, config, triggers });
      setEditingId(null);
      refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(provider: NotificationProvider) {
    try {
      await api.updateNotificationProvider(provider.id, {
        enabled: !provider.enabled,
      });
    } catch {
      // Silently fail — refresh will restore correct state
    }
    refresh();
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteNotificationProvider(id);
    } catch {
      // Silently fail — refresh will restore correct state
    }
    if (editingId === id) setEditingId(null);
    refresh();
  }

  async function handleTest(id: string) {
    setTestingId(id);
    setTestResult(null);
    try {
      const result = await api.testNotificationProvider(id);
      setTestResult({ id, ...result });
    } catch (err: unknown) {
      setTestResult({
        id,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingId(null);
    }
  }

  if (loading) {
    if (embedded) {
      return <p className="text-xs text-cc-muted">Loading providers...</p>;
    }
    return (
      <div className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5">
        <h2 className="text-sm font-semibold mb-3">Notifications</h2>
        <p className="text-xs text-cc-muted">Loading...</p>
      </div>
    );
  }

  const content = (
    <>
      <div className="flex items-center justify-between">
        {!embedded && <h2 className="text-sm font-semibold">Notifications</h2>}
        {embedded && <h3 className="text-xs font-medium text-cc-muted uppercase tracking-wide">Providers</h3>}
        {!adding && (
          <button
            onClick={() => { setAdding(true); setEditingId(null); }}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
          >
            Add Provider
          </button>
        )}
      </div>

      {providers.length === 0 && !adding && (
        <p className="text-xs text-cc-muted">
          No notification providers configured. Add one to receive alerts when
          sessions complete or need approval.
        </p>
      )}

      {/* Provider list */}
      {providers.map((p) => (
        <div
          key={p.id}
          className="border border-cc-border rounded-lg p-3 space-y-2"
        >
          {editingId === p.id ? (
            <ProviderForm
              initialType={p.type}
              initialName={p.name}
              initialConfig={p.config}
              initialTriggers={p.triggers}
              onSave={(name, config, triggers) =>
                handleUpdate(p.id, name, config, triggers)
              }
              onCancel={() => setEditingId(null)}
              saving={saving}
            />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium truncate">
                    {p.name}
                  </span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-cc-hover text-cc-muted uppercase tracking-wide">
                    {PROVIDER_LABELS[p.type] || p.type}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => handleToggle(p)}
                    className={`px-2 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                      p.enabled
                        ? "bg-cc-success/15 text-cc-success"
                        : "bg-cc-hover text-cc-muted"
                    }`}
                  >
                    {p.enabled ? "On" : "Off"}
                  </button>
                  <button
                    onClick={() => handleTest(p.id)}
                    disabled={testingId === p.id}
                    className="px-2 py-1 rounded text-xs text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:cursor-not-allowed"
                  >
                    {testingId === p.id ? "..." : "Test"}
                  </button>
                  <button
                    onClick={() => { setEditingId(p.id); setAdding(false); }}
                    className="px-2 py-1 rounded text-xs text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(p.id)}
                    className="px-2 py-1 rounded text-xs text-cc-muted hover:text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {p.triggers.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {p.triggers.map((t) => (
                    <span
                      key={t}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-cc-hover text-cc-muted"
                    >
                      {TRIGGER_LABELS[t]}
                    </span>
                  ))}
                </div>
              )}
              {testResult && testResult.id === p.id && (
                <div
                  className={`px-3 py-2 rounded-lg text-xs ${
                    testResult.success
                      ? "bg-cc-success/10 border border-cc-success/20 text-cc-success"
                      : "bg-cc-error/10 border border-cc-error/20 text-cc-error"
                  }`}
                >
                  {testResult.success
                    ? "Test notification sent successfully."
                    : `Test failed: ${testResult.error}`}
                </div>
              )}
            </>
          )}
        </div>
      ))}

      {/* Add provider form */}
      {adding && (
        <div className="border border-cc-border rounded-lg p-3">
          <ProviderForm
            onSave={handleCreate}
            onCancel={() => setAdding(false)}
            saving={saving}
          />
        </div>
      )}
    </>
  );

  if (embedded) {
    return <div className="space-y-3 pt-2 mt-2 border-t border-cc-border">{content}</div>;
  }

  return (
    <div className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-4">
      {content}
    </div>
  );
}
