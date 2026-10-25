export type Severity = "Critical" | "High" | "Medium" | "Low" | "Informational";
export type Validation = "Confirmed" | "Suspected" | "False Positive";
export type AssessmentStatus = "Planning" | "In Progress" | "Under Review" | "Completed";
export type InputKind = "Form" | "Query Parameter" | "Search Field" | "Header" | "Other";
export type ManualTestCategory = "Required field" | "Whitespace-only input" | "Length limits" | "Format validation" | "Special characters" | "Other";
export type ManualTestResult = "Pass" | "Deviation observed" | "Inconclusive";

export interface ManualTestRecord {
  id: string;
  inputId: string;
  assessment: string;
  category: ManualTestCategory;
  description: string;
  expectedBehavior: string;
  actualBehavior: string;
  evidenceReference: string;
  result: ManualTestResult;
  recordedBy: string;
  recordedAt: string;
}

export interface Assessment {
  id: string;
  name: string;
  organization: string;
  scope: string;
  approval: "Approved" | "Pending" | "Not requested";
  approvedForTesting: boolean;
  start: string;
  end: string;
  status: AssessmentStatus;
  team: string[];
  notes: string;
  progress: number;
  archived?: boolean;
}

export interface InputPoint {
  id: string;
  route: string;
  name: string;
  kind: InputKind;
  status: "Not reviewed" | "In review" | "Reviewed";
  evidence: number;
  notes: string;
  assessment: string;
}

export interface Finding {
  id: string;
  title: string;
  category: string;
  inputId: string;
  severity: Severity;
  confidence: number;
  validation: Validation;
  description: string;
  impact: string;
  evidence: string[];
  remediation: string;
  reviewer: string;
  updated: string;
  assessment: string;
}

export interface Evidence {
  id: string;
  title: string;
  kind: string;
  date: string;
  inputId: string;
  findingId: string;
  redacted: boolean;
  notes: string;
  reproductionSteps: string;
  request: string;
  response: string;
  reference: string;
}

export const severityOrder: Severity[] = ["Critical", "High", "Medium", "Low", "Informational"];
