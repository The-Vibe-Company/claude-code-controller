import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { api, type CronJobInfo } from "../api.js";
import { getModelsForBackend, getDefaultModel, toModelOptions, type ModelOption } from "../utils/backends.js";
import { FolderPicker } from "./FolderPicker.js";

interface Props {
  onClose?: () => void;
  embedded?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function timeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

function humanizeSchedule(schedule: string, recurring: boolean): string {
  if (!recurring) return "One-time";

  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every minute
  if (schedule === "* * * * *") return "Every minute";

  // Every N minutes
  if (hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    if (minute.startsWith("*/")) {
      const n = parseInt(minute.slice(2), 10);
      if (n === 1) return "Every minute";
      return `Every ${n} minutes`;
    }
  }

  // Every N hours
  if (minute === "0" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    if (hour === "*") return "Every hour";
    if (hour.startsWith("*/")) {
      const n = parseInt(hour.slice(2), 10);
      if (n === 1) return "Every hour";
      return `Every ${n} hours`;
    }
  }

  // Specific hour patterns
  if (dayOfMonth === "*" && month === "*" && minute !== "*" && hour !== "*" && !hour.includes("/") && !hour.includes(",")) {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    if (!isNaN(h) && !isNaN(m)) {
      const period = h >= 12 ? "PM" : "AM";
      const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const displayMin = m.toString().padStart(2, "0");
      const timeStr = `${displayHour}:${displayMin} ${period}`;

      if (dayOfWeek === "*") return `Every day at ${timeStr}`;
      if (dayOfWeek === "1-5") return `Weekdays at ${timeStr}`;
      if (dayOfWeek === "0,6") return `Weekends at ${timeStr}`;
    }
  }

  return schedule;
}

interface JobFormData {
  name: string;
  prompt: string;
  recurring: boolean;
  schedule: string;
  oneTimeDate: string;
  backendType: "claude" | "codex";
  model: string;
  cwd: string;
}

const EMPTY_FORM: JobFormData = {
  name: "",
  prompt: "",
  recurring: true,
  schedule: "0 8 * * *",
  oneTimeDate: "",
  backendType: "claude",
  model: getDefaultModel("claude"),
  cwd: "",
};

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at 8am", value: "0 8 * * *" },
  { label: "Every 2 hours", value: "0 */2 * * *" },
  { label: "Weekdays at 9am", value: "0 9 * * 1-5" },
];

// ─── Component ───────────────────────────────────────────────────────────────

export function CronManager({ onClose, embedded = false }: Props) {
  const [jobs, setJobs] = useState<CronJobInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<JobFormData>(EMPTY_FORM);
  const [createForm, setCreateForm] = useState<JobFormData>(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [createCollapsed, setCreateCollapsed] = useState(true);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    api.listCronJobs().then(setJobs).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // ─── Create ──────────────────────────────────────────────────────────

  async function handleCreate() {
    const name = createForm.name.trim();
    const prompt = createForm.prompt.trim();
    if (!name || !prompt) return;

    setCreating(true);
    setError("");

    let schedule = createForm.schedule;
    if (!createForm.recurring && createForm.oneTimeDate) {
      schedule = new Date(createForm.oneTimeDate).toISOString();
    }

    try {
      await api.createCronJob({
        name,
        prompt,
        schedule,
        recurring: createForm.recurring,
        backendType: createForm.backendType,
        model: createForm.model.trim() || undefined,
        cwd: createForm.cwd.trim() || undefined,
      } as Partial<CronJobInfo>);
      setCreateForm(EMPTY_FORM);
      setCreateCollapsed(true);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  // ─── Edit ────────────────────────────────────────────────────────────

  function startEdit(job: CronJobInfo) {
    setEditingId(job.id);
    setEditForm({
      name: job.name,
      prompt: job.prompt,
      recurring: job.recurring,
      schedule: job.schedule,
      oneTimeDate: "",
      backendType: job.backendType,
      model: job.model,
      cwd: job.cwd,
    });
    setError("");
  }

  function cancelEdit() {
    setEditingId(null);
    setError("");
  }

  async function saveEdit() {
    if (!editingId) return;
    const name = editForm.name.trim();
    const prompt = editForm.prompt.trim();
    if (!name || !prompt) return;

    let schedule = editForm.schedule;
    if (!editForm.recurring && editForm.oneTimeDate) {
      schedule = new Date(editForm.oneTimeDate).toISOString();
    }

    try {
      await api.updateCronJob(editingId, {
        name,
        prompt,
        schedule,
        recurring: editForm.recurring,
        backendType: editForm.backendType,
        model: editForm.model.trim() || undefined,
        cwd: editForm.cwd.trim() || undefined,
      } as Partial<CronJobInfo>);
      setEditingId(null);
      setError("");
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // ─── Actions ─────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    try {
      await api.deleteCronJob(id);
      if (editingId === id) setEditingId(null);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleToggle(id: string) {
    try {
      await api.toggleCronJob(id);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRunNow(id: string) {
    setRunningIds((prev) => new Set(prev).add(id));
    try {
      await api.runCronJob(id);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // ─── Renderers ───────────────────────────────────────────────────────

  const errorBanner = error && (
    <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
      {error}
    </div>
  );

  const jobsList = loading ? (
    <div className="text-sm text-cc-muted text-center py-6">Loading scheduled tasks...</div>
  ) : jobs.length === 0 ? (
    <div className="text-sm text-cc-muted text-center py-6">
      No scheduled tasks yet. Create one below.
    </div>
  ) : (
    <div className="space-y-3">
      {jobs.map((job) => (
        <div key={job.id} className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
          {/* Job header */}
          <div className="flex items-center gap-2 px-3 py-2.5 bg-cc-card border-b border-cc-border">
            <span className="text-sm font-medium text-cc-fg flex-1 truncate">{job.name}</span>

            {/* Backend pill */}
            <span
              className={`text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 ${
                job.backendType === "codex"
                  ? "text-blue-500 bg-blue-500/10"
                  : "text-[#5BA8A0] bg-[#5BA8A0]/10"
              }`}
            >
              {job.backendType === "codex" ? "Codex" : "Claude"}
            </span>

            {/* Consecutive failures warning */}
            {job.consecutiveFailures > 0 && (
              <span className="text-[9px] font-medium px-1.5 rounded-full leading-[16px] shrink-0 text-cc-error bg-cc-error/10">
                {job.consecutiveFailures} fail{job.consecutiveFailures !== 1 ? "s" : ""}
              </span>
            )}

            {/* Toggle */}
            <button
              onClick={() => handleToggle(job.id)}
              className={`relative w-8 h-[18px] rounded-full transition-colors cursor-pointer shrink-0 ${
                job.enabled ? "bg-cc-primary" : "bg-cc-border"
              }`}
              title={job.enabled ? "Disable" : "Enable"}
            >
              <span
                className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-transform ${
                  job.enabled ? "left-[16px]" : "left-[2px]"
                }`}
              />
            </button>

            {/* Action buttons */}
            {editingId === job.id ? (
              <button
                onClick={cancelEdit}
                className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
              >
                Cancel
              </button>
            ) : (
              <>
                <button
                  onClick={() => handleRunNow(job.id)}
                  disabled={runningIds.has(job.id)}
                  className={`text-xs cursor-pointer ${
                    runningIds.has(job.id)
                      ? "text-cc-muted cursor-not-allowed"
                      : "text-cc-primary hover:text-cc-primary-hover"
                  }`}
                >
                  {runningIds.has(job.id) ? "Running..." : "Run Now"}
                </button>
                <button
                  onClick={() => startEdit(job)}
                  className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(job.id)}
                  className="text-xs text-cc-muted hover:text-cc-error cursor-pointer"
                >
                  Delete
                </button>
              </>
            )}
          </div>

          {/* Edit form (inline) */}
          {editingId === job.id && (
            <div className="px-3 py-3 space-y-2.5">
              <JobForm form={editForm} onChange={setEditForm} />
              <div className="flex items-center gap-2">
                <button
                  onClick={saveEdit}
                  className="px-3 py-2 text-xs font-medium bg-cc-primary hover:bg-cc-primary-hover text-white rounded-lg transition-colors cursor-pointer"
                >
                  Save
                </button>
                <button
                  onClick={cancelEdit}
                  className="px-3 py-2 text-xs font-medium text-cc-muted hover:text-cc-fg rounded-lg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Job details (collapsed) */}
          {editingId !== job.id && (
            <div className="px-3 py-2.5 space-y-1.5">
              {/* Prompt preview */}
              <div className="text-xs text-cc-muted truncate" title={job.prompt}>
                {job.prompt}
              </div>

              {/* Info row */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-cc-muted">
                {/* Schedule */}
                <span>{humanizeSchedule(job.schedule, job.recurring)}</span>

                {/* Next run */}
                {job.nextRunAt != null && job.enabled && (
                  <span>
                    Next: {timeUntil(job.nextRunAt)}
                  </span>
                )}

                {/* Last run */}
                {job.lastRunAt != null && (
                  <span className="flex items-center gap-1">
                    Last: {timeAgo(job.lastRunAt)}
                    {job.consecutiveFailures === 0 ? (
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-success">
                        <path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2.5-2.5a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-cc-error">
                        <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z" />
                      </svg>
                    )}
                  </span>
                )}

                {/* Total runs */}
                {job.totalRuns > 0 && (
                  <span>{job.totalRuns} run{job.totalRuns !== 1 ? "s" : ""}</span>
                )}

                {/* Working directory */}
                {job.cwd && (
                  <span className="font-mono-code truncate max-w-[200px]" title={job.cwd}>
                    {job.cwd}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );

  const createSection = (
    <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
      <button
        onClick={() => setCreateCollapsed(!createCollapsed)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-cc-card border-b border-cc-border cursor-pointer hover:bg-cc-hover transition-colors"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`w-3 h-3 text-cc-muted transition-transform ${createCollapsed ? "" : "rotate-90"}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-sm font-medium text-cc-fg">New Scheduled Task</span>
      </button>
      {!createCollapsed && (
        <div className="px-3 py-3 space-y-2.5">
          <JobForm form={createForm} onChange={setCreateForm} />
          <div className="text-[10px] text-cc-muted">
            Scheduled tasks run with full autonomy (bypassPermissions)
          </div>
          <button
            onClick={handleCreate}
            disabled={!createForm.name.trim() || !createForm.prompt.trim() || creating}
            className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
              createForm.name.trim() && createForm.prompt.trim() && !creating
                ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                : "bg-cc-hover text-cc-muted cursor-not-allowed"
            }`}
          >
            {creating ? "Creating..." : "Create"}
          </button>
        </div>
      )}
    </div>
  );

  // ─── Layout (embedded vs modal) ──────────────────────────────────────

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-cc-fg">Scheduled Tasks</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Run autonomous Claude Code or Codex sessions on a schedule.
            </p>
          </div>
          {errorBanner}
          <div className="mt-4 space-y-4">
            <section className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
              <h2 className="text-sm font-semibold text-cc-fg">Tasks</h2>
              {jobsList}
            </section>
            <section className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
              {createSection}
            </section>
          </div>
        </div>
      </div>
    );
  }

  const panel = (
    <div
      className="w-full max-w-2xl max-h-[90dvh] sm:max-h-[80dvh] mx-0 sm:mx-4 flex flex-col bg-cc-bg border border-cc-border rounded-t-[14px] sm:rounded-[14px] shadow-2xl overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-cc-border">
        <div>
          <h2 className="text-sm font-semibold text-cc-fg">Scheduled Tasks</h2>
          <p className="text-xs text-cc-muted mt-0.5">
            Run autonomous Claude Code or Codex sessions on a schedule
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-3 sm:py-4 space-y-4">
        {errorBanner}
        {jobsList}
        {createSection}
      </div>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50" onClick={onClose}>
      {panel}
    </div>,
    document.body,
  );
}

// ─── Shared Job Form ─────────────────────────────────────────────────────────

function JobForm({
  form,
  onChange,
}: {
  form: JobFormData;
  onChange: (form: JobFormData) => void;
}) {
  const update = (partial: Partial<JobFormData>) =>
    onChange({ ...form, ...partial });

  // ─── Dynamic model fetching (same pattern as HomePage) ──────────
  const [dynamicModels, setDynamicModels] = useState<ModelOption[] | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  const models = dynamicModels || getModelsForBackend(form.backendType);
  const selectedModel = models.find((m) => m.value === form.model) || models[0];

  // Fetch dynamic models when backend changes
  useEffect(() => {
    setDynamicModels(null);
    if (form.backendType !== "codex") return;
    api.getBackendModels(form.backendType).then((fetched) => {
      if (fetched.length > 0) {
        const options = toModelOptions(fetched);
        setDynamicModels(options);
        if (!options.some((m) => m.value === form.model)) {
          update({ model: options[0].value });
        }
      }
    }).catch(() => {
      // Fall back to hardcoded models silently
    });
  }, [form.backendType]); // eslint-disable-line react-hooks/exhaustive-deps

  // Set default model if empty
  useEffect(() => {
    if (!form.model) {
      update({ model: getDefaultModel(form.backendType) });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close model dropdown on outside click
  useEffect(() => {
    if (!showModelDropdown) return;
    function handleClick(e: PointerEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
    }
    document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, [showModelDropdown]);

  // Folder display label
  const dirLabel = form.cwd
    ? form.cwd.split("/").pop() || form.cwd
    : "Select folder";

  return (
    <div className="space-y-2.5">
      {/* Name */}
      <input
        type="text"
        value={form.name}
        onChange={(e) => update({ name: e.target.value })}
        placeholder="Task name (e.g. Daily test suite)"
        className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
      />

      {/* Prompt */}
      <textarea
        value={form.prompt}
        onChange={(e) => update({ prompt: e.target.value })}
        placeholder="Prompt for the session (e.g. Run the test suite and fix any failures)"
        rows={4}
        className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50 resize-y"
        style={{ minHeight: "100px" }}
      />

      {/* Schedule type toggle */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => update({ recurring: true })}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
              form.recurring
                ? "bg-cc-primary text-white"
                : "bg-cc-hover text-cc-muted hover:text-cc-fg"
            }`}
          >
            Recurring
          </button>
          <button
            onClick={() => update({ recurring: false })}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
              !form.recurring
                ? "bg-cc-primary text-white"
                : "bg-cc-hover text-cc-muted hover:text-cc-fg"
            }`}
          >
            One-time
          </button>
        </div>

        {form.recurring ? (
          <div className="space-y-1.5">
            {/* Cron presets */}
            <div className="flex flex-wrap gap-1.5">
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  onClick={() => update({ schedule: preset.value })}
                  className={`px-2 py-1 text-[10px] font-medium rounded-md transition-colors cursor-pointer ${
                    form.schedule === preset.value
                      ? "bg-cc-primary/20 text-cc-primary border border-cc-primary/30"
                      : "bg-cc-hover text-cc-muted hover:text-cc-fg border border-transparent"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {/* Cron expression input */}
            <input
              type="text"
              value={form.schedule}
              onChange={(e) => update({ schedule: e.target.value })}
              placeholder="Cron expression (e.g. 0 8 * * *)"
              className="w-full px-3 py-2 text-sm font-mono-code bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
            />
            <div className="text-[10px] text-cc-muted">
              {humanizeSchedule(form.schedule, true)}
            </div>
          </div>
        ) : (
          <input
            type="datetime-local"
            value={form.oneTimeDate}
            onChange={(e) => update({ oneTimeDate: e.target.value })}
            className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
          />
        )}
      </div>

      {/* Backend + Model + Folder row */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Backend toggle */}
        <button
          onClick={() => {
            const next = form.backendType === "claude" ? "codex" : "claude";
            update({ backendType: next as "claude" | "codex", model: getDefaultModel(next as "claude" | "codex") });
          }}
          className={`px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
            form.backendType === "codex"
              ? "bg-blue-500/15 text-blue-500 border border-blue-500/30"
              : "bg-[#5BA8A0]/15 text-[#5BA8A0] border border-[#5BA8A0]/30"
          }`}
        >
          {form.backendType === "codex" ? "Codex" : "Claude Code"}
        </button>

        {/* Model dropdown */}
        <div className="relative" ref={modelDropdownRef}>
          <button
            onClick={() => setShowModelDropdown(!showModelDropdown)}
            className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer border border-cc-border"
          >
            <span>{selectedModel?.icon}</span>
            <span>{selectedModel?.label}</span>
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          {showModelDropdown && (
            <div className="absolute left-0 bottom-full mb-1 w-52 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1">
              {models.map((m) => (
                <button
                  key={m.value}
                  onClick={() => {
                    update({ model: m.value });
                    setShowModelDropdown(false);
                  }}
                  className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                    m.value === form.model ? "text-cc-primary font-medium" : "text-cc-fg"
                  }`}
                >
                  <span>{m.icon}</span>
                  {m.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Folder picker */}
        <button
          onClick={() => setShowFolderPicker(true)}
          className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer border border-cc-border"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
            <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
          </svg>
          <span className="max-w-[200px] truncate font-mono-code">{dirLabel}</span>
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
        {showFolderPicker && (
          <FolderPicker
            initialPath={form.cwd || ""}
            onSelect={(path) => update({ cwd: path })}
            onClose={() => setShowFolderPicker(false)}
          />
        )}
      </div>
    </div>
  );
}
