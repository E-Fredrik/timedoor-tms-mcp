// Everything that depends on the shape of the Timedoor site lives here,
// so a site change means editing this one file.

export const DEFAULT_BASE_URL = "https://cms.timedooracademy.com";

export const PATHS = {
  teacherLogin: "/tms/login",
  pendingJournalsPage: "/tms/report/pending-daily-journal",
  meetingPage: (studentId: number, sessionId: number, bookId: number, meetingId: number) =>
    `/tms/student/${studentId}/session/${sessionId}/session-history/${bookId}/meeting/${meetingId}`,
} as const;

export const API = {
  // Auth and profile (read from the portal's own code, Nov 2026)
  teacherLogin: "/api/tms/auth/login",
  refreshToken: "/api/auth/refresh-token",
  profile: "/api/tms/profile",
  // Assessments
  projectApprovals: "/api/tms/assestments/project-approvals",
  projectApprovalsCount: "/api/tms/assestments/project-approvals/count",
  projectStatus: (studentId: number, bookId: number, projectId: number) =>
    `/api/v2/tms/student/${studentId}/book/${bookId}/project/${projectId}/status`,
  schedule: "/api/tms/schedule",
  pendingJournals: "/api/tms/report/pending-daily-journal",
  students: "/api/tms/student",
  classes: "/api/tms/class",
  reportReminders: "/api/tms/student-report-reminder",
  meeting: (studentId: number, sessionId: number, bookId: number, meetingId: number) =>
    `/api/tms/student/${studentId}/learning-session/${sessionId}/book/${bookId}/meeting-history/${meetingId}`,
  journal: (studentId: number, sessionId: number, bookId: number, meetingId: number) =>
    `/api/tms/student/${studentId}/learning-session/${sessionId}/book/${bookId}/meeting-history/${meetingId}/journal`,
  attendanceDetail: (attendanceId: number) => `/api/tms/attendance/${attendanceId}`,
  studentReports: (studentId: number, sessionId: number, bookId: number) =>
    `/api/tms/student/${studentId}/learning-session/${sessionId}/book/${bookId}/report`,
} as const;

// The journal form shows a "0 / 200" counter for Teacher Notes.
export const TEACHER_NOTES_MAX = 200;
// My own sanity limit for the free text Project field (the site limit is unknown).
export const PROJECT_MAX = 200;

export const LIST_LIMIT = { min: 1, max: 100, default: 20 } as const;

export const TIMEOUTS = {
  login: 25_000,
  api: 20_000,
  save: 20_000,
} as const;
