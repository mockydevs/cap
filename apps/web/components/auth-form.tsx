import Link from "next/link";

export function AuthForm({
  mode,
  error,
}: {
  mode: "login" | "signup";
  error: string | undefined;
}) {
  const signup = mode === "signup";
  return (
    <main className="auth-shell">
      <section className={`auth-card ${signup ? "auth-card-signup" : ""}`}>
        <div className="auth-content">
          <Link className="brand" href="/">
            <span className="brand-mark" aria-hidden="true" />
            cap
          </Link>
          <p className="eyebrow">
            {signup ? "Create your workspace" : "Welcome back"}
          </p>
          <h1>{signup ? "Start recording." : "Sign in."}</h1>
          {error && (
            <p className="form-error" role="alert">
              {error === "google"
                ? "Google sign-in could not be completed. Please try again."
                : error === "google-account-exists"
                  ? "An account with that email already exists. Sign in with your password instead."
                  : signup
                    ? "That account could not be created. The email may already be registered."
                    : "Email or password was incorrect."}
            </p>
          )}
          <a className="google-auth" href="/api/auth/google">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4.3h5.4a4.6 4.6 0 0 1-2 3v2.8h3.3c1.9-1.8 2.9-4.4 2.9-7.9Z"
              />
              <path
                fill="#34A853"
                d="M12 22c2.7 0 5-.9 6.7-2.4l-3.3-2.7c-.9.6-2.1 1-3.4 1-2.6 0-4.9-1.8-5.7-4.2H2.9v2.8A10 10 0 0 0 12 22Z"
              />
              <path
                fill="#FBBC05"
                d="M6.3 13.7A6 6 0 0 1 6 12c0-.6.1-1.2.3-1.7V7.5H2.9A10 10 0 0 0 2 12c0 1.6.4 3.1.9 4.5l3.4-2.8Z"
              />
              <path
                fill="#EA4335"
                d="M12 6.1c1.5 0 2.8.5 3.8 1.5l2.9-2.8A9.6 9.6 0 0 0 12 2a10 10 0 0 0-9.1 5.5l3.4 2.8A6 6 0 0 1 12 6.1Z"
              />
            </svg>
            Continue with Google
          </a>
          <div className="auth-divider">
            <span>or use email</span>
          </div>
          <form
            method="post"
            action={`/api/auth/${mode}`}
            className={`auth-form ${signup ? "auth-form-signup" : ""}`}
          >
            {signup && (
              <>
                <label>
                  Display name
                  <input
                    name="displayName"
                    required
                    minLength={2}
                    maxLength={100}
                    autoComplete="name"
                  />
                </label>
                <label>
                  Workspace name
                  <input
                    name="workspaceName"
                    required
                    minLength={2}
                    maxLength={100}
                    autoComplete="organization"
                  />
                </label>
              </>
            )}
            <label>
              Email
              <input
                name="email"
                type="email"
                required
                maxLength={320}
                autoComplete="email"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                required
                minLength={signup ? 12 : 1}
                maxLength={256}
                autoComplete={signup ? "new-password" : "current-password"}
              />
            </label>
            {signup && <small>Use at least 12 characters.</small>}
            <button type="submit">
              {signup ? "Create account" : "Sign in"}
            </button>
          </form>
          <p className="auth-switch">
            {signup ? "Already have an account?" : "New to Cap?"}{" "}
            <Link href={signup ? "/login" : "/signup"}>
              {signup ? "Sign in" : "Create an account"}
            </Link>
          </p>
        </div>
        <aside className="auth-poster" aria-label="About Cap">
          <div className="auth-poster-top" aria-hidden="true">
            <span>Cap for teams</span>
            <span>01</span>
          </div>
          <div className="auth-poster-copy">
            <span>Browser-first screen recording</span>
            <h2>Record the work while it happens.</h2>
            <p>Capture. Explain. Keep everyone moving.</p>
          </div>
        </aside>
      </section>
    </main>
  );
}
