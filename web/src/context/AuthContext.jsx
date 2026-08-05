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

  const logout = () => {
    setToken(null);
    setUser(null);
    setWorkspaces([]);
  };

  return (
    <AuthContext.Provider value={{ user, workspaces, loading, login, register, logout, switchWorkspace }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
