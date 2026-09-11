import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setToken, getStoredToken } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [workspaces, setWorkspaces] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    if (!getStoredToken()) {
      setLoading(false);
      return;
    }
    try {
      const data = await api.get('/auth/me');
      setUser(data.user);
      setWorkspaces(data.workspaces || []);
    } catch {
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  const login = async (email, password) => {
    const data = await api.post('/auth/login', { email, password });
    setToken(data.token);
    setUser(data.user);
    setWorkspaces(data.workspaces || []);
    return data.user;
  };

  // The SSO callback page hands us a token the server already issued (it
  // went through the OAuth handshake server-side, not this client) --
  // there's no credentials exchange here, just adopting that token the same
  // way login()/register() do after theirs.
  const loginWithToken = async (token) => {
    setToken(token);
    const data = await api.get('/auth/me');
    setUser(data.user);
    setWorkspaces(data.workspaces || []);
    return data.user;
  };

  const register = async (payload) => {
    const data = await api.post('/auth/register', payload);
    setToken(data.token);
    setUser(data.user);
    setWorkspaces(data.workspaces || []);
    return data.user;
  };

  const switchWorkspace = async (workspaceId) => {
    const data = await api.post('/auth/switch-workspace', { workspace_id: workspaceId });
    setToken(data.token);
    setUser(data.user);
    setWorkspaces(data.workspaces || []);
    return data.user;
  };

  // Swaps the current session for one authenticated as another user
  // (admin/users.impersonate only, audited server-side) -- same
  // token-swap shape as switchWorkspace above, just onto a different
  // identity rather than a different workspace of the same one.
  const impersonate = async (userId) => {
    const data = await api.post(`/auth/impersonate/${userId}`, {});
    setToken(data.token);
    setUser(data.user);
    return data.user;
  };

  // Restores the real admin/impersonator's own session -- the server reads
  // who that is from the current token's impersonated_by claim, so nothing
  // else needs to be passed.
  const endImpersonation = async () => {
    const data = await api.post('/auth/end-impersonation', {});
    setToken(data.token);
    setUser(data.user);
    setWorkspaces(data.workspaces || []);
    return data.user;
  };

  // Self-service profile edit (name/email/language/location/timezone) --
  // stores the freshly-issued token (name/email are baked into it) and
  // merges the response onto the current user so fields the endpoint
  // doesn't return (e.g. role/team from the membership join) aren't lost.
  const updateProfile = async (payload) => {
    const data = await api.patch('/auth/me', payload);
    setToken(data.token);
    setUser((u) => ({ ...u, ...data.user }));
    return data.user;
  };

  const logout = () => {
    setToken(null);
    setUser(null);
    setWorkspaces([]);
  };

  return (
    <AuthContext.Provider value={{ user, workspaces, loading, login, loginWithToken, register, logout, switchWorkspace, updateProfile, impersonate, endImpersonation }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
