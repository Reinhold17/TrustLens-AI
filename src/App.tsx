import { useEffect, useMemo, useState } from "react";
import {
  Activity, AlertCircle, Archive, ArrowRight, ArrowUpRight, Bell, BookOpenCheck, Check,
  CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Clock3,
  Download, FileDown, FileSearch, FileText, FolderKanban, Globe2,
  LayoutDashboard, LockKeyhole, Menu, MoreHorizontal, Plus, Search,
  Settings, Shield, ShieldAlert, ShieldCheck, Sparkles, Target, Users, X,
} from "lucide-react";
import {
  severityOrder,
  type Assessment, type AssessmentStatus, type Evidence, type Finding, type InputKind, type InputPoint,
  type ManualTestCategory, type ManualTestRecord, type ManualTestResult,
} from "./data";
import {
  archiveAssessment as archiveAssessmentRequest, createAssessment, createEvidence, createFinding,
  analyzeFinding, createInput, createManualTest, downloadReport, getAIStatus, getSession, loadWorkspace, reviewFinding, signIn, signOut, signUp, submitReport,
  updateAssessment, updateInput, type ActivityRecord, type ReportRecord, type TeamRecord, type WorkspaceUser,
  type AIAnalysisResult,
} from "./api";

type PageKey = "Overview" | "Assessments" | "Input Points" | "Findings" | "Evidence" | "AI Analysis" | "Reports" | "Team & Activity" | "Settings";
type Modal = "assessment" | "input" | "finding" | "evidence" | "manual-test" | null;

const navigation: { label: PageKey; icon: typeof LayoutDashboard }[] = [
  { label: "Overview", icon: LayoutDashboard }, { label: "Assessments", icon: FolderKanban },
  { label: "Input Points", icon: Target }, { label: "Findings", icon: ShieldAlert },
  { label: "Evidence", icon: FileSearch }, { label: "AI Analysis", icon: Sparkles },
  { label: "Reports", icon: FileText }, { label: "Team & Activity", icon: Users },
  { label: "Settings", icon: Settings },
];

const severityClass = (severity: string) => `severity severity-${severity.toLowerCase()}`;
const statusClass = (status: string) => `status status-${status.toLowerCase().replaceAll(" ", "-")}`;
const inputLabel = (input: InputPoint | undefined) => input ? `${input.route} · ${input.name}` : "Input point unavailable";
const initialForm = { name: "", organization: "", scope: "", start: "", end: "", notes: "", approval: "Pending" as Assessment["approval"], status: "Planning" as AssessmentStatus, approvedForTesting: false };
const initialFindingForm = { title: "", category: "Input Validation", inputId: "", severity: "Medium" as Finding["severity"], confidence: 50, description: "", impact: "", remediation: "", assessment: "" };
const testTemplates: { category: ManualTestCategory; description: string; expectedBehavior: string }[] = [
  { category: "Required field", description: "With authorization, submit the form with this field omitted.", expectedBehavior: "The application rejects the submission with a clear validation message and does not accept incomplete data." },
  { category: "Whitespace-only input", description: "With authorization, enter only whitespace in the field and submit.", expectedBehavior: "Whitespace-only content is trimmed or rejected according to documented requirements; it is not silently accepted as meaningful input." },
  { category: "Length limits", description: "With authorization, compare benign text just below, at, and just above the documented length limit.", expectedBehavior: "The documented maximum is enforced consistently; values within the allowed range behave as specified." },
  { category: "Format validation", description: "With authorization, enter a clearly invalid, non-sensitive value for the documented field format.", expectedBehavior: "The application validates the expected format and gives a clear, safe response without accepting malformed data." },
  { category: "Special characters", description: "With authorization, enter ordinary punctuation and symbols used in legitimate text, such as apostrophes, hyphens, parentheses, or ampersands.", expectedBehavior: "Legitimate characters are handled according to requirements and safely encoded for the output context." },
];

export default function App() {
  const [page, setPage] = useState<PageKey>("Overview");
  const [user, setUser] = useState<WorkspaceUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [inputs, setInputs] = useState<InputPoint[]>([]);
  const [manualTests, setManualTests] = useState<ManualTestRecord[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [team, setTeam] = useState<TeamRecord[]>([]);
  const [activity, setActivity] = useState<ActivityRecord[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [assessmentEdit, setAssessmentEdit] = useState<Assessment | null>(null);
  const [inputEdit, setInputEdit] = useState<InputPoint | null>(null);
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);
  const [toast, setToast] = useState("");
  const [filterSearch, setFilterSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState("All severities");
  const [validationFilter, setValidationFilter] = useState("All statuses");
  const [aiFinding, setAiFinding] = useState("");
  const [assessmentForm, setAssessmentForm] = useState(initialForm);
  const [inputForm, setInputForm] = useState({ route: "", name: "", kind: "Form" as InputKind, status: "Not reviewed" as InputPoint["status"], notes: "", assessment: "a-1" });
  const [manualTestForm, setManualTestForm] = useState({ inputId: "", category: "Required field" as ManualTestCategory, description: testTemplates[0].description, expectedBehavior: testTemplates[0].expectedBehavior, actualBehavior: "", evidenceReference: "", result: "Inconclusive" as ManualTestResult });
  const [findingForm, setFindingForm] = useState(initialFindingForm);
  const [evidenceForm, setEvidenceForm] = useState({ title: "", kind: "Analyst note", date: new Date().toISOString().slice(0, 10), notes: "", reproductionSteps: "", request: "", response: "", reference: "", inputId: "", findingId: "", redacted: false });

  const applyWorkspace = (workspace: Awaited<ReturnType<typeof loadWorkspace>>) => {
    setAssessments(workspace.assessments);
    setInputs(workspace.inputs);
    setManualTests(workspace.manualTests);
    setFindings(workspace.findings);
    setEvidence(workspace.evidence);
    setReports(workspace.reports);
    setTeam(workspace.team);
    setActivity(workspace.activity);
    if (!workspace.findings.some((finding) => finding.id === aiFinding)) {
      setAiFinding(workspace.findings[0]?.id ?? "");
    }
  };
  const refreshWorkspace = async () => applyWorkspace(await loadWorkspace());
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  };
  const persist = async (operation: () => Promise<unknown>, success: string) => {
    try {
      await operation();
      await refreshWorkspace();
      notify(success);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "The request could not be completed.");
      return false;
    }
  };
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const session = await getSession();
        if (!active) return;
        setUser(session);
        if (session) await refreshWorkspace();
      } catch (error) {
        if (active) setAuthError(error instanceof Error ? error.message : "The backend could not be reached.");
      } finally {
        if (active) setAuthLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);
  const filteredFindings = useMemo(() => findings.filter((finding) => {
    const needle = filterSearch.trim().toLowerCase();
    const searchable = `${finding.title} ${finding.id} ${finding.category} ${finding.description}`.toLowerCase();
    return (!needle || searchable.includes(needle))
      && (severityFilter === "All severities" || finding.severity === severityFilter)
      && (validationFilter === "All statuses" || finding.validation === validationFilter);
  }), [findings, filterSearch, severityFilter, validationFilter]);

  const openAssessment = (assessment?: Assessment) => {
    setAssessmentEdit(assessment ?? null);
    setAssessmentForm(assessment ? { name: assessment.name, organization: assessment.organization, scope: assessment.scope, start: assessment.start, end: assessment.end, notes: assessment.notes, approval: assessment.approval, status: assessment.status, approvedForTesting: assessment.approvedForTesting ?? false } : initialForm);
    setModal("assessment");
  };
  const saveAssessment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (assessmentForm.status === "In Progress" && (assessmentForm.approval !== "Approved" || !assessmentForm.approvedForTesting)) {
      notify("An assessment can only be marked In Progress after scope approval and confirmation are recorded.");
      return;
    }
    const saved = await persist(
      () => assessmentEdit ? updateAssessment(assessmentEdit.id, assessmentForm) : createAssessment(assessmentForm),
      assessmentEdit ? "Assessment updated." : "Assessment created.",
    );
    if (saved) setModal(null);
  };
  const archiveAssessment = async (id: string, archived: boolean) => {
    await persist(() => archiveAssessmentRequest(id, archived), archived ? "Assessment archived." : "Assessment restored.");
  };
  const openInput = (input?: InputPoint) => {
    setInputEdit(input ?? null);
    setInputForm(input ? { route: input.route, name: input.name, kind: input.kind, status: input.status, notes: input.notes, assessment: input.assessment } : { route: "", name: "", kind: "Form", status: "Not reviewed", notes: "", assessment: assessments.find((item) => !item.archived)?.id ?? "" });
    setModal("input");
  };
  const openManualTest = (input: InputPoint) => {
    const template = testTemplates.find((item) => item.category === "Required field")!;
    setManualTestForm({
      inputId: input.id,
      category: template.category,
      description: template.description,
      expectedBehavior: template.expectedBehavior,
      actualBehavior: "",
      evidenceReference: "",
      result: "Inconclusive",
    });
    setModal("manual-test");
  };
  const saveManualTest = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const saved = await persist(
      () => createManualTest(manualTestForm),
      "Manual test observation saved. It does not confirm a finding.",
    );
    if (saved) setModal(null);
  };
  const saveInput = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const saved = await persist(
      () => inputEdit ? updateInput(inputEdit.id, inputForm) : createInput(inputForm),
      inputEdit ? "Input point updated." : "Input point added to the inventory.",
    );
    if (saved) setModal(null);
  };
  const openFinding = () => {
    const input = inputs.find((item) => !assessments.find((assessment) => assessment.id === item.assessment)?.archived);
    setFindingForm({ ...initialFindingForm, inputId: input?.id ?? "", assessment: input?.assessment ?? "" });
    setModal("finding");
  };
  const saveFinding = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const saved = await persist(() => createFinding(findingForm), "Finding recorded as Suspected. Request independent human review when evidence is ready.");
    if (saved) setModal(null);
  };
  const saveEvidence = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const finding = findings.find((item) => item.id === evidenceForm.findingId);
    if (!finding) {
      notify("Choose a valid finding.");
      return;
    }
    if (evidenceForm.inputId !== finding.inputId) {
      notify("Evidence must be linked to the input point affected by the selected finding.");
      return;
    }
    const saved = await persist(() => createEvidence(evidenceForm), "Evidence saved with redaction confirmed.");
    if (saved) {
      setModal(null);
      setEvidenceForm({ title: "", kind: "Analyst note", date: new Date().toISOString().slice(0, 10), notes: "", reproductionSteps: "", request: "", response: "", reference: "", inputId: "", findingId: "", redacted: false });
    }
  };
  const confirmFinding = async (finding: Finding) => {
    const acknowledgement = window.confirm("Human review required\n\nConfirm you reviewed the linked evidence and agree it supports this conclusion. Mark this finding Confirmed?");
    if (!acknowledgement) return;
    await persist(() => reviewFinding(finding.id, "Confirmed"), `${finding.title} marked Confirmed after human review.`);
  };
  const markFalsePositive = async (finding: Finding) => {
    if (!window.confirm("Mark this observation as a false positive after human review?")) return;
    await persist(() => reviewFinding(finding.id, "False Positive"), `${finding.title} marked False Positive after human review.`);
  };
  const navigate = (next: PageKey) => {
    setPage(next);
    setFilterSearch("");
    setGlobalSearch("");
    setMenuOpen(false);
  };
  const globalMatches = globalSearch.trim() ? [
    ...findings.filter((item) => item.title.toLowerCase().includes(globalSearch.toLowerCase())).map((item) => ({ label: item.title, page: "Findings" as PageKey })),
    ...assessments.filter((item) => item.name.toLowerCase().includes(globalSearch.toLowerCase())).map((item) => ({ label: item.name, page: "Assessments" as PageKey })),
    ...inputs.filter((item) => `${item.route} ${item.name}`.toLowerCase().includes(globalSearch.toLowerCase())).map((item) => ({ label: `${item.route} · ${item.name}`, page: "Input Points" as PageKey })),
  ].slice(0, 5) : [];
  const activeAssessment = assessments.find((assessment) => !assessment.archived && assessment.status === "In Progress") ?? assessments.find((assessment) => !assessment.archived);
  const canReview = user?.role === "Administrator" || user?.role === "Reviewer";
  const handleAuthentication = async (username: string, password: string, confirmPassword: string, registering: boolean) => {
    try {
      const authenticatedUser = registering
        ? await signUp(username, password, confirmPassword)
        : await signIn(username, password);
      await refreshWorkspace();
      setUser(authenticatedUser);
      setAuthError("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Sign-in failed.");
    }
  };
  const handleSignOut = async () => {
    try {
      await signOut();
      setUser(null);
      setAssessments([]);
      setInputs([]);
      setManualTests([]);
      setFindings([]);
      setEvidence([]);
      setReports([]);
      setTeam([]);
      setActivity([]);
      setMenuOpen(false);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not sign out.");
    }
  };
  const handleReportSubmission = async (assessmentId: string) => {
    try {
      const report = await submitReport(assessmentId);
      await refreshWorkspace();
      await downloadReport(report.id, report.assessment);
      notify("Report submitted and PDF downloaded.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Report submission failed.");
    }
  };

  if (authLoading) return <div className="auth-screen"><div className="auth-card"><span className="brand-mark"><ShieldCheck size={21} /></span><strong>Connecting to TrustLens…</strong><p>Loading your secured assessment workspace.</p></div></div>;
  if (!user) return <LoginPage error={authError} onSubmit={handleAuthentication} />;

  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate("Overview")} aria-label="TrustLens AI overview">
          <span className="brand-mark"><ShieldCheck size={21} strokeWidth={2.2} /></span>
          {!collapsed && <span className="brand-copy"><strong>trustlens<span>ai</span></strong><small>SECURITY WORKSPACE</small></span>}
        </button>
        <div className="workspace-label">{!collapsed && "WORKSPACE"}</div>
        <nav className="nav-list" aria-label="Main navigation">
          {navigation.map(({ label, icon: Icon }) => (
            <button key={label} className={`nav-item ${page === label ? "active" : ""}`} onClick={() => navigate(label)} title={collapsed ? label : undefined}>
              <Icon size={18} strokeWidth={1.8} /><span>{!collapsed && label}</span>
              {!collapsed && label === "Findings" && <span className="nav-count">{findings.length}</span>}
            </button>
          ))}
        </nav>
        {!collapsed && <div className="sidebar-assessment">
          <div className="side-card-heading"><span className="live-dot" /> ACTIVE ASSESSMENT</div>
          {activeAssessment ? <>
            <strong>{activeAssessment.organization}</strong>
            <span>{activeAssessment.name}</span>
            <div className="side-progress"><i style={{ width: `${activeAssessment.progress}%` }} /></div>
            <div className="side-progress-label"><span>{activeAssessment.progress}% complete</span><span>{activeAssessment.end}</span></div>
          </> : <span>No active assessment yet.</span>}
          <button className="side-link" onClick={() => navigate("Assessments")}>View assessments <ArrowRight size={14} /></button>
        </div>}
        <div className="sidebar-footer">
          <div className="demo-label"><span><Shield size={14} /></span>{!collapsed && <span><strong>Private workspace</strong><small>Persistent assessment records</small></span>}</div>
          <button className="collapse-button" onClick={() => setCollapsed(!collapsed)} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
            {collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
          </button>
        </div>
      </aside>

      <main className="main-column">
        <header className="topbar">
          <button className="mobile-menu icon-button" onClick={() => setCollapsed(!collapsed)} aria-label="Toggle navigation"><Menu size={19} /></button>
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>{page}</strong></div>
          <div className="topbar-tools">
            <div className="global-search">
              <Search size={16} />
              <input aria-label="Search workspace" placeholder="Search anything..." value={globalSearch} onChange={(event) => setGlobalSearch(event.target.value)} />
              <kbd>⌘ K</kbd>
              {globalMatches.length > 0 && <div className="search-popover">{globalMatches.map((match) => <button key={`${match.page}-${match.label}`} onClick={() => navigate(match.page)}><Search size={14} /><span>{match.label}</span><small>{match.page}</small></button>)}</div>}
            </div>
            <div className="popover-anchor">
              <button className={`icon-button notification-button ${notificationOpen ? "selected" : ""}`} aria-label="Notifications" onClick={() => { setNotificationOpen(!notificationOpen); setMenuOpen(false); }}><Bell size={18} /><i /></button>
              {notificationOpen && <div className="small-popover notifications-popover"><strong>Recent workspace activity</strong>{activity.slice(0, 5).map((item) => <div key={item.id}><span className="notification-dot" /><p><b>{item.actor} {item.action}</b><small>{item.subject} · {new Date(item.createdAt).toLocaleString()}</small></p></div>)}{activity.length === 0 && <p className="empty-context">No workspace activity yet.</p>}</div>}
            </div>
            <div className="popover-anchor">
              <button className="profile-button" onClick={() => { setMenuOpen(!menuOpen); setNotificationOpen(false); }}>
                <span className="avatar avatar-violet">{user.name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><span className="profile-name"><strong>{user.name}</strong><small>{user.role}</small></span><ChevronDown size={15} />
              </button>
              {menuOpen && <div className="small-popover profile-popover"><button onClick={() => navigate("Settings")}><Settings size={15} /> Account settings</button><button onClick={handleSignOut}><LockKeyhole size={15} /> Sign out</button></div>}
            </div>
          </div>
        </header>

        <div className="demo-strip"><Shield size={14} /><span><strong>AUTHORIZED ASSESSMENTS ONLY</strong><i /> Records are private and saved to the workspace database. TrustLens never scans or contacts target websites.</span><button onClick={() => notify("Only document work conducted within written authorization and the recorded scope.")}>Safety notice <ArrowUpRight size={13} /></button></div>
        <section className="content">
          {page === "Overview" && <Overview assessments={assessments} findings={findings} inputs={inputs} setPage={navigate} onFinding={setSelectedFinding} user={user} activity={activity} />}
          {page === "Assessments" && <AssessmentsPage assessments={assessments} archived={assessments.filter((item) => item.archived)} onCreate={() => openAssessment()} onEdit={openAssessment} onArchive={(id) => archiveAssessment(id, true)} onRestore={(id) => archiveAssessment(id, false)} />}
          {page === "Input Points" && <InputsPage inputs={inputs} assessments={assessments} manualTests={manualTests} canRecordManualTest={user?.role === "Analyst" || user?.role === "Administrator"} search={filterSearch} setSearch={setFilterSearch} onAdd={() => openInput()} onEdit={openInput} onRecordTest={openManualTest} />}
          {page === "Findings" && <FindingsPage findings={filteredFindings} inputs={inputs} search={filterSearch} setSearch={setFilterSearch} severity={severityFilter} setSeverity={setSeverityFilter} validation={validationFilter} setValidation={setValidationFilter} onAdd={openFinding} onSelect={setSelectedFinding} />}
          {page === "Evidence" && <EvidencePage evidence={evidence} inputs={inputs} findings={findings} onAdd={() => {
            const finding = findings[0];
            if (!finding) {
              notify("Add a finding before linking evidence.");
              setPage("Findings");
              return;
            }
            setEvidenceForm({ title: "", kind: "Analyst note", date: new Date().toISOString().slice(0, 10), notes: "", reproductionSteps: "", request: "", response: "", reference: "", inputId: finding.inputId, findingId: finding.id, redacted: false });
            setModal("evidence");
          }} onNotify={notify} />}
          {page === "AI Analysis" && <AIAnalysis findings={findings} inputs={inputs} evidence={evidence} manualTests={manualTests} selected={aiFinding} onSelect={setAiFinding} />}
          {page === "Reports" && <ReportsPage assessments={assessments} inputs={inputs} findings={findings} evidence={evidence} manualTests={manualTests} reports={reports} canSubmitReport={canReview} onSubmit={handleReportSubmission} />}
          {page === "Team & Activity" && <TeamPage team={team} activity={activity} assessments={assessments} user={user} onNotify={notify} />}
          {page === "Settings" && <SettingsPage user={user} />}
        </section>
      </main>

      {modal === "assessment" && <ModalShell title={assessmentEdit ? "Edit assessment" : "New assessment"} subtitle="Define the authorized scope and the people involved." onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={saveAssessment}>
          <label className="field wide">Assessment name<input required value={assessmentForm.name} onChange={(event) => setAssessmentForm({ ...assessmentForm, name: event.target.value })} placeholder="e.g. Checkout input review" /></label>
          <label className="field">Organization or project<input required value={assessmentForm.organization} onChange={(event) => setAssessmentForm({ ...assessmentForm, organization: event.target.value })} placeholder="Project name" /></label>
          <label className="field">Authorized target scope<input required value={assessmentForm.scope} onChange={(event) => setAssessmentForm({ ...assessmentForm, scope: event.target.value })} placeholder="staging.example.com" /></label>
          <label className="field">Scope approval<select value={assessmentForm.approval} onChange={(event) => setAssessmentForm({ ...assessmentForm, approval: event.target.value as Assessment["approval"] })}><option>Pending</option><option>Approved</option><option>Not requested</option></select></label>
          <label className="field">Assessment status<select value={assessmentForm.status} onChange={(event) => setAssessmentForm({ ...assessmentForm, status: event.target.value as AssessmentStatus })}><option>Planning</option><option>In Progress</option><option>Under Review</option><option>Completed</option></select></label>
          <label className="field">Start date<input required type="date" value={assessmentForm.start} onChange={(event) => setAssessmentForm({ ...assessmentForm, start: event.target.value })} /></label>
          <label className="field">End date<input required type="date" value={assessmentForm.end} onChange={(event) => setAssessmentForm({ ...assessmentForm, end: event.target.value })} /></label>
          <label className="field wide">Notes & testing limitations<textarea rows={3} value={assessmentForm.notes} onChange={(event) => setAssessmentForm({ ...assessmentForm, notes: event.target.value })} placeholder="Document excluded testing, environment limits, and other guardrails." /></label>
          <div className="scope-confirmation wide"><LockKeyhole size={17} /><div><strong>Scope confirmation required</strong><span>Testing readiness requires documented authorization and an approved target scope. This prototype never contacts a target.</span></div></div>
          <label className="checkbox-row wide"><input type="checkbox" checked={assessmentForm.approvedForTesting} onChange={(event) => setAssessmentForm({ ...assessmentForm, approvedForTesting: event.target.checked })} /><span>I confirm authorization is documented and the target is within scope.</span></label>
          <div className="modal-actions wide"><button type="button" className="button secondary" onClick={() => setModal(null)}>Cancel</button><button className="button primary" type="submit">{assessmentEdit ? "Save changes" : "Create assessment"}</button></div>
        </form>
      </ModalShell>}
      {modal === "input" && <ModalShell title={inputEdit ? "Edit input point" : "Add input point"} subtitle="Document an input manually. Live scanning is not available." onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={saveInput}>
          <label className="field">Page or route<input required value={inputForm.route} onChange={(event) => setInputForm({ ...inputForm, route: event.target.value })} placeholder="/account/profile" /></label>
          <label className="field">Input name<input required value={inputForm.name} onChange={(event) => setInputForm({ ...inputForm, name: event.target.value })} placeholder="displayName" /></label>
          <label className="field">Input type<select value={inputForm.kind} onChange={(event) => setInputForm({ ...inputForm, kind: event.target.value as InputKind })}>{["Form", "Query Parameter", "Search Field", "Header", "Other"].map((kind) => <option key={kind}>{kind}</option>)}</select></label>
          <label className="field">Review status<select value={inputForm.status} onChange={(event) => setInputForm({ ...inputForm, status: event.target.value as InputPoint["status"] })}><option>Not reviewed</option><option>In review</option><option>Reviewed</option></select></label>
          <label className="field">Assessment<select value={inputForm.assessment} onChange={(event) => setInputForm({ ...inputForm, assessment: event.target.value })}>{assessments.map((item) => <option key={item.id} value={item.id}>{item.organization}</option>)}</select></label>
          <label className="field wide">Reviewer notes<textarea rows={3} value={inputForm.notes} onChange={(event) => setInputForm({ ...inputForm, notes: event.target.value })} placeholder="What is known about this input?" /></label>
          <div className="modal-actions wide"><button type="button" className="button secondary" onClick={() => setModal(null)}>Cancel</button><button className="button primary" type="submit">{inputEdit ? "Save changes" : "Add input point"}</button></div>
        </form>
      </ModalShell>}
      {modal === "finding" && <ModalShell title="Record finding" subtitle="Record an evidence-backed observation. New findings remain Suspected until reviewed." onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={saveFinding}>
          <label className="field wide">Finding title<input required maxLength={220} value={findingForm.title} onChange={(event) => setFindingForm({ ...findingForm, title: event.target.value })} placeholder="Describe the observed behavior" /></label>
          <label className="field">Assessment<select required value={findingForm.assessment} onChange={(event) => {
            const assessmentId = event.target.value;
            const input = inputs.find((item) => item.assessment === assessmentId);
            setFindingForm({ ...findingForm, assessment: assessmentId, inputId: input?.id ?? "" });
          }}><option value="">Choose assessment</option>{assessments.filter((item) => !item.archived).map((item) => <option key={item.id} value={item.id}>{item.organization}</option>)}</select></label>
          <label className="field">Affected input point<select required value={findingForm.inputId} onChange={(event) => setFindingForm({ ...findingForm, inputId: event.target.value })}><option value="">Choose input</option>{inputs.filter((item) => item.assessment === findingForm.assessment).map((item) => <option key={item.id} value={item.id}>{item.route} · {item.name}</option>)}</select></label>
          <label className="field">Category<select value={findingForm.category} onChange={(event) => setFindingForm({ ...findingForm, category: event.target.value })}>{["Input Validation", "Injection Risk", "Cross-Site Scripting", "Output Encoding", "Other"].map((category) => <option key={category}>{category}</option>)}</select></label>
          <label className="field">Severity<select value={findingForm.severity} onChange={(event) => setFindingForm({ ...findingForm, severity: event.target.value as Finding["severity"] })}>{severityOrder.map((severity) => <option key={severity}>{severity}</option>)}</select></label>
          <label className="field">Confidence (%)<input type="number" min="0" max="100" required value={findingForm.confidence} onChange={(event) => setFindingForm({ ...findingForm, confidence: Number(event.target.value) })} /></label>
          <label className="field wide">Observed behavior<textarea rows={3} required value={findingForm.description} onChange={(event) => setFindingForm({ ...findingForm, description: event.target.value })} /></label>
          <label className="field wide">Potential impact<textarea rows={2} value={findingForm.impact} onChange={(event) => setFindingForm({ ...findingForm, impact: event.target.value })} /></label>
          <label className="field wide">Recommended remediation<textarea rows={2} value={findingForm.remediation} onChange={(event) => setFindingForm({ ...findingForm, remediation: event.target.value })} /></label>
          <div className="modal-actions wide"><button type="button" className="button secondary" onClick={() => setModal(null)}>Cancel</button><button className="button primary" type="submit">Record as suspected</button></div>
        </form>
      </ModalShell>}
      {modal === "manual-test" && <ModalShell title="Record manual input test" subtitle="Run this check manually only within the approved scope, then record what you observed." onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={saveManualTest}>
          <div className="callout-blue wide"><ShieldCheck size={16} /><span><strong>Manual documentation only.</strong> TrustLens does not run tests or send values to a target. Use only benign inputs, within written authorization, and record sanitized observations.</span></div>
          <label className="field wide">Input point<input readOnly value={inputLabel(inputs.find((item) => item.id === manualTestForm.inputId))} /></label>
          <label className="field wide">Template category<select value={manualTestForm.category} onChange={(event) => {
            const category = event.target.value as ManualTestCategory;
            const template = testTemplates.find((item) => item.category === category);
            setManualTestForm({ ...manualTestForm, category, description: template?.description ?? "", expectedBehavior: template?.expectedBehavior ?? "" });
          }}>{testTemplates.map((template) => <option key={template.category} value={template.category}>{template.category}</option>)}<option value="Other">Other</option></select></label>
          <label className="field wide">Test description<textarea rows={2} required maxLength={1000} value={manualTestForm.description} onChange={(event) => setManualTestForm({ ...manualTestForm, description: event.target.value })} /></label>
          <label className="field wide">Expected behavior<textarea rows={2} required maxLength={5000} value={manualTestForm.expectedBehavior} onChange={(event) => setManualTestForm({ ...manualTestForm, expectedBehavior: event.target.value })} /></label>
          <label className="field wide">Actual observed behavior<textarea rows={3} required maxLength={10000} value={manualTestForm.actualBehavior} onChange={(event) => setManualTestForm({ ...manualTestForm, actualBehavior: event.target.value })} placeholder="Record only what you observed; no secrets or personal data." /></label>
          <label className="field">Result<select value={manualTestForm.result} onChange={(event) => setManualTestForm({ ...manualTestForm, result: event.target.value as ManualTestResult })}><option>Pass</option><option>Deviation observed</option><option>Inconclusive</option></select></label>
          <label className="field">Evidence reference (optional)<input maxLength={500} value={manualTestForm.evidenceReference} onChange={(event) => setManualTestForm({ ...manualTestForm, evidenceReference: event.target.value })} placeholder="Link to a saved evidence record or note" /></label>
          <div className="modal-actions wide"><button type="button" className="button secondary" onClick={() => setModal(null)}>Cancel</button><button className="button primary" type="submit"><Plus size={15} /> Save manual observation</button></div>
        </form>
      </ModalShell>}
      {modal === "evidence" && <ModalShell title="Record evidence" subtitle="Store sanitized evidence linked to an input and finding." onClose={() => setModal(null)}>
        <form className="form-grid" onSubmit={saveEvidence}>
          <div className="warning-box wide"><AlertCircle size={17} /><span><strong>Never store sensitive data.</strong> Do not include passwords, access tokens, API keys, or customer personal information.</span></div>
          <label className="field wide">Evidence title<input required value={evidenceForm.title} onChange={(event) => setEvidenceForm({ ...evidenceForm, title: event.target.value })} placeholder="Short descriptive title" /></label>
          <label className="field">Evidence type<select value={evidenceForm.kind} onChange={(event) => setEvidenceForm({ ...evidenceForm, kind: event.target.value })}>{["Analyst note", "Reproduction record", "Sanitized excerpt", "Screenshot reference", "Reviewer note"].map((kind) => <option key={kind}>{kind}</option>)}</select></label>
          <label className="field">Date observed<input type="date" required value={evidenceForm.date} onChange={(event) => setEvidenceForm({ ...evidenceForm, date: event.target.value })} /></label>
          <label className="field wide">Linked finding<select required value={evidenceForm.findingId} onChange={(event) => {
            const finding = findings.find((item) => item.id === event.target.value);
            setEvidenceForm({ ...evidenceForm, findingId: event.target.value, inputId: finding?.inputId ?? "" });
          }}><option value="">Choose finding</option>{findings.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
          <label className="field wide">Linked input point<select required value={evidenceForm.inputId} onChange={(event) => setEvidenceForm({ ...evidenceForm, inputId: event.target.value })}>{inputs.filter((item) => findings.find((finding) => finding.id === evidenceForm.findingId)?.inputId === item.id).map((item) => <option key={item.id} value={item.id}>{item.route} · {item.name}</option>)}</select></label>
          <label className="field wide">Observation notes<textarea rows={3} required value={evidenceForm.notes} onChange={(event) => setEvidenceForm({ ...evidenceForm, notes: event.target.value })} placeholder="Describe what was observed; distinguish facts from interpretation." /></label>
          <label className="field wide">Reproduction steps<textarea rows={2} value={evidenceForm.reproductionSteps} onChange={(event) => setEvidenceForm({ ...evidenceForm, reproductionSteps: event.target.value })} placeholder="Document safe, authorized steps for review." /></label>
          <label className="field">Sanitized request excerpt<textarea rows={2} value={evidenceForm.request} onChange={(event) => setEvidenceForm({ ...evidenceForm, request: event.target.value })} placeholder="Remove secrets and personal data" /></label>
          <label className="field">Sanitized response excerpt<textarea rows={2} value={evidenceForm.response} onChange={(event) => setEvidenceForm({ ...evidenceForm, response: event.target.value })} placeholder="Remove secrets and personal data" /></label>
          <label className="field wide">Screenshot attachment reference (optional)<input value={evidenceForm.reference} onChange={(event) => setEvidenceForm({ ...evidenceForm, reference: event.target.value })} placeholder="Sanitized filename or internal reference — no upload is stored" /></label>
          <label className="checkbox-row wide"><input type="checkbox" checked={evidenceForm.redacted} onChange={(event) => setEvidenceForm({ ...evidenceForm, redacted: event.target.checked })} /><span>I have reviewed and redacted this evidence. It contains no credentials or personal data.</span></label>
          <div className="modal-actions wide"><button type="button" className="button secondary" onClick={() => setModal(null)}>Cancel</button><button className="button primary" type="submit"><Plus size={15} /> Save evidence</button></div>
        </form>
      </ModalShell>}
      {selectedFinding && <FindingDrawer finding={selectedFinding} inputs={inputs} evidence={evidence} canReview={canReview} onClose={() => setSelectedFinding(null)} onConfirm={() => confirmFinding(selectedFinding)} onFalsePositive={() => markFalsePositive(selectedFinding)} />}
      {toast && <div className="toast"><CheckCircle2 size={17} />{toast}</div>}
    </div>
  );
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1><p>{description}</p></div>{action && <div className="heading-action">{action}</div>}</div>;
}

function Overview({ assessments, findings, inputs, setPage, onFinding, user, activity }: { assessments: Assessment[]; findings: Finding[]; inputs: InputPoint[]; setPage: (page: PageKey) => void; onFinding: (finding: Finding) => void; user: WorkspaceUser; activity: ActivityRecord[] }) {
  const confirmed = findings.filter((finding) => finding.validation === "Confirmed").length;
  const pending = findings.filter((finding) => finding.validation === "Suspected").length;
  const reviewed = inputs.filter((input) => input.status === "Reviewed").length;
  const activeAssessments = assessments.filter((item) => !item.archived && item.status === "In Progress");
  const visibleAssessments = assessments.filter((item) => !item.archived);
  const progress = visibleAssessments.length ? Math.round(visibleAssessments.reduce((sum, item) => sum + item.progress, 0) / visibleAssessments.length) : 0;
  const severityCounts = severityOrder.map((severity) => ({ severity, count: findings.filter((finding) => finding.severity === severity).length }));
  return <>
    <PageHeader eyebrow={new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).toUpperCase()} title={`Welcome, ${user.name}`} description="A clear view of your authorized assessment work." action={<button className="button primary" onClick={() => setPage("Assessments")}><Plus size={16} /> New assessment</button>} />
    <div className="overview-kpis">
      <Metric label="Active assessments" value={String(activeAssessments.length).padStart(2, "0")} detail={`${visibleAssessments.length} total in workspace`} icon={FolderKanban} color="blue" />
      <Metric label="Input points reviewed" value={`${reviewed} / ${inputs.length}`} detail={`${inputs.length ? Math.round(reviewed / inputs.length * 100) : 0}% of documented inputs`} icon={Target} color="teal" />
      <Metric label="Awaiting validation" value={String(pending).padStart(2, "0")} detail="Human review required" icon={Clock3} color="amber" />
      <Metric label="Confirmed findings" value={String(confirmed).padStart(2, "0")} detail="Human-reviewed conclusions" icon={ShieldCheck} color="green" />
    </div>
    <div className="dashboard-grid">
      <section className="panel severity-panel">
        <div className="panel-heading"><div><h2>Findings by severity</h2><p>Current workspace · saved assessment records</p></div><button className="text-button" onClick={() => setPage("Findings")}>View findings <ArrowRight size={14} /></button></div>
        <div className="severity-chart-area">
          <div className="donut-chart"><div className="donut-hole"><strong>{findings.length}</strong><span>FINDINGS</span></div></div>
          <div className="severity-legend">{severityCounts.map(({ severity, count }) => <div key={severity}><i className={`legend-dot dot-${severity.toLowerCase()}`} /><span>{severity}</span><strong>{String(count).padStart(2, "0")}</strong></div>)}</div>
        </div>
        <div className="chart-footnote"><span className="tiny-info">i</span> Suspected records require human review before report submission.</div>
      </section>
      <section className="panel completion-panel">
        <div className="panel-heading"><div><h2>Assessment progress</h2><p>Active authorized engagements</p></div><button className="icon-button quiet" onClick={() => setPage("Assessments")} aria-label="View assessments"><MoreHorizontal size={18} /></button></div>
        <div className="completion-summary"><strong>{progress}%</strong><span>average input review</span><span className="trend-pill"><FolderKanban size={12} /> {visibleAssessments.length} assessments</span></div>
        <div className="progress-track large"><i style={{ width: `${progress}%` }} /></div>
        <div className="progress-caption"><span>Documented input points reviewed</span><strong>{reviewed} of {inputs.length}</strong></div>
        <div className="completion-divider" />
        <div className="mini-assessment-list">{visibleAssessments.slice(0, 2).map((item) => <div key={item.id} className="mini-assessment"><span className={`assessment-icon ${item.status === "Under Review" ? "mint" : "blue"}`}><Globe2 size={16} /></span><span className="assessment-mini-copy"><strong>{item.organization}</strong><small>{item.status} · due {new Date(`${item.end}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small></span><b>{item.progress}%</b></div>)}</div>
        {visibleAssessments.length === 0 && <p className="empty-context">Create an assessment to start tracking review progress.</p>}
      </section>
    </div>
    <div className="dashboard-grid lower-grid">
      <section className="panel latest-panel">
        <div className="panel-heading"><div><h2>Latest findings</h2><p>Recent observations from your team</p></div><button className="text-button" onClick={() => setPage("Findings")}>All findings <ArrowRight size={14} /></button></div>
        <div className="latest-list">{findings.slice(0, 4).map((finding) => <button className="latest-row" key={finding.id} onClick={() => onFinding(finding)}>
          <span className={`finding-icon ${finding.severity.toLowerCase()}`}><ShieldAlert size={16} /></span>
          <span className="latest-copy"><strong>{finding.title}</strong><small>{finding.id} <i /> {finding.category}</small></span>
          <span className={severityClass(finding.severity)}>{finding.severity}</span><span className="latest-chevron"><ChevronRight size={16} /></span>
        </button>)}</div>
        {findings.length === 0 && <EmptyState title="No findings recorded" description="Document a finding after reviewing an authorized input point." action={<button className="button secondary compact" onClick={() => setPage("Findings")}><Plus size={14} /> View findings</button>} />}
        {findings.length > 0 && <div className="sample-note"><AlertCircle size={14} /> Findings are analyst observations; validation requires a reviewer.</div>}
      </section>
      <section className="panel activity-panel">
        <div className="panel-heading"><div><h2>Recent activity</h2><p>Team updates across the workspace</p></div><button className="icon-button quiet" onClick={() => setPage("Team & Activity")} aria-label="See all activity"><ArrowUpRight size={17} /></button></div>
        <div className="activity-list">{activity.slice(0, 3).map((item) => <div className="activity-row" key={item.id}><span className="activity-icon blue"><Activity size={15} /></span><p><strong>{item.actor}</strong> {item.action}<small><Clock3 size={12} /> {new Date(item.createdAt).toLocaleString()}</small></p><small>{item.subject}</small></div>)}</div>
        {activity.length === 0 && <EmptyState title="No activity yet" description="Assessment updates and reviews will appear here." />}
        <button className="activity-footer" onClick={() => setPage("Team & Activity")}>View all activity <ArrowRight size={14} /></button>
      </section>
    </div>
  </>;
}

function Metric({ label, value, detail, icon: Icon, color }: { label: string; value: string; detail: string; icon: typeof LayoutDashboard; color: string }) {
  return <section className="metric-card"><div className="metric-top"><span>{label}</span><i className={`metric-icon ${color}`}><Icon size={17} /></i></div><strong>{value}</strong><small>{detail}</small></section>;
}

function AssessmentsPage({ assessments, archived, onCreate, onEdit, onArchive, onRestore }: { assessments: Assessment[]; archived: Assessment[]; onCreate: () => void; onEdit: (item: Assessment) => void; onArchive: (id: string) => void; onRestore: (id: string) => void }) {
  const [showArchived, setShowArchived] = useState(false);
  const visibleAssessments = showArchived ? archived : assessments;
  return <>
    <PageHeader eyebrow="ENGAGEMENT MANAGEMENT" title="Assessments" description="Plan, scope, and track authorized security reviews." action={<button className="button primary" onClick={onCreate}><Plus size={16} /> New assessment</button>} />
    <div className="callout-blue"><ShieldCheck size={17} /><span><strong>Authorization comes first.</strong> Record the approved scope before any testing begins. TrustLens is a documentation platform and will not scan or contact your targets.</span></div>
    <div className="filter-row"><div className="assessment-tabs"><button className={!showArchived ? "selected" : ""} onClick={() => setShowArchived(false)}>Active <span>{assessments.length}</span></button><button className={showArchived ? "selected" : ""} onClick={() => setShowArchived(true)}>Archived <span>{archived.length}</span></button></div><div className="table-count">{visibleAssessments.length} assessments <span>·</span> <span>Sorted by recently updated</span></div><button className="button secondary compact" onClick={() => window.print()}><Download size={15} /> Export list</button></div>
    <div className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>ASSESSMENT</th><th>AUTHORIZED SCOPE</th><th>STATUS</th><th>APPROVAL</th><th>PROGRESS</th><th>TEAM</th><th></th></tr></thead><tbody>
      {visibleAssessments.map((assessment) => <tr key={assessment.id}>
        <td><button className="table-primary-link" onClick={() => onEdit(assessment)}>{assessment.name}</button><small>{assessment.organization} · {assessment.start} — {assessment.end}</small></td>
        <td><code className="scope-code">{assessment.scope}</code></td><td><span className={statusClass(assessment.status)}>{assessment.status}</span></td>
        <td><span className={`approval-label ${assessment.approval.toLowerCase().replaceAll(" ", "-")}`}><i />{assessment.approval}</span></td>
        <td><div className="table-progress"><div className="progress-track"><i style={{ width: `${assessment.progress}%` }} /></div><span>{assessment.progress}%</span></div></td>
        <td><div className="avatar-stack">{assessment.team.slice(0, 3).map((name, index) => <span key={name} className={`avatar avatar-${["violet", "blue", "teal"][index]}`} title={name}>{name.split(" ").map((part) => part[0]).join("")}</span>)}</div></td>
        <td><button className="icon-button quiet row-menu" title={showArchived ? "Restore assessment" : "Archive assessment"} onClick={() => showArchived ? onRestore(assessment.id) : window.confirm(`Archive "${assessment.name}"? You can restore it from the Archived tab.`) && onArchive(assessment.id)}>{showArchived ? <ArrowUpRight size={16} /> : <Archive size={16} />}</button></td>
      </tr>)}
      {visibleAssessments.length === 0 && <tr><td colSpan={7}><EmptyState title={showArchived ? "No archived assessments" : "No active assessments"} description={showArchived ? "Archived assessments will appear here." : "Create an assessment to start documenting an authorized review."} action={!showArchived ? <button className="button primary" onClick={onCreate}><Plus size={15} /> New assessment</button> : undefined} /></td></tr>}
    </tbody></table></div></div>
    <div className="bottom-note"><LockKeyhole size={15} /> Assessment status is a planning aid. Testing must remain within written authorization and the recorded scope.</div>
  </>;
}

function InputsPage({ inputs, assessments, manualTests, canRecordManualTest, search, setSearch, onAdd, onEdit, onRecordTest }: { inputs: InputPoint[]; assessments: Assessment[]; manualTests: ManualTestRecord[]; canRecordManualTest: boolean; search: string; setSearch: (value: string) => void; onAdd: () => void; onEdit: (input: InputPoint) => void; onRecordTest: (input: InputPoint) => void }) {
  const [reviewStatus, setReviewStatus] = useState("All review statuses");
  const matching = inputs.filter((item) => `${item.route} ${item.name} ${item.kind} ${item.notes}`.toLowerCase().includes(search.toLowerCase())
    && (reviewStatus === "All review statuses" || item.status === reviewStatus));
  const visibleInputIds = new Set(matching.map((item) => item.id));
  const matchingTests = manualTests.filter((item) => visibleInputIds.has(item.inputId));
  return <>
    <PageHeader eyebrow="MANUAL INVENTORY" title="Input points" description="Document where user-controlled values enter your authorized application." action={<button className="button primary" onClick={onAdd}><Plus size={16} /> Add input point</button>} />
    <div className="callout-blue subdued"><FileSearch size={17} /><span><strong>Manual documentation only.</strong> Record test observations from authorized manual checks. Templates are prompts only; TrustLens does not run tests or contact targets.</span></div>
    <div className="filter-row"><div className="search-control"><Search size={16} /><input placeholder="Search route, input name, notes..." value={search} onChange={(event) => setSearch(event.target.value)} /></div><select className="filter-select" aria-label="Filter input points by review status" value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value)}><option>All review statuses</option><option>Not reviewed</option><option>In review</option><option>Reviewed</option></select><span className="table-count">{matching.length} input points</span></div>
    <div className="panel table-panel"><div className="table-scroll"><table><thead><tr><th>PAGE OR ROUTE</th><th>INPUT NAME</th><th>TYPE</th><th>ASSESSMENT</th><th>REVIEW STATUS</th><th>EVIDENCE</th><th>MANUAL TESTS</th><th>REVIEWER NOTES</th><th></th></tr></thead><tbody>
      {matching.map((item) => {
        const assessment = assessments.find((record) => record.id === item.assessment);
        const assessmentReady = assessment?.status === "In Progress" && assessment.approval === "Approved" && assessment.approvedForTesting;
        const canRecord = canRecordManualTest && assessmentReady;
        const disabledReason = !canRecordManualTest ? "Only Analysts and Administrators can record manual tests" : "Requires an authorized In Progress assessment";
        return <tr key={item.id}><td><code className="route-code">{item.route}</code></td><td><strong className="input-name">{item.name}</strong></td><td><span className="type-pill">{item.kind}</span></td><td><span className="assessment-cell">{assessment?.organization ?? "Unassigned"}</span></td><td><span className={statusClass(item.status)}>{item.status}</span></td><td><span className="evidence-count"><FileText size={14} /> {item.evidence}</span></td><td><div className="manual-test-action"><span className="evidence-count">{manualTests.filter((test) => test.inputId === item.id).length} recorded</span><button className="button secondary compact" disabled={!canRecord} title={canRecord ? "Record a safe manual test observation" : disabledReason} onClick={() => onRecordTest(item)}>Record test</button></div></td><td><span className="notes-cell">{item.notes}</span></td><td><button className="icon-button quiet" title="Edit input point" onClick={() => onEdit(item)}><MoreHorizontal size={17} /></button></td></tr>;
      })}
      {matching.length === 0 && <tr><td colSpan={9}><EmptyState title="No matching input points" description="Try a different search or add a documented input point." action={<button className="button primary" onClick={onAdd}><Plus size={15} /> Add input point</button>} /></td></tr>}
    </tbody></table></div><div className="table-footer"><span>Showing {matching.length} of {inputs.length} input points</span><div><button disabled aria-label="Previous page"><ChevronLeft size={15} /></button><button className="current-page">1</button><button disabled aria-label="Next page"><ChevronRight size={15} /></button></div></div></div>
    <section className="panel manual-test-panel"><div className="panel-heading"><div><h2>Manual test observations</h2><p>Recorded expected vs. actual behavior; deviations do not confirm findings.</p></div><span className="type-pill">{matchingTests.length} record(s)</span></div>
      {matchingTests.length ? <div className="manual-test-list">{matchingTests.map((test) => <article className="manual-test-card" key={test.id}><div className="manual-test-card-top"><span className="type-pill">{test.category}</span><span className={`status ${statusClass(test.result)}`}>{test.result}</span><small>{inputLabel(inputs.find((item) => item.id === test.inputId))} · {new Date(test.recordedAt).toLocaleString()}</small></div><p><strong>Test:</strong> {test.description}</p><p><strong>Expected:</strong> {test.expectedBehavior}</p><p><strong>Observed:</strong> {test.actualBehavior}</p>{test.evidenceReference && <p><strong>Evidence:</strong> {test.evidenceReference}</p>}</article>)}</div>
        : <EmptyState title="No manual test records" description="Select Record test on an input point in an authorized In Progress assessment." />}
    </section>
  </>;
}

function FindingsPage({ findings, inputs, search, setSearch, severity, setSeverity, validation, setValidation, onAdd, onSelect }: { findings: Finding[]; inputs: InputPoint[]; search: string; setSearch: (value: string) => void; severity: string; setSeverity: (value: string) => void; validation: string; setValidation: (value: string) => void; onAdd: () => void; onSelect: (finding: Finding) => void }) {
  return <>
    <PageHeader eyebrow="ASSESSMENT RESULTS" title="Findings" description="Review observations, evidence, and defensive recommendations." action={<button className="button primary" onClick={onAdd}><Plus size={15} /> Record finding</button>} />
    <div className="callout-amber"><AlertCircle size={17} /><span><strong>Human validation required.</strong> Suspected observations are not confirmed vulnerabilities. Review the linked evidence and context before reaching a conclusion.</span></div>
    <div className="finding-summary-cards">{severityOrder.slice(0, 4).map((item) => <div className="summary-chip" key={item}><i className={`legend-dot dot-${item.toLowerCase()}`} /><span>{item}</span><strong>{findings.filter((finding) => finding.severity === item).length}</strong></div>)}<div className="summary-chip awaiting-chip"><Clock3 size={15} /><span>Awaiting review</span><strong>{findings.filter((finding) => finding.validation === "Suspected").length}</strong></div></div>
    <div className="filter-row findings-filters"><div className="search-control"><Search size={16} /><input placeholder="Search findings..." value={search} onChange={(event) => setSearch(event.target.value)} /></div><select className="filter-select" value={severity} onChange={(event) => setSeverity(event.target.value)}><option>All severities</option>{severityOrder.map((item) => <option key={item}>{item}</option>)}</select><select className="filter-select" value={validation} onChange={(event) => setValidation(event.target.value)}><option>All statuses</option><option>Confirmed</option><option>Suspected</option><option>False Positive</option></select><span className="table-count">{findings.length} results</span></div>
    <div className="panel table-panel findings-table"><div className="table-scroll"><table><thead><tr><th>FINDING</th><th>SEVERITY</th><th>CONFIDENCE</th><th>VALIDATION</th><th>AFFECTED INPUT</th><th>EVIDENCE</th><th>REVIEWER</th><th>UPDATED</th></tr></thead><tbody>
      {findings.map((finding) => <tr key={finding.id} className="clickable-row" onClick={() => onSelect(finding)}><td><button className="table-primary-link" onClick={() => onSelect(finding)}>{finding.title}</button><small>{finding.id} · {finding.category}</small></td><td><span className={severityClass(finding.severity)}><i />{finding.severity}</span></td><td><div className="confidence-cell"><div className="progress-track"><i style={{ width: `${finding.confidence}%` }} /></div><span>{finding.confidence}%</span></div></td><td><span className={statusClass(finding.validation)}>{finding.validation}</span></td><td><code className="route-code">{inputLabel(inputs.find((input) => input.id === finding.inputId))}</code></td><td><span className="evidence-count"><FileText size={14} /> {finding.evidence.length}</span></td><td>{finding.reviewer}</td><td className="muted-cell">{finding.updated}</td></tr>)}
      {findings.length === 0 && <tr><td colSpan={8}><EmptyState title="No findings match these filters" description="Adjust your search or filters to see more results." /></td></tr>}
    </tbody></table></div><div className="table-footer"><span>Showing {findings.length} saved finding(s)</span><div><button disabled><ChevronLeft size={15} /></button><button className="current-page">1</button><button disabled><ChevronRight size={15} /></button></div></div></div>
  </>;
}

function FindingDrawer({ finding, inputs, evidence, canReview, onClose, onConfirm, onFalsePositive }: { finding: Finding; inputs: InputPoint[]; evidence: Evidence[]; canReview: boolean; onClose: () => void; onConfirm: () => void; onFalsePositive: () => void }) {
  const linkedEvidence = evidence.filter((item) => finding.evidence.includes(item.id));
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="finding-drawer">
    <div className="drawer-top"><div><span className="eyebrow">FINDING DETAIL · {finding.id}</span><span className={statusClass(finding.validation)}>{finding.validation}</span></div><button className="icon-button" onClick={onClose} aria-label="Close finding detail"><X size={18} /></button></div>
    <h2>{finding.title}</h2><p className="drawer-subtitle">{finding.category} <i /> Updated {finding.updated}</p>
    <div className="drawer-tags"><span className={severityClass(finding.severity)}><i />{finding.severity} severity</span><span className="type-pill">Confidence {finding.confidence}%</span></div>
    {finding.validation === "Suspected" && <div className="callout-amber drawer-callout"><AlertCircle size={16} /><span><strong>Conclusion not yet validated.</strong> Confirm only after personally reviewing supporting evidence.</span></div>}
    <div className="drawer-section"><h3>What was observed</h3><p>{finding.description}</p></div>
    <div className="drawer-section"><h3>Potential impact</h3><p>{finding.impact}</p></div>
    <div className="drawer-section"><h3>Affected input point</h3><div className="linked-input"><Target size={16} /><span><strong>{inputLabel(inputs.find((item) => item.id === finding.inputId))}</strong><small>Documented input · manual review</small></span></div></div>
    <div className="drawer-section"><h3>Evidence ({linkedEvidence.length})</h3>{linkedEvidence.length ? <div className="drawer-evidence-list">{linkedEvidence.map((item) => <div className="drawer-evidence" key={item.id}><span className="evidence-type-icon"><FileText size={15} /></span><span><strong>{item.title}</strong><small>{item.kind} · {item.date} · {item.redacted ? "Redacted" : "Review redaction"}</small><p>{item.notes}</p>{item.reference && <code>Screenshot reference: {item.reference}</code>}{item.request && <code>{item.request}</code>}{item.response && <code>{item.response}</code>}</span></div>)}</div> : <p>No linked evidence has been recorded.</p>}</div>
    <div className="drawer-section"><h3>Recommended remediation</h3><div className="remediation-note"><BookOpenCheck size={16} /><p>{finding.remediation}</p></div></div>
    <div className="drawer-section conclusion-step"><h3>Evidence → conclusion</h3><p>Review the observation, evidence excerpts, and affected context. The final conclusion belongs to the human reviewer.</p><div className="reviewer-line"><span className="avatar avatar-violet">MC</span><span><strong>Reviewed by {finding.reviewer}</strong><small>Last updated {finding.updated}</small></span></div></div>
    <div className="drawer-actions">{canReview && finding.validation !== "Confirmed" && <button className="button primary full-button" onClick={onConfirm}><Check size={16} /> Human review & confirm</button>}{canReview && finding.validation !== "False Positive" && <button className="button secondary full-button" onClick={onFalsePositive}>Mark false positive after review</button>}{!canReview && <p className="form-hint">Only a Reviewer or Administrator can record a review conclusion.</p>}{finding.validation === "False Positive" && <p className="form-hint">This observation was reviewed and marked a false positive.</p>}</div>
  </aside></div>;
}

function EvidencePage({ evidence, inputs, findings, onAdd, onNotify }: { evidence: Evidence[]; inputs: InputPoint[]; findings: Finding[]; onAdd: () => void; onNotify: (message: string) => void }) {
  return <>
    <PageHeader eyebrow="EVIDENCE REGISTER" title="Evidence" description="Keep observations traceable, sanitized, and linked to a review conclusion." action={<button className="button primary" onClick={onAdd}><Plus size={16} /> Record evidence</button>} />
    <div className="warning-box evidence-warning"><AlertCircle size={18} /><span><strong>Protect sensitive information.</strong> Never store passwords, access tokens, API keys, or customer personal information. Sanitize excerpts before adding them to this workspace.</span></div>
    <div className="evidence-stats"><div><span className="metric-icon blue"><FileText size={16} /></span><span><strong>{evidence.length}</strong><small>Evidence records</small></span></div><div><span className="metric-icon green"><ShieldCheck size={16} /></span><span><strong>{evidence.filter((item) => item.redacted).length}</strong><small>Redaction confirmed</small></span></div><div><span className="metric-icon teal"><LinkIcon /></span><span><strong>{new Set(evidence.map((item) => item.findingId)).size}</strong><small>Findings supported</small></span></div></div>
    <div className="panel evidence-panel"><div className="panel-heading evidence-panel-heading"><div><h2>Evidence records</h2><p>Sanitized, user-entered observations linked to saved findings</p></div><button className="button secondary compact" onClick={() => window.print()}><Download size={15} /> Export</button></div>
      <div className="evidence-list">{evidence.map((item) => <article className="evidence-card" key={item.id}><div className="evidence-card-icon"><FileText size={17} /></div><div className="evidence-card-body"><div className="evidence-card-title"><h3>{item.title}</h3><span className="redacted-badge"><ShieldCheck size={13} /> Redacted</span></div><div className="evidence-meta"><span>{item.kind}</span><i /><span>{item.date}</span><i /><span>{inputLabel(inputs.find((input) => input.id === item.inputId))}</span></div><p>{item.notes}</p><div className="excerpt-grid">{item.reference && <div><small>SCREENSHOT REFERENCE</small><code>{item.reference}</code></div>}<div><small>REQUEST EXCERPT</small><code>{item.request}</code></div><div><small>RESPONSE EXCERPT</small><code>{item.response}</code></div></div><div className="evidence-link"><span><LinkIcon /> Linked finding</span><button onClick={() => onNotify(`Finding ${item.findingId} is linked to this evidence record.`)}>{findings.find((finding) => finding.id === item.findingId)?.id ?? item.findingId} <ArrowUpRight size={13} /></button><span className="evidence-date"><Clock3 size={12} /> Observed {item.date}</span></div></div><button className="icon-button quiet evidence-more" aria-label="Evidence record is saved" title="Saved in the assessment database"><MoreHorizontal size={17} /></button></article>)}
      {evidence.length === 0 && <EmptyState title="No evidence recorded" description="Add sanitized observations and excerpts to support your assessment conclusions." action={<button className="button primary" onClick={onAdd}><Plus size={15} /> Record evidence</button>} />}</div>
    </div>
  </>;
}

function LinkIcon() { return <ArrowUpRight size={15} />; }

function AIAnalysis({ findings, inputs, evidence, manualTests, selected, onSelect }: { findings: Finding[]; inputs: InputPoint[]; evidence: Evidence[]; manualTests: ManualTestRecord[]; selected: string; onSelect: (id: string) => void }) {
  const finding = findings.find((item) => item.id === selected) ?? findings[0];
  const linked = finding ? evidence.filter((item) => finding.evidence.includes(item.id)) : [];
  const redactedEvidence = linked.filter((item) => item.redacted);
  const tests = finding ? manualTests.filter((item) => item.inputId === finding.inputId) : [];
  const hasContext = redactedEvidence.length > 0 || tests.length > 0;
  const [providerConnected, setProviderConnected] = useState<boolean | null>(null);
  const [statusError, setStatusError] = useState("");
  const [analysis, setAnalysis] = useState<AIAnalysisResult | null>(null);
  const [resultMode, setResultMode] = useState<"ai" | "simulated" | null>(null);
  const [analysisError, setAnalysisError] = useState("");
  const [loading, setLoading] = useState(false);
  const [confirmSanitized, setConfirmSanitized] = useState(false);
  useEffect(() => {
    let active = true;
    getAIStatus().then((status) => {
      if (active) setProviderConnected(status.connected);
    }).catch((error: unknown) => {
      if (active) setStatusError(error instanceof Error ? error.message : "Could not check AI provider status.");
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    setAnalysis(null);
    setResultMode(null);
    setAnalysisError("");
    setConfirmSanitized(false);
  }, [selected]);
  const generateAnalysis = async () => {
    if (!finding || !hasContext) return;
    setAnalysisError("");
    if (providerConnected && !confirmSanitized) {
      setAnalysisError("Review and confirm the selected records are safe to send before requesting AI analysis.");
      return;
    }
    setLoading(true);
    try {
      const response = await analyzeFinding(finding.id, confirmSanitized);
      setAnalysis(response.analysis);
      setResultMode(response.mode);
    } catch (error) {
      setAnalysisError(error instanceof Error ? error.message : "AI analysis failed. Try again.");
    } finally {
      setLoading(false);
    }
  };
  const demoHypothesis = tests.some((item) => item.result === "Deviation observed")
    ? "A recorded deviation means the observed behavior differed from the stated expectation. One possible explanation is a mismatch in validation rules or application behavior; compare it with the written requirements and relevant server-side code before drawing a security conclusion."
    : "The saved records do not show a test marked “Deviation observed.” No vulnerability hypothesis is supported by these observations alone. Review the expected behavior and authorized application context.";
  const generated = resultMode !== null;
  return <>
    <PageHeader eyebrow="ASSISTED REVIEW" title="AI analysis" description="Explore evidence-backed explanations to support — not replace — human review." />
    <div className="ai-disclosure"><Sparkles size={18} /><div><strong>{providerConnected ? "AI provider connected" : providerConnected === false ? "AI is not connected · Demo mode available" : "Checking AI provider status"}</strong><span>{providerConnected ? "Selected finding context is sent securely from Django after your redaction confirmation. AI output is advisory only and cannot change findings or reports." : providerConnected === false ? "No backend AI key is configured. The existing simulated analysis remains available and is clearly labeled; no provider request will be made." : statusError || "Checking the backend provider configuration."}</span></div><span className="demo-tag">{providerConnected ? "CONNECTED" : providerConnected === false ? "SIMULATED" : "STATUS"}</span></div>
    <div className="ai-layout">
      <section className="panel ai-input-panel"><div className="panel-heading"><div><h2>Analysis context</h2><p>Choose a finding and inspect its input-point observations.</p></div></div>
        <label className="field">Select an existing finding<select value={finding?.id ?? ""} onChange={(event) => onSelect(event.target.value)}>{findings.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.title}</option>)}</select></label>
        {finding ? <><div className="selected-finding-card"><span className={severityClass(finding.severity)}><i />{finding.severity}</span><h3>{finding.title}</h3><p>{finding.description}</p><div className="selected-meta"><span>{finding.category}</span><span>Confidence {finding.confidence}%</span><span>{finding.validation}</span></div></div>
          <div className="context-block"><h3><Target size={15} /> Manual test observations <span>{tests.length}</span></h3>{tests.length ? tests.map((item) => <div className="context-evidence" key={item.id}><strong>{item.category} · {item.result}</strong><small>Recorded {new Date(item.recordedAt).toLocaleString()} by {item.recordedBy}</small><p><b>Expected:</b> {item.expectedBehavior}</p><p><b>Observed:</b> {item.actualBehavior}</p>{item.evidenceReference && <code>Evidence reference: {item.evidenceReference}</code>}</div>) : <p className="empty-context">No manual test observations are recorded for this input point.</p>}</div>
          <div className="context-block"><h3><FileText size={15} /> Linked evidence <span>{linked.length}</span></h3>{linked.length ? linked.map((item) => <div className="context-evidence" key={item.id}><strong>{item.title}</strong><small>{item.redacted ? "Redaction confirmed · " : "Not sent to AI · redaction not confirmed · "}{item.date}</small><p>{item.notes}</p>{item.reproductionSteps && <p><b>Steps:</b> {item.reproductionSteps}</p>}{item.request && <code>{item.request}</code>}{item.response && <code>{item.response}</code>}</div>) : <p className="empty-context">No evidence records are linked to this finding.</p>}</div>
          {providerConnected && <label className="ai-consent"><input type="checkbox" checked={confirmSanitized} onChange={(event) => setConfirmSanitized(event.target.checked)} /><span>I reviewed the selected finding and observations and confirm they contain no passwords, access tokens, API keys, or customer/personal information. Send the sanitized context to the configured AI provider.</span></label>}
          {analysisError && <div className="auth-error ai-error"><AlertCircle size={15} /><span>{analysisError}</span></div>}
          <button className="button primary full-button" disabled={!hasContext || providerConnected === null || loading || Boolean(statusError)} onClick={generateAnalysis}><Sparkles size={16} /> {loading ? "Analyzing recorded context…" : generated ? "Refresh analysis" : providerConnected ? "Analyze with configured AI" : "Summarize recorded observations"}</button>
          {!hasContext && <p className="form-hint">Record a manual test or link evidence to this finding's input point before analysis.</p>}
        </> : <EmptyState title="No findings available" description="Add an assessment finding before analysis." />}
      </section>
      <section className="panel ai-output-panel"><div className="panel-heading"><div><h2>Analysis output</h2><p>Structured response for analyst review</p></div><span className="simulated-status"><i /> {resultMode === "ai" ? "AI-GENERATED" : resultMode === "simulated" ? "SIMULATED" : "READY"}</span></div>
        {!generated ? <div className="ai-empty"><span className="ai-empty-icon"><Sparkles size={22} /></span><h3>Ready when you are</h3><p>Review the recorded manual observations and linked evidence, then summarize that material.</p><div className="ai-output-list">{["Observed facts from saved records", "Clearly labeled hypotheses and uncertainty", "Defensive remediation guidance", "Human review remains required"].map((label) => <span key={label}><Check size={14} />{label}</span>)}</div></div> :
          <div className="ai-response"><div className="ai-response-intro"><span><Sparkles size={16} /></span><p><strong>{resultMode === "ai" ? "AI-generated analysis · advisory only" : "Demo AI output · simulated summary"}</strong><small>Context: {tests.length} manual test(s), {redactedEvidence.length} redaction-confirmed evidence record(s) for {inputLabel(inputs.find((item) => item.id === finding?.inputId))}. No independent verification.</small></p></div>
            {resultMode === "ai" && analysis ? <>
              <ResponseBlock number="01" title="Observed facts"><ul>{analysis.observed_facts.map((item, index) => <li key={index}>{item}</li>)}</ul></ResponseBlock>
              <ResponseBlock number="02" title="Possible interpretation — hypothesis"><p>{analysis.possible_interpretation}</p></ResponseBlock>
              <ResponseBlock number="03" title="Confidence & uncertainty"><p>{analysis.confidence_uncertainty}</p><p>Current human review status: {finding.validation}. This analysis cannot change it.</p></ResponseBlock>
              <ResponseBlock number="04" title="Potential impact"><p>{analysis.potential_impact}</p></ResponseBlock>
              <ResponseBlock number="05" title="Recommended remediation"><p>{analysis.recommended_remediation}</p></ResponseBlock>
              <ResponseBlock number="06" title="Safe verification steps"><ul>{analysis.safe_verification_steps.map((item, index) => <li key={index}>{item}</li>)}</ul></ResponseBlock>
              <ResponseBlock number="07" title="Missing evidence"><ul>{analysis.missing_evidence.map((item, index) => <li key={index}>{item}</li>)}</ul></ResponseBlock>
              <div className="output-caveat"><AlertCircle size={15} /><span>{analysis.disclaimer} A Reviewer must make the final decision.</span></div>
            </> : <>
              <ResponseBlock number="01" title="Observed facts"><ul>{tests.map((item) => <li key={item.id}><strong>{item.category} — {item.result}.</strong> Expected: {item.expectedBehavior} Observed: {item.actualBehavior}</li>)}{redactedEvidence.map((item) => <li key={item.id}><strong>{item.title} ({item.date}).</strong> {item.notes}</li>)}</ul></ResponseBlock>
              <ResponseBlock number="02" title="Hypotheses — not verified"><p>{demoHypothesis}</p></ResponseBlock>
              <ResponseBlock number="03" title="Uncertainty & current finding status"><p>These are user-entered records and have not been independently reproduced. “{finding.validation}” is the existing human review status; this summary does not change it. Severity ({finding.severity}) and confidence ({finding.confidence}%) are analyst-entered values, not an independent assessment.</p></ResponseBlock>
              <ResponseBlock number="04" title="Potential impact"><p>{finding.impact ? `Analyst-entered potential impact: ${finding.impact} This impact has not been established by the stored test records.` : "No potential impact has been documented on this finding. Impact remains undetermined from the available records."}</p></ResponseBlock>
              <ResponseBlock number="05" title="Recommended defensive fix"><p>{finding.remediation || "Review the documented requirements and implement server-side validation for required values, whitespace handling, length limits, and format. Encode output for its intended context where applicable. Verify the fix manually with benign data within written authorization."}</p></ResponseBlock>
              <ResponseBlock number="06" title="Retesting checklist"><ul><li>Confirm written authorization and the exact in-scope environment.</li><li>Compare expected and actual behavior with the documented requirements.</li><li>After remediation, repeat the same manual check using benign, non-sensitive values.</li><li>Record sanitized observations and supporting evidence; do not infer unobserved results.</li><li>Leave the conclusion Suspected until a Reviewer independently reviews evidence and records a decision.</li></ul></ResponseBlock>
              <ResponseBlock number="07" title="Missing evidence"><ul><li>Independent reproduction and reviewer assessment are still required.</li></ul></ResponseBlock>
              <div className="output-caveat"><AlertCircle size={15} /><span>This is simulated text, not an AI verdict. No test was run by TrustLens; findings are never auto-confirmed.</span></div>
            </>}
          </div>}
      </section>
    </div>
    <div className="architecture-note"><LockKeyhole size={15} /><span><strong>Human review required:</strong> AI output is advisory and never confirms findings, changes severity or scope, or submits reports. Only a Reviewer can record the final finding decision.</span></div>
  </>;
}

function ResponseBlock({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return <section className="response-block"><span>{number}</span><div><h3>{title}</h3>{children}</div></section>;
}

function ReportsPage({ assessments, inputs, findings, evidence, manualTests, reports, canSubmitReport, onSubmit }: { assessments: Assessment[]; inputs: InputPoint[]; findings: Finding[]; evidence: Evidence[]; manualTests: ManualTestRecord[]; reports: ReportRecord[]; canSubmitReport: boolean; onSubmit: (assessmentId: string) => void }) {
  const available = assessments.filter((item) => !item.archived);
  const [assessmentId, setAssessmentId] = useState(available[0]?.id ?? "");
  useEffect(() => {
    if (!available.some((item) => item.id === assessmentId)) setAssessmentId(available[0]?.id ?? "");
  }, [available, assessmentId]);
  const selected = available.find((item) => item.id === assessmentId);
  const scopedFindings = findings.filter((finding) => finding.assessment === assessmentId);
  const scopedTests = manualTests.filter((item) => item.assessment === assessmentId);
  const scopedEvidence = evidence.filter((item) => scopedFindings.some((finding) => finding.id === item.findingId));
  const latestReport = reports.find((report) => report.assessment === assessmentId);
  const suspected = scopedFindings.filter((finding) => finding.validation === "Suspected").length;
  const canSubmit = !!selected && selected.approval === "Approved" && selected.approvedForTesting
    && ["Under Review", "Completed"].includes(selected.status)
    && suspected === 0 && scopedEvidence.every((item) => item.redacted);
  return <>
    <PageHeader eyebrow="REPORT BUILDER" title="Reports" description="Submit a reviewed assessment and download its versioned PDF report." />
    <div className="report-toolbar"><div><span className="toolbar-label">ASSESSMENT</span><select className="filter-select" value={assessmentId} onChange={(event) => setAssessmentId(event.target.value)}><option value="">Choose assessment</option>{available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><span className="demo-tag">DATABASE-BACKED REPORT</span></div>
    {!selected ? <div className="panel"><EmptyState title="No assessment selected" description="Create an assessment and record its scope before building a report." /></div> : <>
      <div className="submission-panel panel">
        <div><h2>Final report submission</h2><p>Submitting captures an immutable report snapshot, marks the assessment Completed, and downloads a PDF.</p></div>
        <div className="submission-checks">
          <span className={selected.approval === "Approved" && selected.approvedForTesting ? "check-pass" : "check-pending"}><i />Written scope approval and authorization</span>
          <span className={["Under Review", "Completed"].includes(selected.status) ? "check-pass" : "check-pending"}><i />Assessment moved to Under Review</span>
          <span className={suspected === 0 ? "check-pass" : "check-pending"}><i />{suspected === 0 ? "All findings reviewed" : `${suspected} finding(s) awaiting reviewer decision`}</span>
          <span>{scopedEvidence.every((item) => item.redacted) ? "check-pass" : "check-pending"}<i />Evidence redaction confirmed</span>
        </div>
        {latestReport && <div className="submitted-report"><CheckCircle2 size={15} /><span><strong>Submitted {new Date(latestReport.submittedAt).toLocaleString()}</strong><small>by {latestReport.submittedBy} · PDF is generated from this saved snapshot</small></span><button className="button secondary compact" onClick={() => downloadReport(latestReport.id, latestReport.assessment).catch((error) => window.alert(error instanceof Error ? error.message : "Report download failed."))}><FileDown size={14} /> Download PDF</button></div>}
        <div className="submission-actions"><span>{canSubmitReport ? canSubmit ? "Ready to submit a report snapshot." : "Resolve the checklist items above before submitting." : "Only a Reviewer or Administrator can submit the final report."}</span><button className="button primary" disabled={!canSubmit || !canSubmitReport} onClick={() => onSubmit(selected.id)}><FileDown size={15} /> Submit & download PDF</button></div>
      </div>
      <article className="report-document">
        <div className="report-cover"><div className="report-brand"><span className="brand-mark"><ShieldCheck size={19} /></span><strong>trustlens<span>ai</span></strong></div><span className="report-draft">{latestReport ? "SUBMITTED SNAPSHOT AVAILABLE" : "REPORT PREVIEW · NOT SUBMITTED"}</span><h2>{selected.organization}<br />Security assessment</h2><p>{selected.name}</p><div className="report-cover-meta"><span><small>ASSESSMENT PERIOD</small>{selected.start} — {selected.end}</span><span><small>AUTHORIZED SCOPE</small>{selected.scope}</span><span><small>STATUS</small>{latestReport ? "Submitted" : selected.status}</span></div></div>
        <div className="report-banner"><AlertCircle size={16} /><span><strong>Scope and authorization are team-entered fields.</strong> TrustLens stores this declaration but does not independently verify written permission. No target is scanned or contacted.</span></div>
        <ReportSection number="01" title="Executive summary"><p>This report records {scopedFindings.length} finding(s) from the {selected.name} assessment for {selected.organization}. Findings and evidence reflect analyst-entered information; this summary does not independently validate results.</p><div className="report-stat-row">{severityOrder.map((severity) => <div key={severity}><i className={`legend-dot dot-${severity.toLowerCase()}`} /><strong>{scopedFindings.filter((item) => item.severity === severity).length}</strong><span>{severity}</span></div>)}</div></ReportSection>
        <ReportSection number="02" title="Scope & authorization"><p><strong>Organization:</strong> {selected.organization}<br /><strong>Authorized target scope:</strong> {selected.scope}<br /><strong>Approval status:</strong> {selected.approval} · {selected.approvedForTesting ? "team confirmation recorded" : "confirmation not recorded"}<br /><strong>Assessment period:</strong> {selected.start} through {selected.end}</p><p className="report-subtle">Scope approval and authorization are recorded declarations, not independently verified by this platform.</p></ReportSection>
        <ReportSection number="03" title="Methodology & limitations"><p>Manual documentation of input points, findings, and sanitized evidence provided by the assessment team. No automated scanning, crawling, exploit testing, or target interaction is performed by TrustLens.</p><p><strong>Assessment notes and limitations:</strong> {selected.notes || "No additional limitations recorded."}</p></ReportSection>
        <ReportSection number="04" title="Findings summary by severity">{severityOrder.map((severity) => <p key={severity}><strong>{severity}:</strong> {scopedFindings.filter((item) => item.severity === severity).length}</p>)}</ReportSection>
        <ReportSection number="05" title="Detailed findings & evidence">{scopedFindings.length ? scopedFindings.map((finding) => <div className="report-detailed-finding" key={finding.id}><h3>{finding.title}</h3><p><strong>Category / severity / validation:</strong> {finding.category} · {finding.severity} · {finding.validation}</p><p><strong>Affected input:</strong> {inputLabel(inputs.find((item) => item.id === finding.inputId))}</p><p><strong>Observed behavior:</strong> {finding.description}</p><p><strong>Potential impact:</strong> {finding.impact || "Not recorded"}</p><p><strong>Confidence:</strong> {finding.confidence}% · <strong>Reviewer:</strong> {finding.reviewer}</p><p><strong>Evidence references:</strong> {evidence.filter((item) => finding.evidence.includes(item.id)).map((item) => `${item.title} (${item.date})`).join("; ") || "No linked evidence"}</p>{evidence.filter((item) => finding.evidence.includes(item.id)).map((item) => <p key={item.id}><strong>{item.title}:</strong> {item.notes}<br />{item.reproductionSteps && <>Steps: {item.reproductionSteps}<br /></>}{item.reference && <>Screenshot reference: {item.reference}<br /></>}Request: {item.request}<br />Response: {item.response}</p>)}</div>) : <p>No findings were recorded for this assessment.</p>}</ReportSection>
        <ReportSection number="06" title="Manual input test records">{scopedTests.length ? scopedTests.map((test) => <div className="report-detailed-finding" key={test.id}><h3>{test.category} · {test.result}</h3><p><strong>Input:</strong> {inputLabel(inputs.find((item) => item.id === test.inputId))}</p><p><strong>Test:</strong> {test.description}</p><p><strong>Expected:</strong> {test.expectedBehavior}</p><p><strong>Observed:</strong> {test.actualBehavior}</p>{test.evidenceReference && <p><strong>Evidence reference:</strong> {test.evidenceReference}</p>}</div>) : <p>No manual test observations were recorded.</p>}<p className="report-subtle">Manual results are user-entered observations and do not automatically validate or confirm findings.</p></ReportSection>
        <ReportSection number="07" title="Remediation recommendations">{scopedFindings.length ? scopedFindings.map((finding) => <div className="report-remediation" key={finding.id}><strong>{finding.title}</strong><p>{finding.remediation || "No remediation recommendation recorded."}</p></div>) : <p>No recommendations recorded.</p>}</ReportSection>
        <ReportSection number="08" title="AI usage disclosure"><p>AI analysis may be generated through an optional configured provider. Any AI output is advisory, requires human review, and is not included in this report snapshot.</p></ReportSection>
        <ReportSection number="09" title="Retesting plan"><ol><li>Reconfirm written authorization and the exact in-scope environment.</li><li>Review each finding and linked sanitized evidence.</li><li>Verify remediation in a controlled, authorized environment using benign test data.</li><li>Record retest evidence and have a reviewer independently validate the outcome.</li></ol></ReportSection>
        <div className="report-footer"><span><ShieldCheck size={15} /> TrustLens AI · Assessment workspace</span><span>Confidential · {latestReport ? "Submitted snapshot" : "Preview only"}</span></div>
      </article>
    </>}
  </>;
}

function ReportSection({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return <section className="report-section"><span className="report-section-number">{number}</span><div><h3>{title}</h3>{children}</div></section>;
}

function TeamPage({ team, activity, assessments, user, onNotify }: { team: TeamRecord[]; activity: ActivityRecord[]; assessments: Assessment[]; user: WorkspaceUser; onNotify: (message: string) => void }) {
  return <>
    <PageHeader eyebrow="COLLABORATION" title="Team & activity" description="Workspace accounts, responsibilities, and saved review activity." action={user.role === "Administrator" && <div className="team-admin-actions"><a className="button secondary compact" href="/admin/auth/user/add/" target="_blank" rel="noreferrer"><Plus size={14} /> Add account</a><a className="button secondary compact" href="/admin/assessments/membership/" target="_blank" rel="noreferrer"><Settings size={14} /> Manage roles</a></div>} />
    <div className="role-info"><Users size={17} /><span><strong>Server-enforced roles</strong> · Administrators manage accounts, Analysts document assessments, and Reviewers record independent conclusions. Set account roles in Django Admin.</span></div>
    <div className="team-card-grid">{team.map((member, index) => <article className="panel member-card" key={member.username}><div className="member-card-top"><span className={`avatar avatar-large avatar-${["violet", "blue", "teal", "amber"][index % 4]}`}>{member.initials}</span><button className="icon-button quiet" onClick={() => onNotify(`${member.name} · ${member.role} · ${member.username}`)} aria-label={`Details for ${member.name}`}><MoreHorizontal size={17} /></button></div><h3>{member.name}</h3><span className="role-badge">{member.role}</span><div className="member-divider" /><div className="member-detail"><span>Assigned assessments</span><strong>{assessments.filter((item) => item.team.includes(member.name)).length}</strong></div><div className="member-detail"><span>Review permission</span><span className={`review-state ${member.role === "Reviewer" || member.role === "Administrator" ? "available" : ""}`}><i />{member.role === "Reviewer" || member.role === "Administrator" ? "Enabled" : "Analyst"}</span></div><p className="member-activity"><Activity size={13} /> Active workspace account</p></article>)}</div>
    {team.length === 0 && <div className="panel"><EmptyState title="No workspace members" description="Create an account in Django Admin to invite a teammate." /></div>}
    <div className="panel activity-full"><div className="panel-heading"><div><h2>Workspace activity</h2><p>Persisted updates across this workspace</p></div><button className="button secondary compact" onClick={() => onNotify("Activity is recorded automatically for assessment changes.")}><Activity size={15} /> Activity log</button></div>
      {activity.map((item) => <div className="full-activity-row" key={item.id}><span className="activity-date">{new Date(item.createdAt).toLocaleDateString()}</span><span className="avatar avatar-blue">{item.actor.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</span><div><p><strong>{item.actor}</strong> {item.action} <b>{item.subject}</b></p><span className="activity-tag">{new Date(item.createdAt).toLocaleTimeString()}</span></div><Clock3 size={14} className="activity-clock" /></div>)}
      {activity.length === 0 && <EmptyState title="No activity recorded" description="Updates will be recorded as you work." />}
    </div>
  </>;
}

function SettingsPage({ user }: { user: WorkspaceUser }) {
  return <>
    <PageHeader eyebrow="WORKSPACE CONFIGURATION" title="Settings" description="Account access, persistence, and safety boundaries for this workspace." />
    <div className="settings-content">
      <section className="panel settings-panel"><div className="settings-title"><div><h2>Signed-in account</h2><p>Your identity and permissions are enforced by the backend.</p></div><span className="role-badge">{user.role}</span></div><div className="settings-field-grid"><label className="field">Name<input value={user.name} readOnly /></label><label className="field">Username<input value={user.username} readOnly /></label><label className="field wide">Workspace<input value="TrustLens AI" readOnly /></label></div></section>
      <section className="panel settings-panel"><div className="settings-title"><div><h2>Accounts and roles</h2><p>New self-registered accounts are Analysts. A superuser must assign Reviewer or Administrator roles.</p></div></div><div className="settings-action"><span>Manage user accounts and TrustLens memberships in the protected Django Admin.</span>{user.role === "Administrator" && <div className="settings-links"><a className="button secondary compact" href="/admin/auth/user/" target="_blank" rel="noreferrer"><Users size={14} /> Manage accounts</a><a className="button secondary compact" href="/admin/assessments/membership/" target="_blank" rel="noreferrer"><Settings size={14} /> Manage roles</a></div>}</div></section>
      <section className="panel settings-panel"><div className="settings-title"><div><h2>Connected services</h2><p>Only features that are actually configured are shown as available.</p></div></div><div className="member-detail"><span>Persistent records</span><span className="review-state available"><i /> Backend database</span></div><div className="member-detail"><span>PDF report generation</span><span className="review-state available"><i /> Available</span></div><div className="member-detail"><span>AI provider</span><span className="review-state"><i /> Optional · check current status in AI Analysis</span></div><div className="member-detail"><span>Target scanning</span><span className="review-state"><i /> Disabled</span></div></section>
      <div className="settings-footnote"><ShieldCheck size={16} /><span><strong>Safety boundary</strong> · TrustLens stores manually entered evidence and reports only. It does not scan, crawl, or contact authorized targets. Never store passwords, access tokens, API keys, or personal information in evidence.</span></div>
    </div>
  </>;
}

function LoginPage({ error, onSubmit }: { error: string; onSubmit: (username: string, password: string, confirmPassword: string, registering: boolean) => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [registering, setRegistering] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    await onSubmit(username, password, confirmPassword, registering);
    setSubmitting(false);
  };
  return <main className="auth-screen"><section className="auth-card">
    <div className="auth-brand"><span className="brand-mark"><ShieldCheck size={22} /></span><span><strong>trustlens<span>ai</span></strong><small>SECURITY WORKSPACE</small></span></div>
    <div className="auth-heading"><span className="eyebrow">PRIVATE ASSESSMENT WORKSPACE</span><h1>{registering ? "Create your account" : "Welcome back"}</h1><p>{registering ? "Create an Analyst account to start documenting authorized assessments." : "Sign in to manage authorized assessments and reports."}</p></div>
    {error && <div className="auth-error"><AlertCircle size={16} /><span>{error}</span></div>}
    <form className="auth-form" onSubmit={submit}><label className="field">Username<input autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} /></label><label className="field">Password<input type="password" autoComplete={registering ? "new-password" : "current-password"} minLength={registering ? 8 : undefined} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>{registering && <label className="field">Confirm password<input type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>}<button className="button primary" type="submit" disabled={submitting}>{submitting ? "Please wait…" : registering ? "Create Analyst account" : "Sign in securely"}</button></form>
    <button className="auth-toggle" type="button" disabled={submitting} onClick={() => { setRegistering(!registering); setPassword(""); setConfirmPassword(""); }}>{registering ? "Already have an account? Sign in" : "New to TrustLens? Create an Analyst account"}</button>
    <div className="auth-footnote"><LockKeyhole size={14} /><span>New accounts receive the Analyst role. A workspace superuser must grant Reviewer/Admin permissions before report submission.</span></div>
  </section></main>;
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="empty-state"><span><FileSearch size={22} /></span><strong>{title}</strong><p>{description}</p>{action}</div>;
}

function ModalShell({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal"><header className="modal-header"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></header>{children}</section></div>;
}
