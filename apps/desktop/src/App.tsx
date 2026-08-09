import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  desktop,
  type CaptureOptions,
  type CaptureSource,
  type Project,
} from "./api";

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

export function App() {
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [options, setOptions] = useState(defaults);
  const [recording, setRecording] = useState(false);
  const [message, setMessage] = useState("Ready");
  const [serverUrl, setServerUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const recordingRef = useRef(recording);
  const optionsRef = useRef(options);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const refresh = async () => {
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
  };
  useEffect(() => {
    void refresh().catch((error) => setMessage(String(error)));
    const cleanups = [
      listen("recording-started", () => {
        setRecording(true);
        setMessage("Recording");
      }),
      listen("recording-stopped", () => {
        setRecording(false);
        setMessage("Saved locally");
        void refresh();
      }),
      listen<number>("upload-progress", (event) =>
        setProjects((items) =>
          items.map((item) =>
            item.status === "UPLOADING"
              ? { ...item, uploadProgress: event.payload }
              : item,
          ),
        ),
      ),
      listen("shortcut-record", async () => {
        if (recordingRef.current) await desktop.stop();
        else if (optionsRef.current.videoSourceId)
          await desktop.start(optionsRef.current);
      }),
      listen("shortcut-pause", async () => {
        if (recordingRef.current) await desktop.pause();
      }),
    ];
    return () => {
      void Promise.all(cleanups).then((values) =>
        values.forEach((unlisten) => unlisten()),
      );
    };
  }, []);

  const start = async () => {
    await desktop.start(options);
    setRecording(true);
    setMessage("Recording");
  };
  const stop = async () => {
    await desktop.stop();
    setRecording(false);
    await refresh();
  };
  const login = async () => {
    const user = await desktop.login(serverUrl, email, password);
    setPassword("");
    setMessage(`Signed in as ${user.displayName}`);
  };

  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">CAP DESKTOP</span>
          <h1>Record without losing your work.</h1>
        </div>
        <strong>{message}</strong>
      </header>
      <section className="panel controls">
        <label>
          Title
          <input
            value={options.title}
            onChange={(e) => setOptions({ ...options, title: e.target.value })}
          />
        </label>
        <label>
          Display or window
          <select
            value={options.videoSourceId}
            onChange={(e) =>
              setOptions({ ...options, videoSourceId: e.target.value })
            }
          >
            {sources
              .filter((s) => s.kind === "MONITOR" || s.kind === "WINDOW")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Microphone
          <select
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
            {sources
              .filter((s) => s.kind === "MICROPHONE")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Frame rate
          <select
            value={options.frameRate}
            onChange={(e) =>
              setOptions({ ...options, frameRate: Number(e.target.value) })
            }
          >
            <option>30</option>
            <option>60</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={options.systemAudio}
            onChange={(e) =>
              setOptions({ ...options, systemAudio: e.target.checked })
            }
          />{" "}
          System audio
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={options.cursor}
            onChange={(e) =>
              setOptions({ ...options, cursor: e.target.checked })
            }
          />{" "}
          Capture cursor
        </label>
        <div className="actions">
          {recording ? (
            <>
              <button onClick={() => void desktop.pause()}>Pause</button>
              <button onClick={() => void desktop.resume()}>Resume</button>
              <button className="danger" onClick={() => void stop()}>
                Stop
              </button>
            </>
          ) : (
            <button
              className="primary"
              disabled={!options.videoSourceId}
              onClick={() => void start()}
            >
              Start recording
            </button>
          )}
        </div>
        <small>
          Global shortcuts: Ctrl/Cmd+Shift+R starts or stops; Ctrl/Cmd+Shift+P
          pauses or resumes.
        </small>
      </section>
      <section className="panel auth">
        <h2>Cloud connection</h2>
        <input
          aria-label="Server URL"
          placeholder="https://your-cap-domain.com"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
        />
        <input
          aria-label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          aria-label="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button onClick={() => void login()}>Sign in securely</button>
        <button
          onClick={() =>
            void desktop
              .googleLogin(serverUrl)
              .then((user) => setMessage(`Signed in as ${user.displayName}`))
              .catch((error) => setMessage(String(error)))
          }
        >
          Continue with Google
        </button>
      </section>
      <section>
        <h2>Local projects</h2>
        <div className="projects">
          {projects.map((project) => (
            <article key={project.id}>
              <div>
                <strong>{project.title}</strong>
                <p>
                  {project.status} · {(project.durationMs / 1000).toFixed(1)}s
                </p>
              </div>
              <div className="actions">
                <button onClick={() => void desktop.reveal(project.id)}>
                  Show file
                </button>
                {project.status === "READY" ||
                project.status === "RECOVERABLE" ||
                project.status === "FAILED" ? (
                  <button
                    onClick={() =>
                      void desktop.upload(project.id).then(refresh)
                    }
                  >
                    Upload
                  </button>
                ) : null}
                <button
                  className="danger"
                  onClick={() => void desktop.remove(project.id).then(refresh)}
                >
                  Delete
                </button>
              </div>
              {project.uploadProgress !== undefined ? (
                <progress value={project.uploadProgress} max="100" />
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
