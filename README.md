# TrustLens AI

TrustLens AI is an authenticated assessment workspace for recording authorized security reviews, documenting input points, validating findings with human reviewers, and submitting downloadable PDF reports. Workspace records are stored by Django in a local SQLite database.

TrustLens is not a scanner: it does not crawl, contact, or test target websites. Evidence and report content are entered by users. AI Analysis can call an optional OpenAI-compatible provider through Django; without a backend API key, it remains simulated. AI output is advisory and is not included in submitted reports.

## Requirements

- Python 3.10 or newer
- Node.js 22.12 or newer

## Run locally on Windows

From the project directory, open two PowerShell terminals.

### Terminal 1: backend

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe manage.py migrate
.\.venv\Scripts\python.exe manage.py createsuperuser
.\.venv\Scripts\python.exe manage.py runserver 127.0.0.1:8000
```

If the Python launcher does not have a `3.13` interpreter, substitute an installed Python version of 3.10 or newer.

### Optional: connect an AI provider

The backend supports providers with an OpenAI-compatible Chat Completions JSON API. The simplest local setup is to copy `.env.example` to `.env` in the project root and edit `.env` in VS Code:

```dotenv
TRUSTLENS_AI_API_KEY=your-new-provider-key
TRUSTLENS_AI_BASE_URL=https://api.openai.com/v1
TRUSTLENS_AI_MODEL=gpt-4o-mini
TRUSTLENS_AI_TIMEOUT_SECONDS=25
```

Save `.env`, then restart Django from the project folder. `.env` is ignored by Git and is read only by the backend; never paste the key into chat or frontend files. With the key unset, the AI Analysis page reports that the provider is not connected and retains its simulated summary. Environment variables already set in the process take precedence over `.env`.

Before requesting provider analysis, an authorized workspace user must review and confirm that the selected finding/observations contain no passwords, access tokens, API keys, or customer/personal information. Django sends the selected finding and its recorded manual tests, includes only linked evidence with redaction confirmed, and masks common credential, email, and phone patterns. Do not submit sensitive information; automated masking cannot recognize every kind of personal or confidential data. The configured provider receives this context under its own retention and privacy terms.

### Terminal 2: frontend

```powershell
npm ci
npm run dev
```

Open the Vite URL shown in the terminal (normally <http://127.0.0.1:5173>). Vite proxies API and Django Admin requests to the backend.

## Accounts and roles

- **Sign up** from the TrustLens sign-in page to create a persistent Analyst account. Passwords are validated by Django.
- The first **Administrator** account is created with `createsuperuser`. Sign in to TrustLens with that same account.
- A superuser can create accounts and set **Analyst**, **Reviewer**, or **Administrator** memberships in Django Admin at <http://127.0.0.1:8000/admin/>.
- Only a Reviewer or Administrator can record a human review conclusion or submit a report. Public sign-up cannot grant elevated roles.

## Assessment and report workflow

1. Create an assessment in **Planning** and record the authorized scope, approval state, and dates.
2. Record scope approval and explicit authorization confirmation before setting it **In Progress**.
3. Manually document input points, findings, and sanitized evidence. For an authorized In Progress assessment, analysts can record individual input checks with expected and observed behavior. The required-field, whitespace-only, length-limit, format, and ordinary-special-character templates are prompts only; TrustLens does not execute tests.
4. The AI Analysis page uses saved observations and redacted evidence to request a structured advisory analysis when a provider is configured; otherwise it offers a clearly labeled simulation. AI output separates facts from hypotheses, states uncertainty, and never changes a finding's review status.
5. A Reviewer or Administrator reviews findings with linked, redaction-confirmed evidence. Every finding must be Confirmed or marked False Positive before report submission.
6. Move the assessment from **In Progress** to **Under Review**. A Reviewer or Administrator can submit the report and download its PDF.
7. Submission saves an immutable report snapshot, including recorded manual input tests, and locks the assessment against further edits. Create a follow-up assessment for additional work.

The report includes an executive summary, scope and authorization declarations, methodology and limitations, severity totals, detailed findings and evidence excerpts, manual input test observations, remediation guidance, AI disclosure, and a retesting plan. AI analysis results are not automatically added to reports. Authorization is recorded as a team declaration and is not independently verified by TrustLens.

## Development checks

```powershell
npm run build
.\.venv\Scripts\python.exe manage.py test assessments
```

## Data and deployment notes

- The SQLite database is `backend/db.sqlite3`; keep it backed up and out of source control.
- Django Admin is for account and role administration; workspace application data is managed through TrustLens.
- Configure a private `DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS`, `DJANGO_CSRF_TRUSTED_ORIGINS`, and `DJANGO_DEBUG=false` before any non-local deployment. The default secret and SQLite configuration are for local development only.
- Provider API keys must remain in backend environment variables. AI provider calls are not stored in the database or added to submitted report snapshots. No evidence file storage is configured.
- Never store passwords, access tokens, API keys, or customer personal information in evidence.
