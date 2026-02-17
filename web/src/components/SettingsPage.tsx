import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { getTelemetryPreferenceEnabled, setTelemetryPreferenceEnabled } from "../analytics.js";
import { navigateToSession, navigateHome } from "../utils/routing.js";

interface SettingsPageProps {
  embedded?: boolean;
}

export function SettingsPage({ embedded = false }: SettingsPageProps) {
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [openrouterModel, setOpenrouterModel] = useState("openrouter/free");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);
  const notificationSound = useStore((s) => s.notificationSound);
  const toggleNotificationSound = useStore((s) => s.toggleNotificationSound);
  const notificationDesktop = useStore((s) => s.notificationDesktop);
  const setNotificationDesktop = useStore((s) => s.setNotificationDesktop);
  const updateInfo = useStore((s) => s.updateInfo);
  const setUpdateInfo = useStore((s) => s.setUpdateInfo);
  const notificationApiAvailable = typeof Notification !== "undefined";
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatingApp, setUpdatingApp] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const [updateError, setUpdateError] = useState("");
  const [telemetryEnabled, setTelemetryEnabled] = useState(getTelemetryPreferenceEnabled());

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setConfigured(s.openrouterApiKeyConfigured);
        setOpenrouterModel(s.openrouterModel || "openrouter/free");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const nextKey = openrouterApiKey.trim();
      const payload: { openrouterApiKey?: string; openrouterModel: string } = {
        openrouterModel: openrouterModel.trim() || "openrouter/free",
      };
      if (nextKey) {
        payload.openrouterApiKey = nextKey;
      }

      const res = await api.updateSettings(payload);
      setConfigured(res.openrouterApiKeyConfigured);
      setOpenrouterApiKey("");
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function onCheckUpdates() {
    setCheckingUpdates(true);
    setUpdateStatus("");
    setUpdateError("");
    try {
      const info = await api.forceCheckForUpdate();
      setUpdateInfo(info);
      if (info.updateAvailable && info.latestVersion) {
        setUpdateStatus(`Update v${info.latestVersion} is available.`);
      } else {
        setUpdateStatus("You are up to date.");
      }
    } catch (err: unknown) {
      setUpdateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function onTriggerUpdate() {
    setUpdatingApp(true);
    setUpdateStatus("");
    setUpdateError("");
    try {
      const res = await api.triggerUpdate();
      setUpdateStatus(res.message);
    } catch (err: unknown) {
      setUpdateError(err instanceof Error ? err.message : String(err));
      setUpdatingApp(false);
    }
  }

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-cc-fg">Settings</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Configure API access, notifications, appearance, and workspace defaults.
            </p>
          </div>
          {!embedded && (
            <button
              onClick={() => {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateHome();
                }
              }}
              className="px-3 py-1.5 rounded-lg text-sm text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
            >
              Back
            </button>
          )}
        </div>

        <form
          onSubmit={onSave}
          className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-4"
        >
          <h2 className="text-sm font-semibold text-cc-fg">OpenRouter</h2>
          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="openrouter-key">
              OpenRouter API Key
            </label>
            <input
              id="openrouter-key"
              type="password"
              value={openrouterApiKey}
              onChange={(e) => setOpenrouterApiKey(e.target.value)}
              placeholder={configured ? "Configured. Enter a new key to replace." : "sk-or-v1-..."}
              className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
            />
            <p className="mt-1.5 text-xs text-cc-muted">
              Auto-renaming is disabled until this key is configured.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="openrouter-model">
              OpenRouter Model
            </label>
            <input
              id="openrouter-model"
              type="text"
              value={openrouterModel}
              onChange={(e) => setOpenrouterModel(e.target.value)}
              placeholder="openrouter/free"
              className="w-full px-3 py-2.5 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/60"
            />
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {error}
            </div>
          )}

          {saved && (
            <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
              Settings saved.
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs text-cc-muted">
              {loading ? "Loading..." : configured ? "OpenRouter key configured" : "OpenRouter key not configured"}
            </span>
            <button
              type="submit"
              disabled={saving || loading}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                saving || loading
                  ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                  : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
              }`}
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-semibold text-cc-fg">Notifications</h2>
          <button
            type="button"
            onClick={toggleNotificationSound}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
          >
            <span>Sound</span>
            <span className="text-xs text-cc-muted">{notificationSound ? "On" : "Off"}</span>
          </button>
          {notificationApiAvailable && (
            <button
              type="button"
              onClick={async () => {
                if (!notificationDesktop) {
                  if (Notification.permission !== "granted") {
                    const result = await Notification.requestPermission();
                    if (result !== "granted") return;
                  }
                  setNotificationDesktop(true);
                } else {
                  setNotificationDesktop(false);
                }
              }}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
            >
              <span>Desktop Alerts</span>
              <span className="text-xs text-cc-muted">{notificationDesktop ? "On" : "Off"}</span>
            </button>
          )}
        </div>

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-semibold text-cc-fg">Updates</h2>
          {updateInfo ? (
            <p className="text-xs text-cc-muted">
              Current version: v{updateInfo.currentVersion}
              {updateInfo.latestVersion ? ` • Latest: v${updateInfo.latestVersion}` : ""}
            </p>
          ) : (
            <p className="text-xs text-cc-muted">Version information not loaded yet.</p>
          )}

          {updateError && (
            <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
              {updateError}
            </div>
          )}

          {updateStatus && (
            <div className="px-3 py-2 rounded-lg bg-cc-success/10 border border-cc-success/20 text-xs text-cc-success">
              {updateStatus}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onCheckUpdates}
              disabled={checkingUpdates}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                checkingUpdates
                  ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                  : "bg-cc-hover hover:bg-cc-active text-cc-fg cursor-pointer"
              }`}
            >
              {checkingUpdates ? "Checking..." : "Check for updates"}
            </button>

            {updateInfo?.isServiceMode ? (
              <button
                type="button"
                onClick={onTriggerUpdate}
                disabled={updatingApp || updateInfo.updateInProgress || !updateInfo.updateAvailable}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  updatingApp || updateInfo.updateInProgress || !updateInfo.updateAvailable
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                }`}
              >
                {updatingApp || updateInfo.updateInProgress ? "Updating..." : "Update & Restart"}
              </button>
            ) : (
              <p className="text-xs text-cc-muted self-center">
                Install service mode with <code className="font-mono-code bg-cc-code-bg px-1 py-0.5 rounded text-cc-code-fg">the-companion install</code> to enable one-click updates.
              </p>
            )}
          </div>
        </div>

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-semibold text-cc-fg">Appearance</h2>
          <button
            type="button"
            onClick={toggleDarkMode}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
          >
            <span>Theme</span>
            <span className="text-xs text-cc-muted">{darkMode ? "Dark" : "Light"}</span>
          </button>
        </div>

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-semibold text-cc-fg">Telemetry</h2>
          <p className="text-xs text-cc-muted">
            Anonymous product analytics and crash reports via PostHog to improve reliability.
          </p>
          <button
            type="button"
            onClick={() => {
              const next = !telemetryEnabled;
              setTelemetryPreferenceEnabled(next);
              setTelemetryEnabled(next);
            }}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm bg-cc-hover text-cc-fg hover:bg-cc-active transition-colors cursor-pointer"
          >
            <span>Usage analytics and errors</span>
            <span className="text-xs text-cc-muted">{telemetryEnabled ? "On" : "Off"}</span>
          </button>
          <p className="text-xs text-cc-muted">
            Browser Do Not Track is respected automatically.
          </p>
        </div>

        <div className="mt-4 bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
          <h2 className="text-sm font-semibold text-cc-fg">Environments</h2>
          <p className="text-xs text-cc-muted">
            Manage reusable environment profiles used when creating sessions.
          </p>
          <button
            type="button"
            onClick={() => {
              window.location.hash = "#/environments";
            }}
            className="px-3 py-2 rounded-lg text-sm font-medium bg-cc-primary hover:bg-cc-primary-hover text-white transition-colors cursor-pointer"
          >
            Open Environments Page
          </button>
        </div>
      </div>
    </div>
  );
}
