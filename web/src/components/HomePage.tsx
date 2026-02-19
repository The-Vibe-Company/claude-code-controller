import { useState, useRef, useEffect, useCallback } from "react";
import { useStore } from "../store.js";
import { api, createSessionStream, type CompanionEnv, type GitRepoInfo, type GitBranchInfo, type BackendInfo, type ImagePullState } from "../api.js";
import { connectSession, waitForConnection, sendToSession } from "../ws.js";
import { disconnectSession } from "../ws.js";
import { generateUniqueSessionName } from "../utils/names.js";
import { getRecentDirs, addRecentDir } from "../utils/recent-dirs.js";
import { navigateToSession } from "../utils/routing.js";
import { getModelsForBackend, getModesForBackend, getDefaultModel, getDefaultMode, toModelOptions, type ModelOption } from "../utils/backends.js";
import type { BackendType } from "../types.js";
import { EnvManager } from "./EnvManager.js";
import { FolderPicker } from "./FolderPicker.js";

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

let idCounter = 0;

export function HomePage() {
  const [text, setText] = useState("");
  const [backend, setBackend] = useState<BackendType>(() =>
    (localStorage.getItem("cc-backend") as BackendType) || "claude",
  );
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [model, setModel] = useState(() => getDefaultModel(
    (localStorage.getItem("cc-backend") as BackendType) || "claude",
  ));
  const [mode, setMode] = useState(() => getDefaultMode(
    (localStorage.getItem("cc-backend") as BackendType) || "claude",
  ));
  const [cwd, setCwd] = useState(() => getRecentDirs()[0] || "");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [dynamicModels, setDynamicModels] = useState<ModelOption[] | null>(null);
  const [codexInternetAccess, setCodexInternetAccess] = useState(() =>
    localStorage.getItem("cc-codex-internet-access") === "1",
  );

  const MODELS = dynamicModels || getModelsForBackend(backend);
  const MODES = getModesForBackend(backend);

  // Environment state
  const [envs, setEnvs] = useState<CompanionEnv[]>([]);
  const [selectedEnv, setSelectedEnv] = useState(() => localStorage.getItem("cc-selected-env") || "");
  const [showEnvDropdown, setShowEnvDropdown] = useState(false);
  const [showEnvManager, setShowEnvManager] = useState(false);

  // Docker image readiness for selected env
  const [envImageState, setEnvImageState] = useState<ImagePullState | null>(null);
  const envImagePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dropdown states
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  // Git branch state
  const [gitRepoInfo, setGitRepoInfo] = useState<GitRepoInfo | null>(null);
  const [useWorktree, setUseWorktree] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState("");
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);
  const [branchFilter, setBranchFilter] = useState("");
  const [isNewBranch, setIsNewBranch] = useState(false);

  // Branch freshness check state
  const [pullPrompt, setPullPrompt] = useState<{ behind: number; branchName: string } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const envDropdownRef = useRef<HTMLDivElement>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const currentSessionId = useStore((s) => s.currentSessionId);

  // Auto-focus textarea (desktop only — on mobile it triggers the keyboard immediately)
  useEffect(() => {
    const isDesktop = window.matchMedia("(min-width: 640px)").matches;
    if (isDesktop) {
      textareaRef.current?.focus();
    }
  }, []);

  // Load server home/cwd and available backends on mount
  useEffect(() => {
    api.getHome().then(({ home, cwd: serverCwd }) => {
      if (!cwd) {
        setCwd(serverCwd || home);
      }
    }).catch(() => {});
    api.listEnvs().then(setEnvs).catch(() => {});
    api.getBackends().then(setBackends).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When backend changes, reset model and mode to defaults
  function switchBackend(newBackend: BackendType) {
    setBackend(newBackend);
    localStorage.setItem("cc-backend", newBackend);
    setDynamicModels(null);
    setModel(getDefaultModel(newBackend));
    setMode(getDefaultMode(newBackend));
  }

  // Fetch dynamic models for the selected backend
  useEffect(() => {
    if (backend !== "codex") {
      setDynamicModels(null);
      return;
    }
    api.getBackendModels(backend).then((models) => {
      if (models.length > 0) {
        const options = toModelOptions(models);
        setDynamicModels(options);
        // If current model isn't in the list, switch to first
        if (!options.some((m) => m.value === model)) {
          setModel(options[0].value);
        }
      }
    }).catch(() => {
      // Fall back to hardcoded models silently
    });
  }, [backend]); // eslint-disable-line react-hooks/exhaustive-deps

  // When selectedEnv changes, check its Docker image status and auto-pull if needed
  useEffect(() => {
    // Cleanup any existing poll
    if (envImagePollRef.current) {
      clearInterval(envImagePollRef.current);
      envImagePollRef.current = null;
    }
    setEnvImageState(null);

    if (!selectedEnv) return;
    const env = envs.find((e) => e.slug === selectedEnv);
    if (!env) return;
    const effectiveImage = env.imageTag || env.baseImage;
    if (!effectiveImage) return;

    // Check image status
    const checkAndPull = () => {
      api.getImageStatus(effectiveImage).then((state) => {
        setEnvImageState(state);
        // Auto-trigger pull if image is not available
        if (state.status === "idle") {
          api.pullImage(effectiveImage).catch(() => {});
        }
        // Stop polling once settled
        if (state.status === "ready" || state.status === "error") {
          if (envImagePollRef.current) {
            clearInterval(envImagePollRef.current);
            envImagePollRef.current = null;
          }
        }
      }).catch(() => {});
    };

    checkAndPull();
    // Poll while pulling
    envImagePollRef.current = setInterval(checkAndPull, 2000);

    return () => {
      if (envImagePollRef.current) {
        clearInterval(envImagePollRef.current);
        envImagePollRef.current = null;
      }
    };
  }, [selectedEnv, envs]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setShowModelDropdown(false);
      }
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(e.target as Node)) {
        setShowModeDropdown(false);
      }
      if (envDropdownRef.current && !envDropdownRef.current.contains(e.target as Node)) {
        setShowEnvDropdown(false);
      }
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(e.target as Node)) {
        setShowBranchDropdown(false);
      }
    }
    document.addEventListener("pointerdown", handleClick);
    return () => document.removeEventListener("pointerdown", handleClick);
  }, []);

  // Detect git repo when cwd changes
  useEffect(() => {
    if (!cwd) {
      setGitRepoInfo(null);
      return;
    }
    api.getRepoInfo(cwd).then((info) => {
      setGitRepoInfo(info);
      setSelectedBranch(info.currentBranch);
      setIsNewBranch(false);
      api.listBranches(info.repoRoot).then(setBranches).catch(() => setBranches([]));
    }).catch(() => {
      setGitRepoInfo(null);
    });
  }, [cwd]);

  // Fetch branches when git repo changes
  useEffect(() => {
    if (gitRepoInfo) {
      api.listBranches(gitRepoInfo.repoRoot).then(setBranches).catch(() => setBranches([]));
    }
  }, [gitRepoInfo]);


  const selectedModel = MODELS.find((m) => m.value === model) || MODELS[0];
  const selectedMode = MODES.find((m) => m.value === mode) || MODES[0];
  const logoSrc = backend === "codex" ? "/logo-codex.svg" : "/logo.svg";
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
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      const currentModes = getModesForBackend(backend);
      const currentIndex = currentModes.findIndex((m) => m.value === mode);
      const nextIndex = (currentIndex + 1) % currentModes.length;
      setMode(currentModes[nextIndex].value);
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
    setPullError("");

    // Branch freshness check: warn if behind remote
    // Only offer pull when the effective branch is the currently checked-out branch,
    // since git pull operates on the checked-out branch
    if (gitRepoInfo) {
      const effectiveBranch = selectedBranch || gitRepoInfo.currentBranch;
      if (effectiveBranch && effectiveBranch === gitRepoInfo.currentBranch) {
        const branchInfo = branches.find(b => b.name === effectiveBranch && !b.isRemote);
        if (branchInfo && branchInfo.behind > 0) {
          setPullPrompt({ behind: branchInfo.behind, branchName: effectiveBranch });
          return; // Pause — user must choose pull/skip/cancel
        }
      }
    }

    await doCreateSession(msg);
  }

  async function doCreateSession(msg: string) {
    if (!msg) {
      setSending(false);
      return;
    }

    const store = useStore.getState();
    store.clearCreation();
    store.setSessionCreating(true, backend as "claude" | "codex");

    try {
      // Disconnect current session if any
      if (currentSessionId) {
        disconnectSession(currentSessionId);
      }

      // Create session with progress streaming
      const branchName = selectedBranch.trim() || undefined;
      const result = await createSessionStream(
        {
          model,
          permissionMode: mode,
          cwd: cwd || undefined,
          envSlug: selectedEnv || undefined,
          branch: branchName,
          createBranch: branchName && isNewBranch ? true : undefined,
          useWorktree: useWorktree || undefined,
          backend,
          codexInternetAccess: backend === "codex" ? codexInternetAccess : undefined,
        },
        (progress) => {
          useStore.getState().addCreationProgress(progress);
        },
      );
      const sessionId = result.sessionId;

      // Assign a random session name
      const existingNames = new Set(useStore.getState().sessionNames.values());
      const sessionName = generateUniqueSessionName(existingNames);
      useStore.getState().setSessionName(sessionId, sessionName);

      // Save cwd to recent dirs
      if (cwd) addRecentDir(cwd);

      // Store the permission mode for this session
      useStore.getState().setPreviousPermissionMode(sessionId, mode);

      // Switch to session — use replace to avoid a back-button entry for the creation state
      navigateToSession(sessionId, true);
      // connectSession called eagerly so waitForConnection below can resolve immediately;
      // the App.tsx hash-sync effect also calls it, but that runs after render (too late).
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

      // Clear progress on success
      useStore.getState().clearCreation();
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setError(errMsg);
      // Set error in store so the overlay can display it; keep sessionCreating
      // true so the overlay stays visible — user dismisses via the overlay's cancel button
      useStore.getState().setCreationError(errMsg);
      setSending(false);
    }
  }

  async function handlePullAndContinue() {
    if (!pullPrompt) return;
    setPulling(true);
    setPullError("");

    try {
      const pullCwd = cwd || gitRepoInfo?.repoRoot;
      if (!pullCwd) throw new Error("No working directory");

      const result = await api.gitPull(pullCwd);
      if (!result.success) {
        setPullError(result.output || "Pull failed");
        setPulling(false);
        setSending(false);
        return;
      }

      // Refresh branch data after successful pull
      if (gitRepoInfo) {
        api.listBranches(gitRepoInfo.repoRoot).then(setBranches).catch(() => {});
      }

      setPullPrompt(null);
      setPulling(false);
      await doCreateSession(text.trim());
    } catch (e: unknown) {
      setPullError(e instanceof Error ? e.message : String(e));
      setPulling(false);
    }
  }

  function handleSkipPull() {
    const msg = text.trim();
    setPullPrompt(null);
    setPullError("");
    doCreateSession(msg);
  }

  function handleCancelPull() {
    setPullPrompt(null);
    setPullError("");
    setSending(false);
  }

  const canSend = text.trim().length > 0 && !sending;

  return (
    <div className="flex-1 h-full flex items-start justify-center px-3 sm:px-4 pt-[15vh] sm:pt-[20vh] overflow-y-auto">
      <div className="w-full max-w-2xl">
        {/* Logo + Title */}
        <div className="flex flex-col items-center justify-center mb-4 sm:mb-6">
          <img src={logoSrc} alt="The Companion" className="w-24 h-24 sm:w-32 sm:h-32 mb-3" />
          <h1 className="text-xl sm:text-2xl font-semibold text-cc-fg">
            The Companion
          </h1>
        </div>

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
            className="w-full px-4 pt-4 pb-2 text-base sm:text-sm bg-transparent resize-none focus:outline-none text-cc-fg font-sans-ui placeholder:text-cc-muted overflow-y-auto"
            style={{ minHeight: "100px", maxHeight: "200px" }}
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
        <div className="flex items-center gap-1 sm:gap-2 mt-2 sm:mt-3 px-1 flex-wrap">
          {/* Backend toggle */}
          {backends.length > 1 && (
            <div className="flex items-center bg-cc-hover/50 rounded-lg p-0.5">
              {backends.map((b) => (
                <button
                  key={b.id}
                  onClick={() => b.available && switchBackend(b.id as BackendType)}
                  disabled={!b.available}
                  title={b.available ? b.name : `${b.name} CLI not found in PATH`}
                  className={`flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors ${
                    !b.available
                      ? "text-cc-muted/40 cursor-not-allowed"
                      : backend === b.id
                        ? "bg-cc-card text-cc-fg font-medium shadow-sm cursor-pointer"
                        : "text-cc-muted hover:text-cc-fg cursor-pointer"
                  }`}
                >
                  {b.name}
                  {!b.available && (
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3 text-cc-error/60">
                      <circle cx="8" cy="8" r="6" />
                      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Codex internet access toggle */}
          {backend === "codex" && (
            <button
              onClick={() => {
                const next = !codexInternetAccess;
                setCodexInternetAccess(next);
                localStorage.setItem("cc-codex-internet-access", next ? "1" : "0");
              }}
              className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${
                codexInternetAccess
                  ? "bg-cc-primary/15 text-cc-primary font-medium"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              title="Allow Codex internet/network access for this session"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-70">
                <path d="M8 2a6 6 0 100 12A6 6 0 008 2zm0 1.5c.8 0 1.55.22 2.2.61-.39.54-.72 1.21-.95 1.98H6.75c-.23-.77-.56-1.44-.95-1.98A4.47 4.47 0 018 3.5zm-3.2 1.3c.3.4.57.86.78 1.37H3.83c.24-.53.57-1.01.97-1.37zm-.97 2.87h2.15c.07.44.12.9.12 1.38 0 .48-.05.94-.12 1.38H3.83A4.56 4.56 0 013.5 9c0-.47.12-.92.33-1.33zm2.03 4.08c.39-.54.72-1.21.95-1.98h2.38c.23.77.56 1.44.95 1.98A4.47 4.47 0 018 12.5c-.8 0-1.55-.22-2.2-.61zm4.34-1.37c.07-.44.12-.9.12-1.38 0-.48-.05-.94-.12-1.38h2.15c.21.41.33.86.33 1.33 0 .47-.12.92-.33 1.33H10.2zm1.37-3.58h-1.75c-.21-.51-.48-.97-.78-1.37.4.36.73.84.97 1.37z" />
              </svg>
              <span>Internet</span>
            </button>
          )}

          {/* Folder selector */}
          <div>
            <button
              onClick={() => setShowFolderPicker(true)}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-cc-muted hover:text-cc-fg rounded-md hover:bg-cc-hover transition-colors cursor-pointer"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-60">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
              </svg>
              <span className="max-w-[120px] sm:max-w-[200px] truncate font-mono-code">{dirLabel}</span>
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {showFolderPicker && (
              <FolderPicker
                initialPath={cwd || ""}
                onSelect={(path) => { setCwd(path); }}
                onClose={() => setShowFolderPicker(false)}
              />
            )}
          </div>

          {/* Branch picker (always visible when cwd is a git repo) */}
          {gitRepoInfo && (
            <div className="relative" ref={branchDropdownRef}>
              <button
                onClick={() => {
                  if (!showBranchDropdown && gitRepoInfo) {
                    api.gitFetch(gitRepoInfo.repoRoot)
                      .catch(() => {})
                      .finally(() => {
                        api.listBranches(gitRepoInfo.repoRoot).then(setBranches).catch(() => setBranches([]));
                      });
                  }
                  setShowBranchDropdown(!showBranchDropdown);
                  setBranchFilter("");
                }}
                className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-60">
                  <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.378A2.5 2.5 0 007.5 8h1a1 1 0 010 2h-1A2.5 2.5 0 005 12.5v.128a2.25 2.25 0 101.5 0V12.5a1 1 0 011-1h1a2.5 2.5 0 000-5h-1a1 1 0 01-1-1V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5z" />
                </svg>
                <span className="max-w-[100px] sm:max-w-[160px] truncate font-mono-code">
                  {selectedBranch || gitRepoInfo.currentBranch}
                </span>
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
              {showBranchDropdown && (
                <div className="absolute left-0 bottom-full mb-1 w-72 max-w-[calc(100vw-2rem)] bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 overflow-hidden">
                  {/* Search/filter input */}
                  <div className="px-2 py-2 border-b border-cc-border">
                    <input
                      type="text"
                      value={branchFilter}
                      onChange={(e) => setBranchFilter(e.target.value)}
                      placeholder="Filter or create branch..."
                      className="w-full px-2 py-1 text-base sm:text-xs bg-cc-input-bg border border-cc-border rounded-md text-cc-fg font-mono-code placeholder:text-cc-muted focus:outline-none focus:border-cc-primary/50"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setShowBranchDropdown(false);
                        }
                      }}
                    />
                  </div>
                  {/* Branch list */}
                  <div className="max-h-[240px] overflow-y-auto py-1">
                    {(() => {
                      const filter = branchFilter.toLowerCase().trim();
                      const localBranches = branches.filter((b) => !b.isRemote && (!filter || b.name.toLowerCase().includes(filter)));
                      const remoteBranches = branches.filter((b) => b.isRemote && (!filter || b.name.toLowerCase().includes(filter)));
                      const exactMatch = branches.some((b) => b.name.toLowerCase() === filter);
                      const hasResults = localBranches.length > 0 || remoteBranches.length > 0;

                      return (
                        <>
                          {/* Local branches */}
                          {localBranches.length > 0 && (
                            <>
                              <div className="px-3 py-1 text-[10px] text-cc-muted uppercase tracking-wider">Local</div>
                              {localBranches.map((b) => (
                                <button
                                  key={b.name}
                                  onClick={() => {
                                    setSelectedBranch(b.name);
                                    setIsNewBranch(false);
                                    setShowBranchDropdown(false);
                                  }}
                                  className={`w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                                    b.name === selectedBranch ? "text-cc-primary font-medium" : "text-cc-fg"
                                  }`}
                                >
                                  <span className="truncate font-mono-code">{b.name}</span>
                                  <span className="ml-auto flex items-center gap-1.5 shrink-0">
                                    {b.ahead > 0 && (
                                      <span className="text-[9px] text-green-500">{b.ahead}&#8593;</span>
                                    )}
                                    {b.behind > 0 && (
                                      <span className="text-[9px] text-amber-500">{b.behind}&#8595;</span>
                                    )}
                                    {b.worktreePath && (
                                      <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-600 dark:text-blue-400">wt</span>
                                    )}
                                    {b.isCurrent && (
                                      <span className="text-[9px] px-1 py-0.5 rounded bg-green-500/15 text-green-600 dark:text-green-400">current</span>
                                    )}
                                  </span>
                                </button>
                              ))}
                            </>
                          )}
                          {/* Remote branches */}
                          {remoteBranches.length > 0 && (
                            <>
                              <div className="px-3 py-1 text-[10px] text-cc-muted uppercase tracking-wider mt-1">Remote</div>
                              {remoteBranches.map((b) => (
                                <button
                                  key={`remote-${b.name}`}
                                  onClick={() => {
                                    setSelectedBranch(b.name);
                                    setIsNewBranch(false);
                                    setShowBranchDropdown(false);
                                  }}
                                  className={`w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 ${
                                    b.name === selectedBranch ? "text-cc-primary font-medium" : "text-cc-fg"
                                  }`}
                                >
                                  <span className="truncate font-mono-code">{b.name}</span>
                                  <span className="text-[9px] px-1 py-0.5 rounded bg-cc-hover text-cc-muted ml-auto shrink-0">remote</span>
                                </button>
                              ))}
                            </>
                          )}
                          {/* No results */}
                          {!hasResults && filter && (
                            <div className="px-3 py-2 text-xs text-cc-muted text-center">No matching branches</div>
                          )}
                          {/* Create new branch option */}
                          {filter && !exactMatch && (
                            <div className="border-t border-cc-border mt-1 pt-1">
                              <button
                                onClick={() => {
                                  setSelectedBranch(branchFilter.trim());
                                  setIsNewBranch(true);
                                  setShowBranchDropdown(false);
                                }}
                                className="w-full px-3 py-1.5 text-xs text-left hover:bg-cc-hover transition-colors cursor-pointer flex items-center gap-2 text-cc-primary"
                              >
                                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 shrink-0">
                                  <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
                                </svg>
                                <span>Create <span className="font-mono-code font-medium">{branchFilter.trim()}</span></span>
                              </button>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Worktree toggle (only when cwd is a git repo) */}
          {gitRepoInfo && (
            <button
              onClick={() => setUseWorktree(!useWorktree)}
              className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors cursor-pointer ${
                useWorktree
                  ? "bg-cc-primary/15 text-cc-primary font-medium"
                  : "text-cc-muted hover:text-cc-fg hover:bg-cc-hover"
              }`}
              title="Create an isolated worktree for this session"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 opacity-70">
                <path d="M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v5.256a2.25 2.25 0 101.5 0V5.372zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zm7.5-9.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V7A2.5 2.5 0 0110 9.5H6a1 1 0 000 2h4a2.5 2.5 0 012.5 2.5v.628a2.25 2.25 0 11-1.5 0V14a1 1 0 00-1-1H6a2.5 2.5 0 01-2.5-2.5V10a2.5 2.5 0 012.5-2.5h4a1 1 0 001-1V5.372a2.25 2.25 0 01-1.5-2.122z" />
              </svg>
              <span>Worktree</span>
            </button>
          )}

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
              {/* Image readiness dot */}
              {selectedEnv && envImageState && envImageState.status !== "idle" && (
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    envImageState.status === "ready"
                      ? "bg-green-500"
                      : envImageState.status === "pulling"
                        ? "bg-amber-500 animate-pulse"
                        : "bg-cc-error"
                  }`}
                  title={
                    envImageState.status === "ready"
                      ? "Docker image ready"
                      : envImageState.status === "pulling"
                        ? "Pulling Docker image..."
                        : `Image error: ${envImageState.error || "unknown"}`
                  }
                />
              )}
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-50">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>
            {showEnvDropdown && (
              <div className="absolute left-0 bottom-full mb-1 w-56 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1 overflow-hidden">
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
              <div className="absolute left-0 bottom-full mb-1 w-48 bg-cc-card border border-cc-border rounded-[10px] shadow-lg z-10 py-1">
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

        {/* Branch behind remote warning */}
        {pullPrompt && (
          <div className="mt-3 p-3 rounded-[10px] bg-amber-500/10 border border-amber-500/20">
            <div className="flex items-start gap-2.5">
              <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 text-amber-500 shrink-0 mt-0.5">
                <path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-cc-fg leading-snug">
                  <span className="font-mono-code font-medium">{pullPrompt.branchName}</span> is{" "}
                  <span className="font-semibold text-amber-500">{pullPrompt.behind} commit{pullPrompt.behind !== 1 ? "s" : ""} behind</span>{" "}
                  remote. Pull before starting?
                </p>
                {pullError && (
                  <div className="mt-2 px-2 py-1.5 rounded-md bg-cc-error/10 border border-cc-error/20 text-[11px] text-cc-error font-mono-code whitespace-pre-wrap">
                    {pullError}
                  </div>
                )}
                <div className="flex gap-2 mt-2.5">
                  <button
                    onClick={handleCancelPull}
                    disabled={pulling}
                    className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSkipPull}
                    disabled={pulling}
                    className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-hover text-cc-muted hover:text-cc-fg transition-colors cursor-pointer"
                  >
                    Continue anyway
                  </button>
                  <button
                    onClick={handlePullAndContinue}
                    disabled={pulling}
                    className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-cc-primary/15 text-cc-primary hover:bg-cc-primary/25 transition-colors cursor-pointer flex items-center gap-1.5"
                  >
                    {pulling ? (
                      <>
                        <span className="w-3 h-3 border-2 border-cc-primary/30 border-t-cc-primary rounded-full animate-spin" />
                        Pulling...
                      </>
                    ) : (
                      "Pull and continue"
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

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
