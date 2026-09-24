import { useState } from "react";
import { api, ApiError, type AuthUser } from "../api";

export default function AuthView({
  onAuthenticated,
}: {
  onAuthenticated: (user: AuthUser, token: string) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "login"
          ? await api.login(email.trim(), password)
          : await api.register(email.trim(), password, displayName.trim() || undefined);
      onAuthenticated(result.user, result.token);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Songwriting Studio</h1>
          <p className="mt-1 text-sm text-studio-400">
            Write with the beat. Your songs are private by default.
          </p>
        </div>

        <form onSubmit={submit} className="card flex flex-col gap-3">
          <div className="flex gap-2">
            <button
              type="button"
              className={mode === "login" ? "chip-active btn-xs" : "chip btn-xs"}
              onClick={() => setMode("login")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={mode === "register" ? "chip-active btn-xs" : "chip btn-xs"}
              onClick={() => setMode("register")}
            >
              Create account
            </button>
          </div>

          {mode === "register" && (
            <div>
              <label className="label" htmlFor="displayName">
                Artist name
              </label>
              <input
                id="displayName"
                className="input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="How your studio should address you"
                autoComplete="nickname"
              />
            </div>
          )}

          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="input"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
            />
          </div>

          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="input"
              type="password"
              required
              minLength={mode === "register" ? 8 : undefined}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
            {mode === "register" && <p className="mt-1 text-xs text-studio-400">At least 8 characters.</p>}
          </div>

          {error && <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-2 text-sm text-rose-200">{error}</div>}

          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
          </button>
        </form>
      </div>
    </div>
  );
}
