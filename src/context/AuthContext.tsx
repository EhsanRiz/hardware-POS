import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { User } from "../lib/types";
import { cacheGet, cacheRemove, cacheSet } from "../lib/localCache";

interface AuthState {
  user: User | null;
  setUser: (u: User | null) => void;
  logout: () => void;
  /**
   * The PIN this person signed in with, for the rest of their sign-in and
   * no longer. Held in memory only: it is never written to storage, so a
   * reload forgets it and asks again. TillAI carries it to the PIN-checked
   * report RPCs so a manager is not asked for the PIN they typed a minute
   * ago every time the sheet opens; Manage still asks at its own door.
   */
  sessionPin: string | null;
  setSessionPin: (pin: string | null) => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

const SESSION_KEY = "session.user";

export function AuthProvider({ children }: { children: ReactNode }) {
  // Rehydrate the signed-in user from the last session so a page refresh or an
  // offline reload doesn't kick staff back to the PIN screen mid-shift.
  const [user, setUserState] = useState<User | null>(() =>
    cacheGet<User | null>(SESSION_KEY, null)
  );
  const [sessionPin, setSessionPin] = useState<string | null>(null);

  useEffect(() => {
    if (user) cacheSet(SESSION_KEY, user);
    else cacheRemove(SESSION_KEY);
  }, [user]);

  const setUser = (u: User | null) => {
    setUserState(u);
    if (!u) setSessionPin(null);
  };
  const logout = () => {
    setUserState(null);
    setSessionPin(null);
  };

  return (
    <AuthContext.Provider value={{ user, setUser, logout, sessionPin, setSessionPin }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
