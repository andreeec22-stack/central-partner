// Shapes returned by the API (/api/v1). Kept hand-written and minimal: only
// the fields the UI reads.

export type Role = 'ADMIN' | 'JEFE_AREA' | 'USER' | 'VIEWER';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
// Tasks: by date (GREEN done · RED day passed · YELLOW due today · GRAY not yet).
export type Semaphore = 'GREEN' | 'YELLOW' | 'RED' | 'GRAY';

export interface User {
  id: string;
  workspaceId: string;
  email: string;
  displayName: string;
  role: Role;
  canCreateTasks: boolean;
  departmentId: string | null;
  phoneNumber?: string | null;
  timezone: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
}

export interface Department {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  description: string | null;
  headId: string | null;
  head?: { id: string; displayName: string } | null;
  usersCount: number;
}

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  departmentId: string | null;
}

export interface Task {
  id: string;
  workspaceId: string;
  departmentId: string;
  assignedToId: string | null;
  createdById: string;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  progress: number;
  semaphore: Semaphore;
  dueDate: string | null;
  blockReason: string | null;
  blockedSince: string | null;
  kpiTarget: string | null;
  kpiActual: string | null;
  sourceType: 'MANUAL' | 'EXCEL_IMPORT';
  createdAt: string;
  updatedAt: string;
  assignedTo: { id: string; displayName: string } | null;
  createdBy: { id: string; displayName: string };
  department: { id: string; name: string; color: string | null };
  counts: { subTasks: number; comments: number; files: number };
}

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// ─── Weekly dashboard (GET /dashboard/week/:weekId) ─────────────────────────
// Metrics are fractions 0–1 (null = nothing to measure yet).

export type AreaSemaphore = Exclude<Semaphore, 'GRAY'>;

export interface WeekSummary {
  id: string;
  mondayDate: string;
  saturdayDate: string;
  weekNumber: number;
  year: number;
  status: 'ACTIVE' | 'ARCHIVED';
}

export interface AreaTaskCounts {
  total: number;
  due: number;
  done: number;
  overdue: number;
  blocked: number;
}

export interface DashboardArea {
  id: string;
  name: string;
  color: string | null;
  head: { id: string; displayName: string } | null;
  tasks: AreaTaskCounts;
  kpis: { total: number; recorded: number };
  functions: { total: number; marked: number };
  taskProgress: number | null;
  kpiCompliance: number | null;
  functionCompliance: number | null;
  index: number | null;
  semaphore: AreaSemaphore | null;
}

export interface WeekDashboard {
  week: WeekSummary & { archivedAt: string | null };
  today: string;
  cards: {
    index: number | null;
    semaphore: AreaSemaphore | null;
    totalTasks: number;
    doneTasks: number;
    overdueTasks: number;
    blockedTasks: number;
    taskProgress: number | null;
    kpiCompliance: number | null;
    functionCompliance: number | null;
    areasBySemaphore: Record<AreaSemaphore | 'NONE', number>;
  };
  departments: DashboardArea[];
  charts: {
    taskStatus: Record<TaskStatus, number>;
    taskSemaphore: Record<Semaphore, number>;
    criticalKpis: { id: string; title: string; completion: number | null; semaphore: AreaSemaphore | null; department: { id: string; name: string } }[];
  };
  generatedAt: string;
}

// GET /dashboard/week/history — percentages 0–100.
export interface HistoryWeek {
  weekId: string;
  weekNumber: number;
  year: number;
  mondayDate: string;
  saturdayDate: string;
  status: 'ACTIVE' | 'ARCHIVED';
  metrics: {
    indexGeneral: number | null;
    totalTasks: number;
    completedTasks: number;
    delayedTasks: number;
    compliancePercentage: number | null;
    taskProgress: number | null;
    kpiCompliance: number | null;
    functionCompliance: number | null;
    semaphore: AreaSemaphore | null;
  };
  departmentMetrics: {
    departmentId: string;
    departmentName: string;
    tasksTotal: number;
    tasksCompleted: number;
    tasksDelayed: number;
    kpiIndex: number | null;
    semaphore: AreaSemaphore | null;
  }[];
}

export interface AuthPayload {
  user: User;
  workspace: Workspace;
  accessToken: string;
  expiresIn: number;
}

// ─── Task detail (GET /tasks/:id) ───────────────────────────────────────────

export interface MentionRef {
  id: string;
  displayName: string;
  handle: string;
}

export interface Comment {
  id: string;
  taskId: string;
  userId: string;
  content: string;
  mentions: string[];
  mentionedUsers: MentionRef[];
  editedAt: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string; email: string };
}

export interface TaskFile {
  id: string;
  taskId: string;
  uploadedBy: string;
  filename: string;
  originalFilename: string;
  fileUrl: string;
  urlExpiresAt: string;
  fileSize: number;
  mimeType: string;
  uploadedAt: string;
  user: { id: string; name: string };
}

export interface ActivityEntry {
  id: string;
  taskId: string;
  action: string;
  entityType: string;
  userId: string | null;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  metadata: Record<string, unknown> | null;
  timestamp: string;
  user: { id: string; name: string } | null;
}

export interface TaskPermissions {
  canEdit: boolean;
  canComment: boolean;
  canAddFiles: boolean;
  canDelete: boolean;
}

export interface TaskDetail {
  task: Task;
  comments: Comment[];
  files: TaskFile[];
  activity: ActivityEntry[];
  permissions: TaskPermissions;
  subTasks: { id: string; title: string; status: TaskStatus; progress: number; semaphore: Semaphore }[];
  dependencies: { id: string; title: string; status: TaskStatus; semaphore: Semaphore }[];
}

export interface Mentionable extends MentionRef {
  role: Role;
}

// ─── Branding ───────────────────────────────────────────────────────────────

export interface BrandColors {
  primary: string;
  success: string;
  warning: string;
  danger: string;
}

export interface Branding {
  workspaceId: string;
  workspaceName: string;
  tagline: string | null;
  logoUrl: string | null;
  colors: BrandColors;
  updatedAt: string;
}

// ─── Excel import ───────────────────────────────────────────────────────────

export type ImportTaskStatus = 'TODO' | 'IN_PROGRESS' | 'DONE';

export interface DetectedTask {
  rowIndex: number;
  title: string;
  description?: string;
  departmentId?: string;
  departmentName?: string;
  assigneeId?: string;
  assigneeName?: string;
  priority: Priority;
  status: ImportTaskStatus;
  kpiTarget?: string;
  dueDate?: string;
  confidence: number;
}

export interface ImportUploadResult {
  importId: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  detectedTasks: DetectedTask[];
  unmappedRowsCount: number;
  unmappedRows: { rowIndex: number; reason: string }[];
  totalRowsCount: number;
}

export interface ImportSummary {
  id: string;
  filename: string;
  uploadedAt: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  errorMessage: string | null;
  totalRows: number;
  detectedCount: number;
  createdCount: number;
  skippedCount: number;
}

export interface ImportConfirmResult {
  createdCount: number;
  skippedCount: number;
  skippedDetails: { rowIndex: number; reason: string }[];
}
