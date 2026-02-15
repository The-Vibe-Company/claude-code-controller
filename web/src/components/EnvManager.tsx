import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { api, type CompanionEnv } from "../api.js";

interface Props {
  onClose?: () => void;
  embedded?: boolean;
}

interface VarRow {
  key: string;
  value: string;
}

export function EnvManager({ onClose, embedded = false }: Props) {
  const [envs, setEnvs] = useState<CompanionEnv[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editVars, setEditVars] = useState<VarRow[]>([]);
  const [error, setError] = useState("");

  // New env form
  const [newName, setNewName] = useState("");
  const [newVars, setNewVars] = useState<VarRow[]>([{ key: "", value: "" }]);
  const [creating, setCreating] = useState(false);

  const refresh = () => {
    api.listEnvs().then(setEnvs).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  function startEdit(env: CompanionEnv) {
    setEditingSlug(env.slug);
    setEditName(env.name);
    const rows = Object.entries(env.variables).map(([key, value]) => ({ key, value }));
    if (rows.length === 0) rows.push({ key: "", value: "" });
    setEditVars(rows);
    setError("");
  }

  function cancelEdit() {
    setEditingSlug(null);
    setError("");
  }

  async function saveEdit() {
    if (!editingSlug) return;
    const variables: Record<string, string> = {};
    for (const row of editVars) {
      const k = row.key.trim();
      if (k) variables[k] = row.value;
    }
    try {
      await api.updateEnv(editingSlug, { name: editName.trim() || undefined, variables });
      setEditingSlug(null);
      setError("");
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(slug: string) {
    try {
      await api.deleteEnv(slug);
      if (editingSlug === slug) setEditingSlug(null);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    const variables: Record<string, string> = {};
    for (const row of newVars) {
      const k = row.key.trim();
      if (k) variables[k] = row.value;
    }
    try {
      await api.createEnv(name, variables);
      setNewName("");
      setNewVars([{ key: "", value: "" }]);
      setError("");
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  const errorBanner = error && (
    <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
      {error}
    </div>
  );

  const environmentsList = loading ? (
    <div className="text-sm text-cc-muted text-center py-6">Loading environments...</div>
  ) : envs.length === 0 ? (
    <div className="text-sm text-cc-muted text-center py-6">No environments yet.</div>
  ) : (
    <div className="space-y-3">
      {envs.map((env) => (
        <div key={env.slug} className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
          {/* Env header row */}
          <div className="flex items-center gap-2 px-3 py-2.5 bg-cc-card border-b border-cc-border">
            <span className="text-sm font-medium text-cc-fg flex-1">{env.name}</span>
            <span className="text-xs text-cc-muted">
              {Object.keys(env.variables).length} var{Object.keys(env.variables).length !== 1 ? "s" : ""}
            </span>
            {editingSlug === env.slug ? (
              <button
                onClick={cancelEdit}
                className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
              >
                Cancel
              </button>
            ) : (
              <>
                <button
                  onClick={() => startEdit(env)}
                  className="text-xs text-cc-muted hover:text-cc-fg cursor-pointer"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(env.slug)}
                  className="text-xs text-cc-muted hover:text-cc-error cursor-pointer"
                >
                  Delete
                </button>
              </>
            )}
          </div>

          {/* Edit form */}
          {editingSlug === env.slug && (
            <div className="px-3 py-3 space-y-2">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Environment name"
                className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
              />
              <VarEditor rows={editVars} onChange={setEditVars} />
              <button
                onClick={saveEdit}
                className="px-3 py-2 text-xs font-medium bg-cc-primary hover:bg-cc-primary-hover text-white rounded-lg transition-colors cursor-pointer"
              >
                Save
              </button>
            </div>
          )}

          {/* Variable preview (collapsed) */}
          {editingSlug !== env.slug && Object.keys(env.variables).length > 0 && (
            <div className="px-3 py-2.5 space-y-1">
              {Object.entries(env.variables).map(([k, v]) => (
                <div key={k} className="flex items-center gap-1.5 text-xs leading-5">
                  <span className="font-mono-code text-cc-fg">{k}</span>
                  <span className="text-cc-muted">=</span>
                  <span className="font-mono-code text-cc-muted truncate">{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );

  const createForm = (
    <div className="border border-cc-border rounded-[10px] overflow-hidden bg-cc-card">
      <div className="px-3 py-2.5 bg-cc-card border-b border-cc-border">
        <span className="text-sm font-medium text-cc-fg">New Environment</span>
      </div>
      <div className="px-3 py-3 space-y-2.5">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Environment name (e.g. production)"
          className="w-full px-3 py-2 text-sm bg-cc-input-bg border border-cc-border rounded-lg text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
          onKeyDown={(e) => {
            if (e.key === "Enter" && newName.trim()) handleCreate();
          }}
        />
        <VarEditor rows={newVars} onChange={setNewVars} />
        <button
          onClick={handleCreate}
          disabled={!newName.trim() || creating}
          className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
            newName.trim() && !creating
              ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
              : "bg-cc-hover text-cc-muted cursor-not-allowed"
          }`}
        >
          {creating ? "Creating..." : "Create"}
        </button>
      </div>
    </div>
  );

  if (embedded) {
    return (
      <div className="h-full bg-cc-bg overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-cc-fg">Environments</h1>
            <p className="mt-1 text-sm text-cc-muted">
              Create and manage reusable environment profiles for new sessions.
            </p>
          </div>
          {errorBanner}
          <div className={`mt-4 grid gap-4 ${envs.length > 0 ? "xl:grid-cols-[1.45fr_1fr]" : ""}`}>
            <section className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3">
              <h2 className="text-sm font-semibold text-cc-fg">Profiles</h2>
              {environmentsList}
            </section>
            <section className="bg-cc-card border border-cc-border rounded-xl p-4 sm:p-5 space-y-3 h-fit xl:sticky xl:top-4">
              <h2 className="text-sm font-semibold text-cc-fg">Create</h2>
              {createForm}
            </section>
          </div>
        </div>
      </div>
    );
  }

  const panel = (
    <div
      className="w-full max-w-lg max-h-[90dvh] sm:max-h-[80dvh] mx-0 sm:mx-4 flex flex-col bg-cc-bg border border-cc-border rounded-t-[14px] sm:rounded-[14px] shadow-2xl overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 sm:px-5 py-3 sm:py-4 border-b border-cc-border">
        <h2 className="text-sm font-semibold text-cc-fg">Manage Environments</h2>
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
        {environmentsList}
        {createForm}
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

// ─── Key-Value Editor ───────────────────────────────────────────────────

function VarEditor({ rows, onChange }: { rows: VarRow[]; onChange: (rows: VarRow[]) => void }) {
  function updateRow(i: number, field: "key" | "value", val: string) {
    const next = [...rows];
    next[i] = { ...next[i], [field]: val };
    onChange(next);
  }

  function removeRow(i: number) {
    const next = rows.filter((_, idx) => idx !== i);
    if (next.length === 0) next.push({ key: "", value: "" });
    onChange(next);
  }

  function addRow() {
    onChange([...rows, { key: "", value: "" }]);
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            type="text"
            value={row.key}
            onChange={(e) => updateRow(i, "key", e.target.value)}
            placeholder="KEY"
            className="flex-1 min-w-0 px-2 py-1 text-[11px] font-mono-code bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
          />
          <span className="text-[10px] text-cc-muted">=</span>
          <input
            type="text"
            value={row.value}
            onChange={(e) => updateRow(i, "value", e.target.value)}
            placeholder="value"
            className="flex-1 min-w-0 px-2 py-1 text-[11px] font-mono-code bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
          />
          <button
            onClick={() => removeRow(i)}
            className="w-5 h-5 flex items-center justify-center rounded text-cc-muted hover:text-cc-error transition-colors cursor-pointer shrink-0"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-2.5 h-2.5">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
      <button
        onClick={addRow}
        className="text-[10px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
      >
        + Add variable
      </button>
    </div>
  );
}
