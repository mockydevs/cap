import { useEffect, useRef, useState } from "react";
import { formatDuration } from "@cap/recording";
import { listen, type EventCallback } from "@tauri-apps/api/event";
import {
  desktop,
  type CaptureOptions,
  type CaptureSource,
  type Project,
} from "./api";
import {
  AlertIcon,
  CapMarkIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CloudIcon,
  CursorIcon,
  FilmIcon,
  FolderIcon,
  GaugeIcon,
  MicIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  PuzzleIcon,
  SpeakerIcon,
  StopIcon,
  TrashIcon,
  UploadIcon,
} from "./icons";

const defaults: CaptureOptions = {
  title: "New recording",
  videoSourceId: "",
  systemAudio: true,
  width: 1920,
  height: 1080,
  frameRate: 30,
  quality: 23,
  cursor: true,
};

type Notice = { kind: "error" | "success"; text: string };
type Account = { displayName: string };

/** Short clips read better in seconds; anything longer uses the mm:ss clock. */
function formatClipLength(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return formatDuration(ms);
}

function formatRelative(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/** listen() throws when there's no Tauri host (e.g. previewing the UI in a plain browser); never let that escape uncaught. */
function safeListen<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<() => void> {
  try {
    return listen<T>(event, handler).catch(() => () => {});
  } catch {
    return Promise.resolve(() => {});
  }
}

const statusBadge: Record<
  Project["status"],
  { label: string; className: string }
> = {
  RECORDING: { label: "Recording", className: "badge-recording" },
  RECOVERABLE: { label: "Recoverable", className: "badge-recoverable" },
  READY: { label: "Ready", className: "badge-ready" },
  UPLOADING: { label: "Uploading", className: "badge-uploading" },
  UPLOADED: { label: "Uploaded", className: "badge-uploaded" },
  FAILED: { label: "Failed", className: "badge-failed" },
};

function Switch({
  label,
  icon,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track">
        <span className="switch-thumb" />
      </span>
      {icon}
      {label}
    </label>
  );
}

export function App() {
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [options, setOptions] = useState(defaults);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tauriUnavailable, setTauriUnavailable] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [extensionMenuOpen, setExtensionMenuOpen] = useState(false);
  const recordingRef = useRef(recording);
  const optionsRef = useRef(options);
  const startedAt = useRef(0);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    if (!notice || notice.kind === "error") return;
    const timer = window.setTimeout(() => setNotice(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!recording) return;
    const interval = window.setInterval(
      () => setElapsed(Date.now() - startedAt.current),
      250,
    );
    return () => window.clearInterval(interval);
  }, [recording]);

  const refresh = async () => {
    try {
      const [capabilities, local] = await Promise.all([
        desktop.capabilities(),
        desktop.projects(),
      ]);
      setSources(capabilities.sources);
      setProjects(local);
      setOptions((value) => ({
        ...value,
        videoSourceId:
          value.videoSourceId ||
          capabilities.sources.find((s) => s.kind === "MONITOR")?.id ||
          "",
      }));
    } catch (error) {
      if (error instanceof TypeError) {
        setTauriUnavailable(true);
        return;
      }
      setNotice({ kind: "error", text: String(error) });
    }
  };

  useEffect(() => {
    void refresh();
    const cleanups = [
      safeListen("recording-started", () => {
        startedAt.current = Date.now();
        setElapsed(0);
        setRecording(true);
      }),
      safeListen("recording-stopped", () => {
        setRecording(false);
        void refresh();
      }),
      safeListen<number>("upload-progress", (event) =>
        setProjects((items) =>
          items.map((item) =>
            item.status === "UPLOADING"
              ? { ...item, uploadProgress: event.payload }
              : item,
          ),
        ),
      ),
      safeListen("shortcut-record", async () => {
        if (recordingRef.current) await desktop.stop();
        else if (optionsRef.current.videoSourceId)
          await desktop.start(optionsRef.current);
      }),
      safeListen("shortcut-pause", async () => {
        if (recordingRef.current) await desktop.pause();
      }),
    ];
    return () => {
      void Promise.all(cleanups).then((values) =>
        values.forEach((unlisten) => unlisten()),
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const close = () => setAccountMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!extensionMenuOpen) return;
    const close = () => setExtensionMenuOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [extensionMenuOpen]);

  const installExtension = async (browser: "chrome" | "edge" | "firefox") => {
    setExtensionMenuOpen(false);
    try {
      await desktop.openExtensionStore(browser);
    } catch (error) {
      setNotice({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "Could not open the extension page",
      });
    }
  };

  const start = async () => {
    try {
      await desktop.start(options);
      startedAt.current = Date.now();
      setElapsed(0);
      setRecording(true);
    } catch (error) {
      setNotice({ kind: "error", text: String(error) });
    }
  };
  const stop = async () => {
    try {
      await desktop.stop();
      setRecording(false);
      await refresh();
    } catch (error) {
      setNotice({ kind: "error", text: String(error) });
    }
  };

  const signIn = async () => {
    setSigningIn(true);
    try {
      const user = await desktop.login(serverUrl, email, password);
      setPassword("");
      setAccount(user);
      setNotice({ kind: "success", text: `Signed in as ${user.displayName}` });
    } catch (error) {
      setNotice({ kind: "error", text: String(error) });
    } finally {
      setSigningIn(false);
    }
  };
  const signInWithGoogle = async () => {
    setSigningIn(true);
    try {
      const user = await desktop.googleLogin(serverUrl);
      setAccount(user);
      setNotice({ kind: "success", text: `Signed in as ${user.displayName}` });
    } catch (error) {
      setNotice({ kind: "error", text: String(error) });
    } finally {
      setSigningIn(false);
    }
  };
  const signOut = async () => {
    try {
      await desktop.logout();
    } finally {
      setAccount(null);
      setAccountMenuOpen(false);
      setNotice({ kind: "success", text: "Signed out" });
    }
  };

  const monitorsAndWindows = sources.filter(
    (s) => s.kind === "MONITOR" || s.kind === "WINDOW",
  );
  const microphones = sources.filter((s) => s.kind === "MICROPHONE");

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <CapMarkIcon />
          </span>
          <span className="brand-name">Cap</span>
        </div>
        <div className="topbar-spacer" />
        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={(e) => {
              e.stopPropagation();
              setExtensionMenuOpen((open) => !open);
            }}
          >
            <PuzzleIcon className="icon" />
            Browser extension
            <ChevronDownIcon className="icon" />
          </button>
          {extensionMenuOpen && (
            <div className="account-menu" onClick={(e) => e.stopPropagation()}>
              <div className="account-menu-label">
                Record from your browser toolbar
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void installExtension("chrome")}
              >
                Get it for Chrome
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void installExtension("edge")}
              >
                Get it for Edge
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void installExtension("firefox")}
              >
                Get it for Firefox
              </button>
            </div>
          )}
        </div>
        {account ? (
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="account-chip"
              onClick={(e) => {
                e.stopPropagation();
                setAccountMenuOpen((open) => !open);
              }}
            >
              <span className="avatar">{initialsOf(account.displayName)}</span>
              {account.displayName}
              <ChevronDownIcon className="icon" />
            </button>
            {accountMenuOpen && (
              <div
                className="account-menu"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="account-menu-label">
                  Signed in to {serverUrl || "your workspace"}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void signOut()}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        ) : (
          <span
            className="account-chip"
            aria-hidden
            style={{ cursor: "default" }}
          >
            <span className="status-dot" />
            Not connected
          </span>
        )}
      </div>

      <main className="main">
        {tauriUnavailable && (
          <div className="banner">
            <AlertIcon className="icon" />
            Open this page inside the Cap desktop app to record — recording
            controls need the native app shell.
          </div>
        )}
        {notice && (
          <div className={`banner ${notice.kind}`}>
            {notice.kind === "error" ? (
              <AlertIcon className="icon" />
            ) : (
              <CheckCircleIcon className="icon" />
            )}
            {notice.text}
          </div>
        )}

        <section className="card record-card">
          <div className="record-title-row">
            <FilmIcon className="icon" />
            <input
              className="record-title-input"
              value={options.title}
              disabled={recording}
              onChange={(e) =>
                setOptions({ ...options, title: e.target.value })
              }
              aria-label="Recording title"
            />
            {recording && (
              <div className="timer">
                <span className="rec-dot" />
                {formatDuration(elapsed)}
              </div>
            )}
          </div>

          <div className="field-grid">
            <label className="field">
              <span className="field-label">
                <MonitorIcon className="icon" />
                Display or window
              </span>
              <select
                className="control"
                disabled={recording}
                value={options.videoSourceId}
                onChange={(e) =>
                  setOptions({ ...options, videoSourceId: e.target.value })
                }
              >
                {monitorsAndWindows.length === 0 && (
                  <option value="">No sources found</option>
                )}
                {monitorsAndWindows.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">
                <MicIcon className="icon" />
                Microphone
              </span>
              <select
                className="control"
                disabled={recording}
                value={options.microphoneId ?? ""}
                onChange={(e) =>
                  setOptions(
                    e.target.value
                      ? { ...options, microphoneId: e.target.value }
                      : (Object.fromEntries(
                          Object.entries(options).filter(
                            ([key]) => key !== "microphoneId",
                          ),
                        ) as CaptureOptions),
                  )
                }
              >
                <option value="">None</option>
                {microphones.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">
                <GaugeIcon className="icon" />
                Frame rate
              </span>
              <select
                className="control"
                disabled={recording}
                value={options.frameRate}
                onChange={(e) =>
                  setOptions({ ...options, frameRate: Number(e.target.value) })
                }
              >
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </label>
          </div>

          <div className="switch-row" style={{ marginTop: 16 }}>
            <Switch
              label="System audio"
              icon={<SpeakerIcon className="icon" />}
              checked={options.systemAudio}
              disabled={recording}
              onChange={(checked) =>
                setOptions({ ...options, systemAudio: checked })
              }
            />
            <Switch
              label="Capture cursor"
              icon={<CursorIcon className="icon" />}
              checked={options.cursor}
              disabled={recording}
              onChange={(checked) =>
                setOptions({ ...options, cursor: checked })
              }
            />
          </div>

          <div className="record-footer">
            <div className="shortcut-hint">
              <span className="shortcut-group">
                <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> start/stop
              </span>
              <span className="shortcut-group">
                <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> pause/resume
              </span>
            </div>
            <div className="record-actions">
              {recording ? (
                <>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void desktop.pause()}
                  >
                    <PauseIcon className="icon" />
                    Pause
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void desktop.resume()}
                  >
                    <PlayIcon className="icon" />
                    Resume
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => void stop()}
                  >
                    <StopIcon className="icon" />
                    Stop
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled={!options.videoSourceId || tauriUnavailable}
                  onClick={() => void start()}
                >
                  <PlayIcon className="icon" />
                  Start recording
                </button>
              )}
            </div>
          </div>
        </section>

        {!account && (
          <section className="card">
            <div className="card-header">
              <h2 className="card-title">
                <CloudIcon className="icon" />
                Connect your workspace
              </h2>
              <span className="card-subtitle">Optional — needed to upload</span>
            </div>
            <div className="connection-form">
              <div className="field-grid">
                <label className="field">
                  <span className="field-label">Server URL</span>
                  <input
                    className="control"
                    placeholder="https://your-cap-domain.com"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Email</span>
                  <input
                    className="control"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Password</span>
                  <input
                    className="control"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void signIn();
                    }}
                  />
                </label>
              </div>
              <div className="connection-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={signingIn || !serverUrl || !email || !password}
                  onClick={() => void signIn()}
                >
                  Sign in securely
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={signingIn || !serverUrl}
                  onClick={() => void signInWithGoogle()}
                >
                  Continue with Google
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="card">
          <div className="card-header">
            <h2 className="card-title">
              <FolderIcon className="icon" />
              Local recordings
            </h2>
            {projects.length > 0 && (
              <span className="card-subtitle">
                {projects.length} recording{projects.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {projects.length === 0 ? (
            <div className="empty">
              <FilmIcon className="icon" />
              <span className="empty-title">No recordings yet</span>
              <span className="empty-hint">
                Recordings are saved to this device first, even offline, and
                stay here until you upload or delete them.
              </span>
            </div>
          ) : (
            <div className="recordings">
              {projects.map((project) => {
                const badge = statusBadge[project.status];
                const canUpload =
                  project.status === "READY" ||
                  project.status === "RECOVERABLE" ||
                  project.status === "FAILED";
                return (
                  <div className="recording-row" key={project.id}>
                    <span className="recording-thumb">
                      <FilmIcon className="icon" />
                    </span>
                    <div className="recording-info">
                      <span className="recording-title">{project.title}</span>
                      <span className="recording-meta">
                        <span className={`badge ${badge.className}`}>
                          <span className="status-dot" />
                          {badge.label}
                        </span>
                        <span>{formatClipLength(project.durationMs)}</span>
                        <span>{formatRelative(project.createdAt)}</span>
                      </span>
                      {project.uploadProgress !== undefined && (
                        <span className="recording-progress">
                          <span
                            style={{ width: `${project.uploadProgress}%` }}
                          />
                        </span>
                      )}
                    </div>
                    <div className="recording-actions">
                      <button
                        type="button"
                        className="btn btn-icon btn-ghost"
                        title="Show file"
                        aria-label="Show file"
                        onClick={() => void desktop.reveal(project.id)}
                      >
                        <FolderIcon className="icon" />
                      </button>
                      {canUpload && (
                        <button
                          type="button"
                          className="btn btn-icon btn-ghost"
                          title="Upload"
                          aria-label="Upload"
                          onClick={() =>
                            void desktop.upload(project.id).then(refresh)
                          }
                        >
                          <UploadIcon className="icon" />
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-icon btn-danger"
                        title="Delete"
                        aria-label="Delete"
                        onClick={() =>
                          void desktop.remove(project.id).then(refresh)
                        }
                      >
                        <TrashIcon className="icon" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
