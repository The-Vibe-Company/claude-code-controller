import { useState, useRef, useEffect, useCallback } from "react";
import { useStore } from "../store.js";
import { api, type DirEntry, type CompanionEnv } from "../api.js";
import { connectSession, waitForConnection, sendToSession } from "../ws.js";
import { disconnectSession } from "../ws.js";
import { generateUniqueSessionName } from "../utils/names.js";
import { EnvManager } from "./EnvManager.js";

interface ImageAttachment {
  name: string;
  base64: string;
  mediaType: string;
}

function readFileAsBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ base64, mediaType: file.type });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const MODELS = [
  { value: "claude-opus-4-6", label: "Opus", icon: "\u2733" },
  { value: "claude-sonnet-4-5-20250929", label: "Sonnet", icon: "\u25D0" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku", icon: "\u26A1" },
];

const MODES = [
  { value: "bypassPermissions", label: "Agent" },
  { value: "plan", label: "Plan" },
];

const RECENT_DIRS_KEY = "cc-recent-dirs";

function getRecentDirs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_DIRS_KEY) || "[]");
  } catch {
    return [];
  }
}

function addRecentDir(dir: string) {
  const dirs = getRecentDirs().filter((d) => d !== dir);
  dirs.unshift(dir);
  localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(dirs.slice(0, 5)));
}

let idCounter = 0;

export function HomePage() {
  const [text, setText] = useState("");
  const [model, setModel] = useState(MODELS[0].value);
  const [mode, setMode] = useState(MODES[0].value);
  const [cwd, setCwd] = useState(() => getRecentDirs()[0] || "");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  // Environment state
  const [envs, setEnvs] = useState<CompanionEnv[]>([]);
  const [selectedEnv, setSelectedEnv] = useState(() => localStorage.getItem("cc-selected-env") || "");
  const [showEnvDropdown, setShowEnvDropdown] = useState(false);
  const [showEnvManager, setShowEnvManager] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dropdown states
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [showDirDropdown, setShowDirDropdown] = useState(false);
  const [browsePath, setBrowsePath] = useState("");
  const [browseDirs, setBrowseDirs] = useState<DirEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [dirInput, setDirInput] = useState("");
  const [showDirInput, setShowDirInput] = useState(false);
  const [recentProjects, setRecentProjects] = useState<string[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const dirDropdownRef = useRef<HTMLDivElement>(null);
  const envDropdownRef = useRef<HTMLDivElement>(null);

  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const currentSessionId = useStore((s) => s.currentSessionId);

  // Auto-focus textarea
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Load server home/cwd on mount
  useEffect(() => {
    api.getHome().then(({ home, cwd: serverCwd }) => {
      if (!cwd) {
        setCwd(serverCwd || home);
      }
    }).catch(() => {});
    api.listEnvs().then(setEnvs).catch(() => {});
    api.getRecentProjects().then(({ projects }) => setRecentProjects(projects)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target as Node)) {
        setShowModeDropdown(false);
      }
      if (dirDropdownRef.current && !dirDropdownRef.current.contains(e.target as Node)) {
        setShowDirDropdown(false);
        setShowDirInput(false);
      }
      if (envDropdownRef.current && !envDropdownRef.current.contains(e.target as Node)) {
        setShowEnvDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const loadDirs = useCallback(async (path?: string) => {
    setBrowseLoading(true);
    try {
      const result = await api.listDirs(path);
      setBrowsePath(result.path);
      setBrowseDirs(result.dirs);
    } catch {
      setBrowseDirs([]);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  const selectedModel = MODELS.find((m) => m.value === model) || MODELS[0];
  const selectedMode = MODES.find((m) => m.value === mode) || MODES[0];
  const dirLabel = cwd ? cwd.split("/").pop() || cwd : "Select folder";

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const newImages: ImageAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: file.name, base64, mediaType });
    }
    setImages((prev) => [...prev, ...newImages]);
    e.target.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const newImages: ImageAttachment[] = [];
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (!file) continue;
      const { base64, mediaType } = await readFileAsBase64(file);
      newImages.push({ name: `pasted-${Date.now()}.${file.type.split("/")[1]}`, base64, mediaType });
    }
    if (newImages.length > 0) {
      e.preventDefault();
      setImages((prev) => [...prev, ...newImages]);
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 300) + "px";
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      setMode(mode === "plan" ? "bypassPermissions" : "plan");
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSend() {
    const msg = text.trim();
    if (!msg || sending) return;

    setSending(true);
    setError("");

    try {
      // Disconnect current session if any
      if (currentSessionId) {
        disconnectSession(currentSessionId);
      }

      // Create session
      const result = await api.createSession({
        model,
        permissionMode: mode,
        cwd: cwd || undefined,
        envSlug: selectedEnv || undefined,
      });
      const sessionId = result.sessionId;

      // Assign a random session name
      const existingNames = new Set(useStore.getState().sessionNames.values());
      const sessionName = generateUniqueSessionName(existingNames);
      useStore.getState().setSessionName(sessionId, sessionName);

      // Save cwd to recent dirs
      if (cwd) addRecentDir(cwd);

      // Store the permission mode for this session
      useStore.getState().setPreviousPermissionMode(sessionId, mode);

      // Switch to session
      setCurrentSession(sessionId);
      connectSession(sessionId);

      // Wait for WebSocket connection
      await waitForConnection(sessionId);

      // Send message
      sendToSession(sessionId, {
        type: "user_message",
        content: msg,
        session_id: sessionId,
        images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
      });

      // Add user message to store
      useStore.getState().appendMessage(sessionId, {
        id: `user-${Date.now()}-${++idCounter}`,
        role: "user",
        content: msg,
        images: images.length > 0 ? images.map((img) => ({ media_type: img.mediaType, data: img.base64 })) : undefined,
        timestamp: Date.now(),
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  }

  const canSend = text.trim().length > 0 && !sending;

  return (
    <div className="flex-1 h-full flex items-center justify-center px-3 sm:px-4">
      <div className="w-full max-w-2xl">
        {/* Title */}
        <h1 className="text-xl sm:text-2xl font-semibold text-cc-fg text-center mb-4 sm:mb-6">
          The Vibe Companion
        </h1>

        {/* Image thumbnails */}
        {images.length > 0 && (
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={`data:${img.mediaType};base64,${img.base64}`}
                  alt={img.name}
                  className="w-12 h-12 rounded-lg object-cover border border-cc-border"
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-cc-error text-white flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-2.5 h-2.5">
                    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileSelect}
          className="hidden"
        />

        {/* Input card */}
        <div className="bg-cc-card border border-cc-border rounded-[14px] shadow-sm overflow-hidden">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Fix a bug, build a feature, refactor code..."
            rows={4}
            className="w-full px-4 pt-4 pb-2 text-sm bg-transparent resize-none focus:outline-none text-cc-fg font-sans-ui placeholder:text-cc-muted"
            style={{ minHeight: "100px", maxHeight: "300px" }}
          />

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-3 pb-3">
            {/* Left: mode dropdown */}
            <div className="relative" ref={modeDropdownRef}>
              <button
                onClick={() => setShowModeDropdown(!showModeDropdown)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-cc-muted hover:text-cc-fg rounded-lg hover:bg-cc-hover transition-colors cursor-pointer"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
                  <path d="M2 4h12M2 8h8M2 12h10" strokeLinecap="round" />
                </svg>
                {selectedMode.label}
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
              {showModeDropdown && (
                <div className="absolute left-0 bottom-full mb-1 w-40 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                  {MODES.map((m) => (
                    <button
                      key={m.value}
                      onClick={() => { setMode(m.value); setShowModeDropdown(false); }}
                      className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                        m.value === mode ? "text-cc-primary font-medium" : "text-cc-fg"
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Right: image placeholder + send */}
            <div className="flex items-center gap-1.5">
              {/* Image upload */}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center justify-center w-8 h-8 rounded-lg text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                title="Upload image"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
                  <rect x="2" y="2" width="12" height="12" rx="2" />
                  <circle cx="5.5" cy="5.5" r="1" fill="currentColor" stroke="none" />
                  <path d="M2 11l3-3 2 2 3-4 4 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {/* Send button */}
              <button
                onClick={handleSend}
                disabled={!canSend}
                className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors ${
                  canSend
                    ? "bg-cc-primary hover:bg-cc-primary-hover text-white cursor-pointer"
                    : "bg-cc-hover text-cc-muted cursor-not-allowed"
                }`}
                title="Send message"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M3 2l11 6-11 6V9.5l7-1.5-7-1.5V2z" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* Below-card selectors */}
        <div className="flex items-center gap-1 sm:gap-3 mt-2 sm:mt-3 px-1 flex-nowrap">
          {/* Folder selector */}
          <div className="relative" ref={dirDropdownRef}>
            <button
              onClick={() => {
                if (!showDirDropdown) {
                  setShowDirDropdown(true);
                  setShowDirInput(false);
                  loadDirs(cwd || undefined);
                } else {
                  setShowDirDropdown(false);
                }
              }}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              </svg>
              <span className="max-w-[200px] truncate font-mono-code">{dirLabel}</span>
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {showDirDropdown && (
              <div className="absolute left-0 top-full mt-1 w-80 max-w-[calc(100vw-2rem)] max-h-[min(400px,60vh)] flex flex-col bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 overflow-hidden">
                {/* Current path display + manual input toggle */}
                <div className="px-3 py-2 border-b border-cc-border flex items-center gap-2 shrink-0">
                  {showDirInput ? (
                    <input
                      type="text"
                      value={dirInput}
                      onChange={(e) => setDirInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && dirInput.trim()) {
                          setCwd(dirInput.trim());
                          addRecentDir(dirInput.trim());
                          setShowDirDropdown(false);
                          setShowDirInput(false);
                        }
                        if (e.key === "Escape") {
                          setShowDirInput(false);
                        }
                      }}
                      placeholder="/path/to/project"
                      className="flex-1 px-2 py-1 text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg font-mono-code placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="text-[10px] text-cc-muted font-mono-code truncate flex-1">{browsePath}</span>
                      <button
                        onClick={() => { setShowDirInput(true); setDirInput(cwd); }}
                        className="text-[10px] text-cc-muted hover:text-cc-fg shrink-0 cursor-pointer"
                        title="Type path manually"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
                          <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.463 11.098a.25.25 0 00-.064.108l-.563 1.97 1.971-.564a.25.25 0 00.108-.064l8.61-8.61a.25.25 0 000-.354l-1.098-1.097z" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>

                {/* Directory browser */}
                {!showDirInput && (
                  <>
                    {/* Recent projects */}
                    {recentProjects.length > 0 && (
                      <>
                        <div className="px-3 py-1.5 text-[10px] text-cc-muted font-medium uppercase tracking-wide">
                          Recent Projects
                        </div>
                        {recentProjects.map((projectPath) => (
                          <button
                            key={projectPath}
                            onClick={() => {
                              setCwd(projectPath);
                              addRecentDir(projectPath);
                              setShowDirDropdown(false);
                            }}
                            className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer truncate font-mono-code flex items-center gap-2 text-cc-fg"
                          >
                            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-40 shrink-0">
                              <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                            </svg>
                            <span className="truncate">{projectPath.split("/").slice(-2).join("/")}</span>
                          </button>
                        ))}
                        <div className="border-b border-cc-border my-1" />
                      </>
                    )}

                    {/* Go up button */}
                    {browsePath && browsePath !== "/" && (
                      <button
                        onClick={() => {
                          const parent = browsePath.split("/").slice(0, -1).join("/") || "/";
                          loadDirs(parent);
                        }}
                        className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-muted"
                      >
                        <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-60">
                          <path d="M8 12l-4-4h2.5V4h3v4H12L8 12z" transform="rotate(180 8 8)" />
                        </svg>
                        <span>..</span>
                      </button>
                    )}

                    {/* Select current directory */}
                    <button
                      onClick={() => {
                        setCwd(browsePath);
                        addRecentDir(browsePath);
                        setShowDirDropdown(false);
                      }}
                      className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-primary font-medium border-b border-cc-border"
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
                        <path d="M12.416 3.376a.75.75 0 01.208 1.04l-5 7.5a.75.75 0 01-1.154.114l-3-3a.75.75 0 011.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 011.04-.207z" />
                      </svg>
                      <span className="truncate font-mono-code">Select: {browsePath.split("/").pop() || "/"}</span>
                    </button>

                    {/* Subdirectories */}
                    <div className="flex-1 min-h-0 overflow-y-auto">
                      {browseLoading ? (
                        <div className="px-3 py-3 text-xs text-cc-muted text-center">Loading...</div>
                      ) : browseDirs.length === 0 ? (
                        <div className="px-3 py-3 text-xs text-cc-muted text-center">No subdirectories</div>
                      ) : (
                        browseDirs.map((d) => (
                          <button
                            key={d.path}
                            onClick={() => loadDirs(d.path)}
                            onDoubleClick={() => {
                              setCwd(d.path);
                              addRecentDir(d.path);
                              setShowDirDropdown(false);
                            }}
                            className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer truncate font-mono-code flex items-center gap-2 text-cc-fg"
                          >
                            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-40 shrink-0">
                              <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                            </svg>
                            <span className="truncate">{d.name}</span>
                            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-30 shrink-0 ml-auto">
                              <path d="M6 4l4 4-4 4" />
                            </svg>
                          </button>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Environment selector */}
          <div className="relative" ref={envDropdownRef}>
            <button
              onClick={() => {
                if (!showEnvDropdown) {
                  api.listEnvs().then(setEnvs).catch(() => {});
                }
                setShowEnvDropdown(!showEnvDropdown);
              }}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                <path d="M8 1a2 2 0 012 2v1h2a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2h2V3a2 2 0 012-2zm0 1.5a.5.5 0 00-.5.5v1h1V3a.5.5 0 00-.5-.5zM4 5.5a.5.5 0 00-.5.5v6a.5.5 0 00.5.5h8a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H4z" />
              </svg>
              <span className="max-w-[120px] truncate">
                {selectedEnv ? envs.find((e) => e.slug === selectedEnv)?.name || "Env" : "No env"}
              </span>
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {showEnvDropdown && (
              <div className="absolute left-0 top-full mt-1 w-56 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                <button
                  onClick={() => {
                    setSelectedEnv("");
                    localStorage.setItem("cc-selected-env", "");
                    setShowEnvDropdown(false);
                  }}
                  className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer ${
                    !selectedEnv ? "text-cc-primary font-medium" : "text-cc-fg"
                  }`}
                >
                  No environment
                </button>
                {envs.map((env) => (
                  <button
                    key={env.slug}
                    onClick={() => {
                      setSelectedEnv(env.slug);
                      localStorage.setItem("cc-selected-env", env.slug);
                      setShowEnvDropdown(false);
                    }}
                    className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-1 ${
                      env.slug === selectedEnv ? "text-cc-primary font-medium" : "text-cc-fg"
                    }`}
                  >
                    <span className="truncate">{env.name}</span>
                    <span className="text-cc-muted ml-auto shrink-0">
                      {Object.keys(env.variables).length} var{Object.keys(env.variables).length !== 1 ? "s" : ""}
                    </span>
                  </button>
                ))}
                <div className="border-t border-cc-border mt-1 pt-1">
                  <button
                    onClick={() => {
                      setShowEnvManager(true);
                      setShowEnvDropdown(false);
                    }}
                    className="w-full px-3 py-2 text-xs text-left text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                  >
                    Manage environments...
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Model selector */}
          <div className="relative" ref={modelDropdownRef}>
            <button
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <span>{selectedModel.icon}</span>
              <span>{selectedModel.label}</span>
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {showModelDropdown && (
              <div className="absolute left-0 top-full mt-1 w-44 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
                {MODELS.map((m) => (
                  <button
                    key={m.value}
                    onClick={() => { setModel(m.value); setShowModelDropdown(false); }}
                    className={`w-full px-3 py-2 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                      m.value === model ? "text-cc-primary font-medium" : "text-cc-fg"
                    }`}
                  >
                    <span>{m.icon}</span>
                    {m.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-cc-error/5 border border-cc-error/20">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-cc-error shrink-0">
              <path fillRule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm1-3a1 1 0 11-2 0 1 1 0 012 0zM7.5 5.5a.5.5 0 011 0v3a.5.5 0 01-1 0v-3z" clipRule="evenodd" />
            </svg>
            <p className="text-xs text-cc-error">{error}</p>
          </div>
        )}
      </div>

      {/* Environment manager modal */}
      {showEnvManager && (
        <EnvManager
          onClose={() => {
            setShowEnvManager(false);
            api.listEnvs().then(setEnvs).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
