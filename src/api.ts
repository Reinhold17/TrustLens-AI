import type { Assessment, Evidence, Finding, InputPoint, ManualTestRecord } from "./data";

export interface WorkspaceUser {
  id: number;
  name: string;
  username: string;
  role: "Administrator" | "Analyst" | "Reviewer";
}

export interface ReportRecord {
  id: string;
  assessment: string;
  assessmentName: string;
  submittedBy: string;
  submittedAt: string;
}

export interface ActivityRecord {
  id: number;
  actor: string;
  action: string;
  subject: string;
  createdAt: string;
}

export interface AIAnalysisResult {
  observed_facts: string[];
  possible_interpretation: string;
  confidence_uncertainty: string;
  potential_impact: string;
  recommended_remediation: string;
  safe_verification_steps: string[];
  missing_evidence: string[];
  disclaimer: string;
}

export interface TeamRecord {
  name: string;
  initials: string;
  role: string;
  username: string;
}

export interface WorkspaceData {
  assessments: Assessment[];
  inputs: InputPoint[];
  manualTests: ManualTestRecord[];
  findings: Finding[];
  evidence: Evidence[];
  reports: ReportRecord[];
  team: TeamRecord[];
  activity: ActivityRecord[];
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | undefined;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");

  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (!csrfToken) {
      const csrfResponse = await fetch("/api/csrf/");
      if (!csrfResponse.ok) throw new ApiError("Could not initialize secure sign-in. Start the backend and try again.", csrfResponse.status);
      const csrf = await csrfResponse.json() as { csrfToken: string };
      csrfToken = csrf.csrfToken;
    }
    headers.set("X-CSRFToken", csrfToken);
  }

  const response = await fetch(path, { ...options, method, headers, credentials: "same-origin" });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const problem = await response.json() as { error?: string };
      if (problem.error) message = problem.error;
    } catch {
      throw new ApiError(message, response.status);
    }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

export async function getSession(): Promise<WorkspaceUser | null> {
  try {
    const result = await request<{ authenticated: boolean; user?: WorkspaceUser }>("/api/session/");
    return result.authenticated ? result.user ?? null : null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function signIn(username: string, password: string): Promise<WorkspaceUser> {
  const result = await request<{ user: WorkspaceUser }>("/api/login/", { method: "POST", body: JSON.stringify({ username, password }) });
  csrfToken = undefined;
  return result.user;
}

export async function signUp(username: string, password: string, confirmPassword: string): Promise<WorkspaceUser> {
  const result = await request<{ user: WorkspaceUser }>("/api/register/", { method: "POST", body: JSON.stringify({ username, password, confirmPassword }) });
  csrfToken = undefined;
  return result.user;
}

export async function signOut(): Promise<void> {
  await request<{ ok: boolean }>("/api/logout/", { method: "POST", body: "{}" });
  csrfToken = undefined;
}

export async function loadWorkspace(): Promise<WorkspaceData> {
  return request<WorkspaceData>("/api/bootstrap/");
}

export async function createAssessment(data: object): Promise<void> {
  await request("/api/assessments/", { method: "POST", body: JSON.stringify(data) });
}

export async function updateAssessment(id: string, data: object): Promise<void> {
  await request(`/api/assessments/${id}/`, { method: "PUT", body: JSON.stringify(data) });
}

export async function archiveAssessment(id: string, archived: boolean): Promise<void> {
  await request(`/api/assessments/${id}/archive/`, { method: "POST", body: JSON.stringify({ archived }) });
}

export async function createInput(data: object): Promise<void> {
  await request("/api/inputs/", { method: "POST", body: JSON.stringify(data) });
}

export async function updateInput(id: string, data: object): Promise<void> {
  await request(`/api/inputs/${id}/`, { method: "PUT", body: JSON.stringify(data) });
}

export async function createManualTest(data: object): Promise<void> {
  await request("/api/manual-tests/", { method: "POST", body: JSON.stringify(data) });
}

export async function getAIStatus(): Promise<{ connected: boolean }> {
  return request<{ connected: boolean }>("/api/ai-analysis/");
}

export async function analyzeFinding(findingId: string, confirmSanitized: boolean): Promise<{ mode: "ai" | "simulated"; analysis: AIAnalysisResult | null }> {
  return request<{ mode: "ai" | "simulated"; analysis: AIAnalysisResult | null }>("/api/ai-analysis/", {
    method: "POST",
    body: JSON.stringify({ findingId, confirmSanitized }),
  });
}

export async function createFinding(data: object): Promise<void> {
  await request("/api/findings/", { method: "POST", body: JSON.stringify(data) });
}

export async function reviewFinding(id: string, validation: "Confirmed" | "False Positive"): Promise<void> {
  await request(`/api/findings/${id}/review/`, { method: "POST", body: JSON.stringify({ validation }) });
}

export async function createEvidence(data: object): Promise<void> {
  await request("/api/evidence/", { method: "POST", body: JSON.stringify(data) });
}

export async function submitReport(assessment: string): Promise<ReportRecord> {
  const result = await request<{ report: ReportRecord }>("/api/reports/submit/", { method: "POST", body: JSON.stringify({ assessment }) });
  return result.report;
}

export async function downloadReport(id: string, assessmentId: string): Promise<void> {
  const response = await fetch(`/api/reports/${id}/pdf/`, { credentials: "same-origin" });
  if (!response.ok) {
    let message = `Report download failed (${response.status}).`;
    try {
      const problem = await response.json() as { error?: string };
      if (problem.error) message = problem.error;
    } catch {
      throw new ApiError(message, response.status);
    }
    throw new ApiError(message, response.status);
  }
  const pdf = await response.blob();
  const url = URL.createObjectURL(pdf);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `TrustLens-report-${assessmentId}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
