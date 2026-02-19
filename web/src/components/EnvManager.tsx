import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { api, type CompanionEnv, type ImagePullState } from "../api.js";

interface Props {
  onClose?: () => void;
  embedded?: boolean;
}

interface VarRow {
  key: string;
  value: string;
}

type Tab = "variables" | "docker" | "ports" | "init";

const DEFAULT_DOCKERFILE = `FROM the-companion:latest

# Add project-specific dependencies here
# RUN apt-get update && apt-get install -y ...
# RUN npm install -g ...

WORKDIR /workspace
CMD ["sleep", "infinity"]
`;

export function EnvManager({ onClose, embedded = false }: Props) {
  const [envs, setEnvs] = useState<CompanionEnv[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editVars, setEditVars] = useState<VarRow[]>([]);
  const [editDockerfile, setEditDockerfile] = useState("");
  const [editBaseImage, setEditBaseImage] = useState("");
  const [editPorts, setEditPorts] = useState<number[]>([]);
  const [editInitScript, setEditInitScript] = useState("");
  const [error, setError] = useState("");

  // Docker build state
  const [building, setBuilding] = useState(false);
  const [buildLog, setBuildLog] = useState("");
  const [showBuildLog, setShowBuildLog] = useState(false);

  // Docker availability
  const [dockerAvailable, setDockerAvailable] = useState<boolean | null>(null);
  const [availableImages, setAvailableImages] = useState<string[]>([]);

  // Image pull state tracking (keyed by image tag)
  const [imageStates, setImageStates] = useState<Record<string, ImagePullState>>({});
  const pullPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Fetch pull status for a specific image and update state */
  const refreshImageStatus = useCallback((tag: string) => {
    api.getImageStatus(tag).then((state) => {
      setImageStates((prev) => ({ ...prev, [tag]: state }));
    }).catch(() => {});
  }, []);

  /** Trigger a pull for an image and start polling */
  const handlePullImage = useCallback((tag: string) => {
    api.pullImage(tag).then((res) => {
      if (res.state) {
        setImageStates((prev) => ({ ...prev, [tag]: res.state }));
      }
    }).catch(() => {});
  }, []);

  // Track pulling images in a ref so the interval callback always reads current values
  const pullingImagesRef = useRef<string[]>([]);
  useEffect(() => {
    const pullingImages = Object.entries(imageStates)
      .filter(([, s]) => s.status === "pulling")
      .map(([tag]) => tag);
    pullingImagesRef.current = pullingImages;

    if (pullingImages.length === 0) {
      if (pullPollRef.current) {
        clearInterval(pullPollRef.current);
        pullPollRef.current = null;
      }
      return;
    }

    if (!pullPollRef.current) {
      pullPollRef.current = setInterval(() => {
        for (const tag of pullingImagesRef.current) {
          refreshImageStatus(tag);
        }
      }, 2000);
    }

    return () => {
      if (pullPollRef.current) {
        clearInterval(pullPollRef.current);
        pullPollRef.current = null;
      }
    };
  }, [imageStates, refreshImageStatus]);

  // On mount, check image status for all envs that have docker images
  useEffect(() => {
    if (!dockerAvailable) return;
    for (const env of envs) {
      const img = env.imageTag || env.baseImage;
      if (img) refreshImageStatus(img);
    }
  }, [envs, dockerAvailable, refreshImageStatus]);

  // New env form
  const [newName, setNewName] = useState("");
  const [newVars, setNewVars] = useState<VarRow[]>([{ key: "", value: "" }]);
  const [newDockerfile, setNewDockerfile] = useState("");
  const [newBaseImage, setNewBaseImage] = useState("");
  const [newPorts, setNewPorts] = useState<number[]>([]);
  const [newInitScript, setNewInitScript] = useState("");
  const [newTab, setNewTab] = useState<Tab>("variables");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    api.listEnvs().then(setEnvs).catch(() => {}).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    // Check Docker availability
    api.getContainerStatus().then((s) => {
      setDockerAvailable(s.available);
      if (s.available) {
        api.getContainerImages().then(setAvailableImages).catch(() => {});
      }
    }).catch(() => setDockerAvailable(false));
  }, [refresh]);

  function startEdit(env: CompanionEnv) {
    setEditingSlug(env.slug);
    setEditName(env.name);
    const rows = Object.entries(env.variables).map(([key, value]) => ({ key, value }));
    if (rows.length === 0) rows.push({ key: "", value: "" });
    setEditVars(rows);
    setEditDockerfile(env.dockerfile || "");
    setEditBaseImage(env.baseImage || "");
    setEditPorts(env.ports || []);
    setEditInitScript(env.initScript || "");
    setError("");
    setBuildLog("");
    setShowBuildLog(false);
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
      await api.updateEnv(editingSlug, {
        name: editName.trim() || undefined,
        variables,
        dockerfile: editDockerfile || undefined,
        baseImage: editBaseImage || undefined,
        ports: editPorts.length > 0 ? editPorts : undefined,
        initScript: editInitScript || undefined,
      });
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
      await api.createEnv(name, variables, {
        dockerfile: newDockerfile || undefined,
        baseImage: newBaseImage || undefined,
        ports: newPorts.length > 0 ? newPorts : undefined,
        initScript: newInitScript || undefined,
      });
      setNewName("");
      setNewVars([{ key: "", value: "" }]);
      setNewDockerfile("");
      setNewBaseImage("");
      setNewPorts([]);
      setNewInitScript("");
      setNewTab("variables");
      setError("");
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handleBuild(slug: string) {
    setBuilding(true);
    setBuildLog("Starting build...\n");
    setShowBuildLog(true);
    try {
      await api.buildEnvImage(slug);
      // Poll build status
      const poll = async () => {
        const status = await api.getEnvBuildStatus(slug);
        if (status.buildStatus === "building") {
          setTimeout(poll, 2000);
        } else {
          setBuilding(false);
          if (status.buildStatus === "success") {
            setBuildLog((prev) => prev + "\nBuild successful!");
          } else {
            setBuildLog((prev) => prev + `\nBuild failed: ${status.buildError || "Unknown error"}`);
          }
          refresh();
          // Refresh images list
          api.getContainerImages().then(setAvailableImages).catch(() => {});
        }
      };
      setTimeout(poll, 2000);
    } catch (e: unknown) {
      setBuilding(false);
      setBuildLog((prev) => prev + `\nBuild error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const errorBanner = error && (
    <div className="px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
      {error}
    </div>
  );

  const dockerBadge = dockerAvailable === null ? null : dockerAvailable ? (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-500">Docker</span>
  ) : (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500">No Docker</span>
  );

  function renderTabs(activeTab: Tab, setTab: (t: Tab) => void) {
    return (
      <div className="flex gap-0.5 border-b border-cc-border mb-2.5">
        {(["variables", "docker", "ports", "init"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-[11px] font-medium transition-colors cursor-pointer capitalize ${
              activeTab === t
                ? "text-cc-primary border-b-2 border-cc-primary -mb-[1px]"
                : "text-cc-muted hover:text-cc-fg"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
    );
  }

  function renderDockerTab(
    dockerfile: string,
    setDockerfile: (v: string) => void,
    baseImage: string,
    setBaseImage: (v: string) => void,
    slug?: string,
    env?: CompanionEnv,
  ) {
    const effectiveImg = env?.imageTag || baseImage;
    const imgState = effectiveImg ? imageStates[effectiveImg] : undefined;
    const isPulling = imgState?.status === "pulling";

    return (
      <div className="space-y-3">
        {/* Base image selector */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[11px] text-cc-muted">Base Image</label>
            {effectiveImg && (
              <div className="flex items-center gap-1.5">
                {/* Image status badge */}
                {imgState?.status === "ready" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-500">Ready</span>
                )}
                {imgState?.status === "pulling" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 flex items-center gap-1">
                    <span className="w-2.5 h-2.5 border border-amber-500/30 border-t-amber-500 rounded-full animate-spin" />
                    Pulling...
                  </span>
                )}
                {imgState?.status === "idle" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-hover text-cc-muted">Not downloaded</span>
                )}
                {imgState?.status === "error" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-error/10 text-cc-error">Pull failed</span>
                )}
                {/* Pull / Update button */}
                <button
                  onClick={() => handlePullImage(effectiveImg)}
                  disabled={isPulling}
                  className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${
                    isPulling
                      ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                      : "bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 cursor-pointer"
                  }`}
                >
                  {isPulling ? "Pulling..." : imgState?.status === "ready" ? "Update" : "Pull"}
                </button>
              </div>
            )}
          </div>
          <select
            value={baseImage}
            onChange={(e) => {
              setBaseImage(e.target.value);
              // Immediately check status for the newly selected image
              if (e.target.value) refreshImageStatus(e.target.value);
            }}
            className="w-full px-2 py-1.5 text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg focus:outline-none focus:border-cc-primary/50"
          >
            <option value="">None (local execution)</option>
            <option value="the-companion:latest">the-companion:latest</option>
            {availableImages
              .filter((img) => img !== "the-companion:latest")
              .map((img) => (
                <option key={img} value={img}>{img}</option>
              ))}
          </select>
        </div>

        {/* Pull progress */}
        {isPulling && imgState?.progress && imgState.progress.length > 0 && (
          <pre className="px-3 py-2 text-[10px] font-mono-code bg-black/20 border border-cc-border rounded-md text-cc-muted max-h-[120px] overflow-auto whitespace-pre-wrap">
            {imgState.progress.slice(-20).join("\n")}
          </pre>
        )}

        {/* Dockerfile editor */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[11px] text-cc-muted">Dockerfile (optional override)</label>
            {!dockerfile && (
              <button
                onClick={() => setDockerfile(DEFAULT_DOCKERFILE)}
                className="text-[10px] text-cc-primary hover:underline cursor-pointer"
              >
                Use template
              </button>
            )}
          </div>
          <textarea
            value={dockerfile}
            onChange={(e) => setDockerfile(e.target.value)}
            placeholder="# Custom Dockerfile content..."
            rows={10}
            className="w-full px-3 py-2 text-[11px] font-mono-code bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50 resize-y"
            style={{ minHeight: "120px" }}
          />
        </div>

        {/* Build button + status */}
        {slug && dockerfile && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleBuild(slug)}
                disabled={building}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  building
                    ? "bg-cc-hover text-cc-muted cursor-not-allowed"
                    : "bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 cursor-pointer"
                }`}
              >
                {building ? "Building..." : "Build Image"}
              </button>
              {env?.buildStatus === "success" && env.lastBuiltAt && (
                <span className="text-[10px] text-green-500">
                  Built {new Date(env.lastBuiltAt).toLocaleDateString()}
                </span>
              )}
              {env?.buildStatus === "error" && (
                <span className="text-[10px] text-cc-error">Build failed</span>
              )}
              {env?.imageTag && (
                <span className="text-[10px] text-cc-muted font-mono-code">{env.imageTag}</span>
              )}
            </div>

            {/* Build log */}
            {showBuildLog && buildLog && (
              <div className="relative">
                <button
                  onClick={() => setShowBuildLog(false)}
                  className="absolute top-1 right-1 text-cc-muted hover:text-cc-fg cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                </button>
                <pre className="px-3 py-2 text-[10px] font-mono-code bg-black/20 border border-cc-border rounded-md text-cc-muted max-h-[200px] overflow-auto whitespace-pre-wrap">
                  {buildLog}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderPortsTab(ports: number[], setPorts: (p: number[]) => void) {
    return (
      <div className="space-y-2">
        <label className="block text-[11px] text-cc-muted">Ports to expose in the container</label>
        {ports.map((port, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              type="number"
              value={port}
              onChange={(e) => {
                const next = [...ports];
                next[i] = parseInt(e.target.value, 10) || 0;
                setPorts(next);
              }}
              min={1}
              max={65535}
              className="w-24 px-2 py-1 text-[11px] font-mono-code bg-cc-input-bg border border-cc-border rounded-md text-cc-fg focus:outline-none focus:border-cc-primary/50"
            />
            <button
              onClick={() => setPorts(ports.filter((_, idx) => idx !== i))}
              className="w-5 h-5 flex items-center justify-center rounded text-cc-muted hover:text-cc-error transition-colors cursor-pointer shrink-0"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-2.5 h-2.5">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
        <button
          onClick={() => setPorts([...ports, 3000])}
          className="text-[10px] text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
        >
          + Add port
        </button>
      </div>
    );
  }

  function renderInitScriptTab(
    initScript: string,
    setInitScript: (v: string) => void,
  ) {
    return (
      <div className="space-y-3">
        <div>
          <label className="block text-[11px] text-cc-muted mb-1">
            Init Script
          </label>
          <textarea
            value={initScript}
            onChange={(e) => setInitScript(e.target.value)}
            placeholder={"# Runs inside the container before Claude starts\n# Example:\nbun install\npip install -r requirements.txt"}
            rows={10}
            className="w-full px-3 py-2 text-[11px] font-mono-code bg-cc-input-bg border border-cc-border rounded-md text-cc-fg placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50 resize-y"
            style={{ minHeight: "120px" }}
          />
        </div>
        <p className="text-[10px] text-cc-muted">
          This shell script runs as root inside the container via{" "}
          <code className="bg-cc-hover px-1 rounded">sh -lc</code> before the session starts.
          Use it to install project-specific dependencies. Timeout: 120s.
        </p>
      </div>
    );
  }

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
            {env.imageTag && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-mono-code">
                {env.imageTag.split(":")[0]?.split("/").pop() || env.imageTag}
              </span>
            )}
            {!env.imageTag && env.baseImage && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-cc-hover text-cc-muted font-mono-code">
                {env.baseImage}
              </span>
            )}
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
              <div className="space-y-3">
                <div>
                  <div className="text-[11px] font-medium text-cc-muted mb-1.5">Variables</div>
                  <VarEditor rows={editVars} onChange={setEditVars} />
                </div>
                <div>
                  <div className="text-[11px] font-medium text-cc-muted mb-1.5">Docker</div>
                  {renderDockerTab(editDockerfile, setEditDockerfile, editBaseImage, setEditBaseImage, env.slug, env)}
                </div>
                <div>
                  <div className="text-[11px] font-medium text-cc-muted mb-1.5">Ports</div>
                  {renderPortsTab(editPorts, setEditPorts)}
                </div>
                <div>
                  <div className="text-[11px] font-medium text-cc-muted mb-1.5">Init Script</div>
                  {renderInitScriptTab(editInitScript, setEditInitScript)}
                </div>
              </div>
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
                <div key={k} className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-1.5 text-xs leading-5">
                  <span className="font-mono-code text-cc-fg break-all">{k}</span>
                  <span className="text-cc-muted">=</span>
                  <span className="font-mono-code text-cc-muted break-all whitespace-pre-wrap">{v}</span>
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
        {renderTabs(newTab, setNewTab)}
        {newTab === "variables" && <VarEditor rows={newVars} onChange={setNewVars} />}
        {newTab === "docker" && renderDockerTab(newDockerfile, setNewDockerfile, newBaseImage, setNewBaseImage)}
        {newTab === "ports" && renderPortsTab(newPorts, setNewPorts)}
        {newTab === "init" && renderInitScriptTab(newInitScript, setNewInitScript)}
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
          <div className="mb-6 flex items-center gap-3">
            <div className="flex-1">
              <h1 className="text-xl font-semibold text-cc-fg">Environments</h1>
              <p className="mt-1 text-sm text-cc-muted">
                Create and manage reusable environment profiles with optional Docker isolation.
              </p>
            </div>
            {dockerBadge}
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
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-cc-fg">Manage Environments</h2>
          {dockerBadge}
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
