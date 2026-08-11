import { invoke } from "@tauri-apps/api/core";

export type CaptureSource = {
  id: string;
  name: string;
  kind: "MONITOR" | "WINDOW" | "CAMERA" | "MICROPHONE" | "SYSTEM_AUDIO";
};
export type Project = {
  id: string;
  title: string;
  status:
    "RECORDING" | "RECOVERABLE" | "READY" | "UPLOADING" | "UPLOADED" | "FAILED";
  mediaPath: string;
  durationMs: number;
  createdAt: string;
  uploadProgress?: number;
};
export type CaptureOptions = {
  title: string;
  videoSourceId: string;
  microphoneId?: string;
  systemAudio: boolean;
  width: number;
  height: number;
  frameRate: number;
  quality: number;
  cursor: boolean;
  region?: { x: number; y: number; width: number; height: number };
};

export const desktop = {
  capabilities: () =>
    invoke<{
      platform: string;
      permissionGuidance: string[];
      sources: CaptureSource[];
    }>("capture_capabilities"),
  projects: () => invoke<Project[]>("list_projects"),
  start: (options: CaptureOptions) =>
    invoke<Project>("start_recording", { options }),
  pause: () => invoke<void>("pause_recording"),
  resume: () => invoke<void>("resume_recording"),
  stop: () => invoke<Project>("stop_recording"),
  remove: (projectId: string) => invoke<void>("delete_project", { projectId }),
  login: (serverUrl: string, email: string, password: string) =>
    invoke<{ displayName: string }>("login", { serverUrl, email, password }),
  googleLogin: (serverUrl: string) =>
    invoke<{ displayName: string }>("google_login", { serverUrl }),
  logout: () => invoke<void>("logout"),
  upload: (projectId: string) =>
    invoke<Project>("upload_project", { projectId }),
  reveal: (projectId: string) => invoke<void>("reveal_project", { projectId }),
  openExtensionStore: (browser: "chrome" | "edge" | "firefox") =>
    invoke<void>("open_extension_store", { browser }),
};
