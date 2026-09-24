import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, getToken, setToken, type AuthUser } from "./api";
import { useStudio } from "./store";
import AuthView from "./views/AuthView";
import DashboardView from "./views/DashboardView";
import BeatsView from "./views/BeatsView";
import BeatDetailView from "./views/BeatDetailView";
import SongsView from "./views/SongsView";
import SongEditorView from "./views/SongEditorView";
import IdeasView from "./views/IdeasView";
import ProfileView from "./views/ProfileView";

export type Route =
  | { name: "dashboard" }
  | { name: "beats" }
  | { name: "beat"; id: string }
  | { name: "songs" }
  | { name: "song"; id: string }
  | { name: "ideas" }
  | { name: "profile" };

function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, "");
  const [head, id] = clean.split("/");
  switch (head) {
    case "beats":
      return id ? { name: "beat", id } : { name: "beats" };
    case "songs":
      return id ? { name: "song", id } : { name: "songs" };
    case "ideas":
      return { name: "ideas" };
    case "profile":
      return { name: "profile" };
    default:
      return { name: "dashboard" };
  }
}

function navigate(path: string): void {
  window.location.hash = path;
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [user, setUser] = useState<AuthUser | null>(null);
  const [checking, setChecking] = useState(true);
  const { toasts, dismissToast, pushToast } = useStudio();

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getToken()) {
        setChecking(false);
        return;
      }
      try {
        const status = await api.authStatus();
        if (!cancelled) setUser(status.authenticated ? status.user : null);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // signing out locally is enough
    }
    setToken(null);
    setUser(null);
    navigate("/");
  }, []);

  // Keyboard shortcuts for the player live in Player.tsx; global ones here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissToast(toasts[0]?.id ?? -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissToast, toasts]);

  const nav = useMemo(
    () => [
      { label: "Dashboard", path: "/", active: route.name === "dashboard" },
      { label: "Beats", path: "/beats", active: route.name === "beats" || route.name === "beat" },
      { label: "Songs", path: "/songs", active: route.name === "songs" || route.name === "song" },
      { label: "Ideas", path: "/ideas", active: route.name === "ideas" },
      { label: "Artist", path: "/profile", active: route.name === "profile" },
    ],
    [route.name],
  );

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-sm text-studio-400">Opening your studio…</div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <AuthView
          onAuthenticated={(nextUser, token) => {
            setToken(token);
            setUser(nextUser);
            navigate("/");
          }}
        />
        <Toasts toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1600px] gap-6 px-4 py-4 lg:px-6">
      <aside className="hidden w-52 shrink-0 flex-col gap-2 lg:flex">
        <div className="mb-2">
          <div className="text-lg font-semibold tracking-tight">Songwriting Studio</div>
          <div className="text-xs text-studio-400">{user.email}</div>
        </div>
        <nav className="flex flex-col gap-1">
          {nav.map((item) => (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={`rounded-lg px-3 py-2 text-left text-sm transition ${
                item.active ? "bg-accent/20 text-accent-soft" : "text-studio-200 hover:bg-studio-800"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-1 border-t border-studio-700 pt-3">
          <button className="btn-ghost btn-xs justify-start" onClick={() => navigate("/profile")}>
            Writing preferences
          </button>
          <button className="btn-ghost btn-xs justify-start" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 pb-16 lg:pb-4">
        <div className="mb-3 flex items-center justify-between gap-3 lg:hidden">
          <div className="text-base font-semibold">Songwriting Studio</div>
          <div className="flex gap-1">
            {nav.map((item) => (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={`rounded-md px-2 py-1 text-xs ${item.active ? "bg-accent/20 text-accent-soft" : "text-studio-300"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <RouteView route={route} onNavigate={navigate} onError={(message) => pushToast("error", message)} notify={(message, kind) => pushToast(kind ?? "success", message)} />
      </main>

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function RouteView({
  route,
  onNavigate,
  onError,
  notify,
}: {
  route: Route;
  onNavigate: (path: string) => void;
  onError: (message: string) => void;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
}) {
  switch (route.name) {
    case "beats":
      return <BeatsView onNavigate={onNavigate} onError={onError} notify={notify} />;
    case "beat":
      return <BeatDetailView beatId={route.id} onNavigate={onNavigate} onError={onError} notify={notify} />;
    case "songs":
      return <SongsView onNavigate={onNavigate} onError={onError} notify={notify} />;
    case "song":
      return <SongEditorView songId={route.id} onNavigate={onNavigate} onError={onError} notify={notify} />;
    case "ideas":
      return <IdeasView onError={onError} notify={notify} onNavigate={onNavigate} />;
    case "profile":
      return <ProfileView onError={onError} notify={notify} />;
    default:
      return <DashboardView onNavigate={onNavigate} onError={onError} />;
  }
}

function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: { id: number; kind: string; message: string }[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          onClick={() => onDismiss(toast.id)}
          className={`card text-left text-sm ${
            toast.kind === "error"
              ? "border-rose-500/50 text-rose-200"
              : toast.kind === "success"
                ? "border-accent-mint/40 text-accent-mint"
                : ""
          }`}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}

export { ApiError };
