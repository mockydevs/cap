type IconProps = { className?: string };

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function CapMarkIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="6.5" />
    </svg>
  );
}

export function MonitorIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

export function MicIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 19v3" />
    </svg>
  );
}

export function GaugeIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M4 15a8 8 0 1 1 16 0" />
      <path d="M12 15l3.2-4.2" />
    </svg>
  );
}

export function SpeakerIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M4 9v6h3l5 4V5L7 9H4Z" />
      <path d="M17 8a5 5 0 0 1 0 8" />
    </svg>
  );
}

export function CursorIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M6 3l6.5 15.5 2.2-6.2L21 10.2 6 3Z" />
    </svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 4.5v15l13-7.5-13-7.5Z" />
    </svg>
  );
}

export function PauseIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="5" width="4.5" height="14" rx="1.2" />
      <rect x="13.5" y="5" width="4.5" height="14" rx="1.2" />
    </svg>
  );
}

export function StopIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}

export function UploadIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

export function FolderIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-.8 12.1a2 2 0 0 1-2 1.9H9.8a2 2 0 0 1-2-1.9L7 7" />
    </svg>
  );
}

export function CloudIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M7 17a4 4 0 0 1-.4-8 5 5 0 0 1 9.6-1.5A4.5 4.5 0 0 1 17 17H7Z" />
    </svg>
  );
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function AlertIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}

export function CheckCircleIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.3l2.3 2.3 4.7-5.2" />
    </svg>
  );
}

export function FilmIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M4 9.2l1.4-4.4a1 1 0 0 1 1.25-.65l12.7 3.5a1 1 0 0 1 .68 1.24L19.5 9.2" />
      <rect x="3.5" y="9.2" width="17" height="10.8" rx="2" />
      <path d="M7.7 9.2 6.2 4.6M13 9.2l-1.3-4.5M18.3 9.2 17 4.9" />
    </svg>
  );
}
