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
  reveal: (projectId: string) => invoke<void>("reveal_project", { projectId }),
  installUpdate: () => invoke<void>("install_update"),
};

export type PairInfo = {
  serverUrl: string;
  pairingKind: "client_intake" | "staff_client" | "internal_team";
  clientName?: string | null;
  expiresAt: string;
};
export type NoteTakerLink = {
  code: string;
  mode: "audio" | "video";
  title?: string | null;
};
export type MeetingEvent =
  | {
      kind: "warning";
      reason: "inactivity" | "hard_limit" | "signal";
      stops_in_ms: number;
    }
  | { kind: "stopped"; meeting_id: string; reason: string }
  | { kind: "finalized"; meeting_id: string }
  | { kind: "failed"; message: string; reauthorize: boolean };
export type AudioDevices = {
  microphones: { id: string; name: string }[];
  systemAudioAvailable: boolean;
  platform: "linux" | "windows" | "macos";
};
export type MeetingOptions = {
  title: string;
  mode: "audio" | "video";
  microphoneId?: string | undefined;
  systemAudio: boolean;
  videoSourceId?: string | undefined;
  watchWindow?: string | undefined;
};

export const meeting = {
  pair: (code: string) => invoke<PairInfo>("meeting_pair", { code }),
  device: () => invoke<PairInfo | null>("meeting_device"),
  unpair: () => invoke<void>("meeting_unpair"),
  start: (options: MeetingOptions) =>
    invoke<string>("meeting_start", { options }),
  keep: () => invoke<void>("meeting_signal", { action: "keep" }),
  stop: () => invoke<void>("meeting_signal", { action: "stop" }),
  recording: () => invoke<string | null>("meeting_recording"),
  pendingLink: () => invoke<NoteTakerLink | null>("meeting_pending_link"),
  audioDevices: () => invoke<AudioDevices>("meeting_audio_devices"),
};
