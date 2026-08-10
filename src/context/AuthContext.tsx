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
}

const AuthContext = createContext<AuthState | undefined>(undefined);

const SESSION_KEY = "session.user";

export function AuthProvider({ children }: { children: ReactNode }) {
  // Rehydrate the signed-in user from the last session so a page refresh or an
  // offline reload doesn't kick staff back to the PIN screen mid-shift.
  const [user, setUserState] = useState<User | null>(() =>
    cacheGet<User | null>(SESSION_KEY, null)
  );

  useEffect(() => {
    if (user) cacheSet(SESSION_KEY, user);
    else cacheRemove(SESSION_KEY);
  }, [user]);

  const setUser = (u: User | null) => setUserState(u);
  const logout = () => setUserState(null);

  return (
    <AuthContext.Provider value={{ user, setUser, logout }}>
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
