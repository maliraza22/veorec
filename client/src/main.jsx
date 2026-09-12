import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import Dashboard from './pages/Dashboard';
import Folders from './pages/Folders';
import AnalyticsPage from './pages/AnalyticsPage';
import Editor from './pages/Editor';
import Landing from './pages/Landing';
import Watch from './pages/Watch';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Forgot from './pages/Forgot';
import Reset from './pages/Reset';
import Privacy from './pages/Privacy';
import Terms from './pages/Terms';
import Refund from './pages/Refund';
import Account from './pages/Account';
import Pricing from './pages/Pricing';
import Billing from './pages/Billing';
import Admin from './pages/Admin';
import Contact from './pages/Contact';
import Embed from './pages/Embed';
import { ToastProvider } from './components/Toast';
import './index.css';

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100vh',color:'#9090a0' }}>Loading…</div>;
  return user ? children : <Navigate to="/login" replace />;
}

function PublicRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  return user ? <Navigate to="/" replace /> : children;
}

// "/" shows the marketing landing for guests, the app dashboard once signed in.
function HomeRoute() {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100vh',color:'#9090a0' }}>Loading…</div>;
  return user ? <Dashboard /> : <Landing />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <AuthProvider>
      <ToastProvider>
      <Routes>
        <Route path="/" element={<HomeRoute />} />
        <Route path="/watch/:id" element={<Watch />} />
        <Route path="/embed/:id" element={<Embed />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/refund" element={<Refund />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/account" element={<PrivateRoute><Account /></PrivateRoute>} />
        <Route path="/folders" element={<PrivateRoute><Folders /></PrivateRoute>} />
        <Route path="/analytics" element={<PrivateRoute><AnalyticsPage /></PrivateRoute>} />
        <Route path="/edit/:id" element={<PrivateRoute><Editor /></PrivateRoute>} />
        <Route path="/billing" element={<PrivateRoute><Billing /></PrivateRoute>} />
        <Route path="/dashboard/billing" element={<PrivateRoute><Billing /></PrivateRoute>} />
        <Route path="/admin" element={<PrivateRoute><Admin /></PrivateRoute>} />
        <Route path="/login"  element={<PublicRoute><Login /></PublicRoute>} />
        <Route path="/signup" element={<PublicRoute><Signup /></PublicRoute>} />
        <Route path="/forgot" element={<PublicRoute><Forgot /></PublicRoute>} />
        <Route path="/reset"  element={<Reset />} />
      </Routes>
      </ToastProvider>
    </AuthProvider>
  </BrowserRouter>
);
