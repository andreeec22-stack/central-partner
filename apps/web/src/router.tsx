import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, useLocation, useParams } from 'react-router';
import { AppShell } from './components/layout/AppShell';
import { Spinner } from './components/ui/Feedback';
import { AcceptInvitePage, ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage } from './pages/AuthPages';
import NotFoundPage from './pages/NotFoundPage';
import { useAuth } from './stores/auth';

// Code-split per page; the shell and auth screens stay in the main bundle.
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const TasksPage = lazy(() => import('./pages/TasksPage'));
const BrandingPage = lazy(() => import('./pages/admin/BrandingPage'));
const DataImportPage = lazy(() => import('./pages/admin/DataImportPage'));

function FullScreenSpinner() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <Spinner />
    </div>
  );
}

function RequireAuth() {
  const status = useAuth((s) => s.status);
  const location = useLocation();
  if (status === 'loading') return <FullScreenSpinner />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

// Admin screens: other roles land on the dashboard (the API enforces it anyway).
function RequireAdmin() {
  const role = useAuth((s) => s.user?.role);
  return role === 'ADMIN' ? <Outlet /> : <Navigate to="/" replace />;
}

// Sign-in screens bounce signed-in users to the app.
function GuestOnly() {
  const status = useAuth((s) => s.status);
  if (status === 'loading') return <FullScreenSpinner />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <Outlet />;
}

// Links in notifications and WhatsApp messages: /task/:id opens the task panel.
function TaskLink() {
  const { taskId } = useParams();
  return <Navigate to={`/tasks?week=all&task=${encodeURIComponent(taskId ?? '')}`} replace />;
}

const page = (el: ReactNode) => <Suspense fallback={<Spinner className="py-10" />}>{el}</Suspense>;

export const router = createBrowserRouter([
  {
    element: <GuestOnly />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
    ],
  },
  // Reachable signed in or out (links arrive by email).
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/accept-invite', element: <AcceptInvitePage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: '/', element: page(<DashboardPage />) },
          { path: '/tasks', element: page(<TasksPage />) },
          { path: '/task/:taskId', element: <TaskLink /> },
          {
            element: <RequireAdmin />,
            children: [
              { path: '/admin/import', element: page(<DataImportPage />) },
              { path: '/admin/branding', element: page(<BrandingPage />) },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
