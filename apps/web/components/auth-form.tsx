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
      <section className="auth-card">
        <Link className="brand" href="/">
          cap
        </Link>
        <p className="eyebrow">
          {signup ? "Create your workspace" : "Welcome back"}
        </p>
        <h1>{signup ? "Start recording." : "Sign in."}</h1>
        {error && (
          <p className="form-error" role="alert">
            {signup
              ? "That account could not be created. The email may already be registered."
              : "Email or password was incorrect."}
          </p>
        )}
        <form method="post" action={`/api/auth/${mode}`} className="auth-form">
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
          <button type="submit">{signup ? "Create account" : "Sign in"}</button>
        </form>
        <p className="auth-switch">
          {signup ? "Already have an account?" : "New to Cap?"}{" "}
          <Link href={signup ? "/login" : "/signup"}>
            {signup ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </section>
    </main>
  );
}
