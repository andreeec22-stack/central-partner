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
const DataImportPage = lazy(() => import('./pages/admin/DataImportPage'));
const AdminUsersPage = lazy(() => import('./pages/admin/AdminUsersPage'));
const PermissionsPage = lazy(() => import('./pages/admin/PermissionsPage'));
const DepartmentsPage = lazy(() => import('./pages/admin/DepartmentsPage'));
const WorkspaceSettingsPage = lazy(() => import('./pages/admin/WorkspaceSettingsPage'));
const WeekManagementPage = lazy(() => import('./pages/admin/WeekManagementPage'));
const AuditLogsPage = lazy(() => import('./pages/admin/AuditLogsPage'));
const DocsPage = lazy(() => import('./pages/admin/DocsPage'));
const SurveyTemplatesPage = lazy(() => import('./pages/admin/SurveyTemplatesPage'));
const ReportsPage = lazy(() => import('./pages/admin/ReportsPage'));
const PerformancePage = lazy(() => import('./pages/performance/PerformancePage'));
const SurveyResponsePage = lazy(() => import('./pages/performance/surveys/SurveyResponsePage'));
const ReviewsPage = lazy(() => import('./pages/performance/ReviewsPage'));
const ReviewDetailPage = lazy(() => import('./pages/performance/ReviewDetailPage'));
const ScorecardPage = lazy(() => import('./pages/performance/ScorecardPage'));
const OkrsPage = lazy(() => import('./pages/performance/OkrsPage'));

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

// Performance evaluations: everyone but read-only VIEWERs (the API enforces it too).
function RequireContributor() {
  const role = useAuth((s) => s.user?.role);
  return role && role !== 'VIEWER' ? <Outlet /> : <Navigate to="/" replace />;
}

// The performance dashboard: director and area heads.
function RequireManager() {
  const role = useAuth((s) => s.user?.role);
  return role === 'ADMIN' || role === 'JEFE_AREA' ? <Outlet /> : <Navigate to="/performance" replace />;
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
          { path: '/dashboard', element: <Navigate to="/" replace /> },
          { path: '/tasks', element: page(<TasksPage />) },
          { path: '/task/:taskId', element: <TaskLink /> },
          {
            element: <RequireContributor />,
            children: [
              { path: '/performance', element: page(<PerformancePage />) },
              { path: '/performance/surveys/:surveyId', element: page(<SurveyResponsePage />) },
              { path: '/performance/reviews', element: page(<ReviewsPage />) },
              { path: '/performance/reviews/:reviewId', element: page(<ReviewDetailPage />) },
              { path: '/performance/okrs', element: page(<OkrsPage />) },
              { element: <RequireManager />, children: [{ path: '/performance/dashboard', element: page(<ScorecardPage />) }] },
            ],
          },
          {
            element: <RequireAdmin />,
            children: [
              { path: '/admin/import', element: page(<DataImportPage />) },
              { path: '/admin/settings/users', element: page(<AdminUsersPage />) },
              { path: '/admin/settings/permissions', element: page(<PermissionsPage />) },
              { path: '/admin/settings/departments', element: page(<DepartmentsPage />) },
              { path: '/admin/settings/workspace', element: page(<WorkspaceSettingsPage />) },
              { path: '/admin/weeks', element: page(<WeekManagementPage />) },
              { path: '/admin/audit', element: page(<AuditLogsPage />) },
              { path: '/admin/docs', element: page(<DocsPage />) },
              { path: '/admin/surveys', element: page(<SurveyTemplatesPage />) },
              { path: '/admin/reports', element: page(<ReportsPage />) },
              // Old links.
              { path: '/admin/branding', element: <Navigate to="/admin/settings/workspace" replace /> },
              { path: '/admin', element: <Navigate to="/admin/settings/users" replace /> },
              { path: '/admin/settings', element: <Navigate to="/admin/settings/users" replace /> },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
