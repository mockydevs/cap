import Link from "next/link";

/** The brand lockup: accent tile plus wordmark. One definition, every surface. */
export function WorkspaceMark({ href = "/library" }: { href?: string }) {
  return (
    <Link className="workspace-brand" href={href}>
      <span className="workspace-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m22 8-6 4 6 4V8Z" />
          <rect x="2" y="6" width="14" height="12" />
        </svg>
      </span>
      <span>CAP</span>
    </Link>
  );
}
