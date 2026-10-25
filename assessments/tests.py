import json
import os
import tempfile
from datetime import date, timedelta
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError
from unittest.mock import patch

from django.contrib.auth.models import User
from django.test import Client, TestCase
from django.urls import reverse

from backend import settings as backend_settings
from .models import Assessment, Evidence, Finding, InputPoint, ManualTestRecord, Membership


class AssessmentWorkflowTests(TestCase):
    def setUp(self):
        self.reviewer = User.objects.create_superuser(username="administrator", password="Strong-test-password-42")
        self.client.force_login(self.reviewer)

    def post_json(self, path, data):
        return self.client.post(path, data=json.dumps(data), content_type="application/json")

    def create_assessment(self):
        response = self.post_json(reverse("assessments"), {
            "name": "Authorized input review",
            "organization": "Example Project",
            "scope": "staging.example.test",
            "approval": "Approved",
            "approvedForTesting": True,
            "start": date.today().isoformat(),
            "end": (date.today() + timedelta(days=4)).isoformat(),
            "status": "Planning",
            "notes": "Staging only; synthetic data.",
        })
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()["assessment"]

    def create_in_progress_input(self):
        assessment_data = self.create_assessment()
        assessment = Assessment.objects.get(pk=assessment_data["id"])
        assessment.status = Assessment.Status.IN_PROGRESS
        assessment.save(update_fields=["status"])
        input_point = InputPoint.objects.create(
            assessment=assessment,
            route="/profile",
            name="displayName",
            kind=InputPoint.Kind.FORM,
        )
        return assessment, input_point

    def test_authentication_is_required_for_workspace_data(self):
        self.client.logout()
        response = self.client.get(reverse("bootstrap"))
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"], "Authentication required.")

    def test_login_requires_csrf_and_sets_session(self):
        self.client.logout()
        csrf_client = Client(enforce_csrf_checks=True)
        csrf_client.get(reverse("csrf"))
        response = csrf_client.post(
            reverse("login"),
            data=json.dumps({"username": "administrator", "password": "Strong-test-password-42"}),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=csrf_client.cookies["csrftoken"].value,
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["user"]["role"], Membership.Role.ADMINISTRATOR)
        self.assertTrue(csrf_client.get(reverse("session")).json()["authenticated"])

    def test_self_signup_creates_an_analyst_account(self):
        client = Client(enforce_csrf_checks=True)
        client.get(reverse("csrf"))
        response = client.post(
            reverse("register"),
            data=json.dumps({
                "username": "newanalyst",
                "password": "Strong-test-password-42",
                "confirmPassword": "Strong-test-password-42",
            }),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=client.cookies["csrftoken"].value,
        )
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()["user"]["role"], Membership.Role.ANALYST)
        self.assertTrue(client.get(reverse("session")).json()["authenticated"])
        self.assertEqual(Membership.objects.get(user__username="newanalyst").role, Membership.Role.ANALYST)

    def test_local_env_file_loads_without_overriding_process_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, ".env").write_text(
                "# local-only test values\nTRUSTLENS_AI_API_KEY=file-test-value\nTRUSTLENS_AI_MODEL='example-model'\n",
                encoding="utf-8",
            )
            with patch.object(backend_settings, "BASE_DIR", Path(directory)), patch.dict(
                os.environ,
                {"TRUSTLENS_AI_API_KEY": "process-test-value"},
                clear=False,
            ):
                os.environ.pop("TRUSTLENS_AI_MODEL", None)
                backend_settings.load_local_env()
                self.assertEqual(os.environ["TRUSTLENS_AI_API_KEY"], "process-test-value")
                self.assertEqual(os.environ["TRUSTLENS_AI_MODEL"], "example-model")

    def test_signup_accepts_vite_dev_origin_and_reaches_form_validation(self):
        client = Client(enforce_csrf_checks=True)
        client.get(reverse("csrf"))
        response = client.post(
            reverse("register"),
            data=json.dumps({
                "username": "a",
                "password": "weak",
                "confirmPassword": "weak",
            }),
            content_type="application/json",
            HTTP_X_CSRFTOKEN=client.cookies["csrftoken"].value,
            HTTP_ORIGIN="http://127.0.0.1:5173",
            HTTP_REFERER="http://127.0.0.1:5173/",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json())

    def test_assessment_requires_approved_authorization_before_starting(self):
        payload = {
            "name": "Not approved",
            "organization": "Example",
            "scope": "staging.example.test",
            "approval": "Pending",
            "approvedForTesting": False,
            "start": date.today().isoformat(),
            "end": (date.today() + timedelta(days=1)).isoformat(),
            "status": "In Progress",
            "notes": "",
        }
        response = self.post_json(reverse("assessments"), payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("approved scope", response.json()["error"])
        payload.update({
            "approval": "Approved",
            "approvedForTesting": True,
            "status": "Completed",
        })
        response = self.post_json(reverse("assessments"), payload)
        self.assertEqual(response.status_code, 400)
        self.assertIn("final report is submitted", response.json()["error"])

    def test_manual_test_record_persists_without_confirming_finding(self):
        assessment, input_point = self.create_in_progress_input()
        finding = Finding.objects.create(
            assessment=assessment,
            input_point=input_point,
            title="Unverified input observation",
            category="Input Validation",
            severity=Finding.Severity.LOW,
            confidence=50,
            validation=Finding.Validation.SUSPECTED,
            description="A manual observation awaits independent review.",
        )
        payload = {
            "inputId": str(input_point.pk),
            "category": ManualTestRecord.Category.LENGTH_LIMIT,
            "description": "Compare benign values against the documented maximum.",
            "expectedBehavior": "The documented maximum length is enforced.",
            "actualBehavior": "The value was accepted; review is needed.",
            "evidenceReference": "Evidence note 12",
            "result": ManualTestRecord.Result.DEVIATION,
        }

        created = self.post_json(reverse("manual-tests"), payload)
        self.assertEqual(created.status_code, 201, created.content)
        record = ManualTestRecord.objects.get(pk=created.json()["manualTest"]["id"])
        self.assertEqual(record.input_point, input_point)
        self.assertEqual(record.recorded_by, self.reviewer)
        self.assertEqual(record.actual_behavior, payload["actualBehavior"])
        self.assertEqual(record.evidence_reference, payload["evidenceReference"])

        listed = self.client.get(reverse("manual-tests"), {"input": str(input_point.pk)})
        self.assertEqual(listed.status_code, 200, listed.content)
        self.assertEqual(len(listed.json()["manualTests"]), 1)
        self.assertEqual(listed.json()["manualTests"][0]["result"], ManualTestRecord.Result.DEVIATION)
        finding.refresh_from_db()
        self.assertEqual(finding.validation, Finding.Validation.SUSPECTED)

    def test_manual_test_rejects_invalid_fields_and_results(self):
        _, input_point = self.create_in_progress_input()
        valid_payload = {
            "inputId": str(input_point.pk),
            "category": ManualTestRecord.Category.REQUIRED_FIELD,
            "description": "Record the expected required-field behavior.",
            "expectedBehavior": "The field is required.",
            "actualBehavior": "The form displayed a validation message.",
            "result": ManualTestRecord.Result.PASS,
        }
        missing = self.post_json(reverse("manual-tests"), {**valid_payload, "actualBehavior": "  "})
        self.assertEqual(missing.status_code, 400)
        self.assertIn("Actual observed behavior is required", missing.json()["error"])

        invalid_result = self.post_json(reverse("manual-tests"), {**valid_payload, "result": "Confirmed"})
        self.assertEqual(invalid_result.status_code, 400)
        self.assertIn("valid manual test result", invalid_result.json()["error"])

        invalid_category = self.post_json(reverse("manual-tests"), {**valid_payload, "category": "Injection payload"})
        self.assertEqual(invalid_category.status_code, 400)
        self.assertIn("valid manual test category", invalid_category.json()["error"])
        self.assertEqual(ManualTestRecord.objects.count(), 0)

    def test_manual_test_requires_in_progress_approved_authorized_scope(self):
        assessment_data = self.create_assessment()
        assessment = Assessment.objects.get(pk=assessment_data["id"])
        input_point = InputPoint.objects.create(
            assessment=assessment,
            route="/profile",
            name="displayName",
            kind=InputPoint.Kind.FORM,
        )
        payload = {
            "inputId": str(input_point.pk),
            "category": ManualTestRecord.Category.REQUIRED_FIELD,
            "description": "Check documented required-field behavior.",
            "expectedBehavior": "A missing value is rejected.",
            "actualBehavior": "A validation message was displayed.",
            "result": ManualTestRecord.Result.PASS,
        }
        planning = self.post_json(reverse("manual-tests"), payload)
        self.assertEqual(planning.status_code, 400)
        self.assertIn("In Progress assessment", planning.json()["error"])

        assessment.status = Assessment.Status.IN_PROGRESS
        assessment.authorization_confirmed = False
        assessment.save(update_fields=["status", "authorization_confirmed"])
        unapproved = self.post_json(reverse("manual-tests"), payload)
        self.assertEqual(unapproved.status_code, 400)
        self.assertIn("documented authorization", unapproved.json()["error"])

        assessment.authorization_confirmed = True
        assessment.approval = Assessment.Approval.PENDING
        assessment.save(update_fields=["approval", "authorization_confirmed"])
        pending_scope = self.post_json(reverse("manual-tests"), payload)
        self.assertEqual(pending_scope.status_code, 400)
        self.assertIn("approved scope", pending_scope.json()["error"])

        assessment.approval = Assessment.Approval.APPROVED
        assessment.save(update_fields=["approval"])
        analyst = User.objects.create_user(username="other-analyst", password="Strong-test-password-42")
        Membership.objects.create(user=analyst, role=Membership.Role.ANALYST)
        self.client.force_login(analyst)
        inaccessible = self.post_json(reverse("manual-tests"), payload)
        self.assertEqual(inaccessible.status_code, 404)
        self.assertEqual(ManualTestRecord.objects.count(), 0)

    @patch("assessments.ai_service.send_provider_request")
    def test_ai_analysis_uses_scoped_redacted_context_without_changing_finding(self, mock_urlopen):
        assessment, input_point = self.create_in_progress_input()
        finding = Finding.objects.create(
            assessment=assessment,
            input_point=input_point,
            title="Length validation observation",
            category="Input Validation",
            severity=Finding.Severity.MEDIUM,
            confidence=60,
            validation=Finding.Validation.SUSPECTED,
            description="A benign sample email analyst@example.test was accepted.",
            impact="Potentially unexpected input processing.",
        )
        ManualTestRecord.objects.create(
            input_point=input_point,
            category=ManualTestRecord.Category.LENGTH_LIMIT,
            description="Compare against the documented length.",
            expected_behavior="The limit is enforced.",
            actual_behavior='password="hunter2 with spaces"; contact analyst@example.test; token=private-token-value',
            result=ManualTestRecord.Result.DEVIATION,
            recorded_by=self.reviewer,
        )
        Evidence.objects.create(
            finding=finding,
            input_point=input_point,
            title="Sanitized evidence",
            observed_at=date.today(),
            notes="Bearer abcdefghijklmnop was removed during review.",
            redaction_confirmed=True,
            created_by=self.reviewer,
        )
        Evidence.objects.create(
            finding=finding,
            input_point=input_point,
            title="Unredacted evidence",
            observed_at=date.today(),
            notes="private customer observation",
            redaction_confirmed=False,
            created_by=self.reviewer,
        )
        provider_content = {
            "observed_facts": ["One manually recorded deviation was observed."],
            "possible_interpretation": "This may indicate a validation mismatch.",
            "confidence_uncertainty": "Low confidence; observation is not independently reproduced.",
            "potential_impact": "Impact cannot be determined from the current evidence.",
            "recommended_remediation": "Validate values server-side against documented constraints.",
            "safe_verification_steps": ["Repeat the benign manual check within the approved scope; api_key=returned-provider-secret."],
            "missing_evidence": ["Independent reviewer reproduction."],
        }
        mock_urlopen.return_value.__enter__.return_value.read.return_value = json.dumps({
            "choices": [{"message": {"content": json.dumps(provider_content)}}],
        }).encode()

        with self.settings(
            AI_PROVIDER_API_KEY="test-provider-key",
            AI_PROVIDER_BASE_URL="https://provider.example.test/v1",
            AI_PROVIDER_MODEL="test-model",
            AI_PROVIDER_TIMEOUT_SECONDS=2,
        ):
            response = self.post_json(reverse("ai-analysis"), {
                "findingId": str(finding.pk),
                "confirmSanitized": True,
            })

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["mode"], "ai")
        self.assertEqual(response.json()["analysis"]["observed_facts"], provider_content["observed_facts"])
        self.assertNotIn("returned-provider-secret", json.dumps(response.json()))
        request = mock_urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer test-provider-key")
        sent_payload = json.loads(request.data)
        sent_context = json.loads(sent_payload["messages"][1]["content"])
        serialized_context = json.dumps(sent_context)
        self.assertIn("Sanitized evidence", serialized_context)
        self.assertNotIn("Unredacted evidence", serialized_context)
        self.assertNotIn("hunter2", serialized_context)
        self.assertNotIn("private-token-value", serialized_context)
        self.assertNotIn("analyst@example.test", serialized_context)
        self.assertNotIn("abcdefghijklmno", serialized_context)
        finding.refresh_from_db()
        self.assertEqual(finding.validation, Finding.Validation.SUSPECTED)
        self.assertEqual(finding.severity, Finding.Severity.MEDIUM)
        self.assertFalse(assessment.reports.exists())

    @patch("assessments.ai_service.send_provider_request")
    def test_ai_analysis_falls_back_when_provider_is_not_configured(self, mock_urlopen):
        with self.settings(AI_PROVIDER_API_KEY="", AI_PROVIDER_BASE_URL="https://provider.example.test/v1"):
            response = self.client.get(reverse("ai-analysis"))
            self.assertEqual(response.status_code, 200)
            self.assertFalse(response.json()["connected"])
            fallback = self.post_json(reverse("ai-analysis"), {"findingId": "not-needed"})
            self.assertEqual(fallback.status_code, 200)
            self.assertEqual(fallback.json(), {"mode": "simulated", "analysis": None})
        mock_urlopen.assert_not_called()

    def test_ai_analysis_requires_confirmation_scope_and_assessment_access(self):
        assessment, input_point = self.create_in_progress_input()
        finding = Finding.objects.create(
            assessment=assessment,
            input_point=input_point,
            title="Observation",
            category="Input Validation",
            severity=Finding.Severity.LOW,
            description="Recorded behavior.",
        )
        with self.settings(AI_PROVIDER_API_KEY="test-provider-key"):
            missing_confirmation = self.post_json(reverse("ai-analysis"), {"findingId": str(finding.pk)})
            self.assertEqual(missing_confirmation.status_code, 400)
            self.assertIn("confirm", missing_confirmation.json()["error"])

            assessment.authorization_confirmed = False
            assessment.save(update_fields=["authorization_confirmed"])
            blocked_scope = self.post_json(reverse("ai-analysis"), {
                "findingId": str(finding.pk),
                "confirmSanitized": True,
            })
            self.assertEqual(blocked_scope.status_code, 400)
            self.assertIn("approved scope", blocked_scope.json()["error"])

            other_user = User.objects.create_user(username="unrelated-analyst", password="Strong-test-password-42")
            Membership.objects.create(user=other_user, role=Membership.Role.ANALYST)
            self.client.force_login(other_user)
            inaccessible = self.post_json(reverse("ai-analysis"), {
                "findingId": str(finding.pk),
                "confirmSanitized": True,
            })
            self.assertEqual(inaccessible.status_code, 404)

    @patch("assessments.ai_service.send_provider_request")
    def test_ai_analysis_handles_timeout_and_malformed_provider_response(self, mock_urlopen):
        assessment, input_point = self.create_in_progress_input()
        finding = Finding.objects.create(
            assessment=assessment,
            input_point=input_point,
            title="Observation",
            category="Input Validation",
            severity=Finding.Severity.LOW,
            description="Recorded behavior.",
        )
        payload = {"findingId": str(finding.pk), "confirmSanitized": True}
        with self.settings(
            AI_PROVIDER_API_KEY="test-provider-key",
            AI_PROVIDER_BASE_URL="https://provider.example.test/v1",
            AI_PROVIDER_MODEL="test-model",
            AI_PROVIDER_TIMEOUT_SECONDS=2,
        ):
            mock_urlopen.side_effect = TimeoutError()
            timeout = self.post_json(reverse("ai-analysis"), payload)
            self.assertEqual(timeout.status_code, 502)
            self.assertIn("could not be reached", timeout.json()["error"])

            mock_urlopen.side_effect = None
            mock_urlopen.return_value.__enter__.return_value.read.return_value = b'{"choices":[]}'
            malformed = self.post_json(reverse("ai-analysis"), payload)
            self.assertEqual(malformed.status_code, 502)
            self.assertIn("unreadable response", malformed.json()["error"])

            mock_urlopen.side_effect = HTTPError(
                "https://provider.example.test/v1/chat/completions",
                429,
                "rate limited",
                {},
                BytesIO(b"provider response containing sensitive details"),
            )
            provider_error = self.post_json(reverse("ai-analysis"), payload)
            self.assertEqual(provider_error.status_code, 502)
            self.assertNotIn("sensitive details", provider_error.content.decode())

    def test_report_requires_review_and_persists_downloadable_pdf(self):
        assessment_data = self.create_assessment()
        assessment = Assessment.objects.get(pk=assessment_data["id"])
        input_point = InputPoint.objects.create(
            assessment=assessment,
            route="/profile",
            name="displayName",
            kind=InputPoint.Kind.FORM,
        )
        finding = Finding.objects.create(
            assessment=assessment,
            input_point=input_point,
            title="Input length exceeds the documented limit",
            category="Input Validation",
            severity=Finding.Severity.MEDIUM,
            confidence=85,
            description="A synthetic value longer than the documented limit was accepted.",
            impact="Unexpected values may disrupt downstream processing.",
            remediation="Enforce the documented maximum length on the server.",
        )
        evidence = Evidence.objects.create(
            finding=finding,
            input_point=input_point,
            title="Synthetic length check",
            observed_at=date.today(),
            notes="A benign synthetic value <submitted> 🚧 was accepted in the authorized staging system.",
            reproduction_steps="Submitted a benign test value and recorded the staging response.",
            request_excerpt="POST /profile · displayName=[synthetic]",
            response_excerpt="200 OK · staging",
            redaction_confirmed=True,
            created_by=self.reviewer,
        )
        ManualTestRecord.objects.create(
            input_point=input_point,
            category=ManualTestRecord.Category.SPECIAL_CHARACTERS,
            description="Record benign punctuation handling.",
            expected_behavior="Ordinary punctuation is handled safely.",
            actual_behavior="The saved observation requires reviewer interpretation.",
            evidence_reference="Evidence note 3",
            result=ManualTestRecord.Result.INCONCLUSIVE,
            recorded_by=self.reviewer,
        )
        assessment.status = Assessment.Status.UNDER_REVIEW
        assessment.save(update_fields=["status"])

        blocked = self.post_json(reverse("submit-report"), {"assessment": str(assessment.pk)})
        self.assertEqual(blocked.status_code, 400)
        self.assertIn("suspected finding", blocked.json()["error"])

        review = self.post_json(reverse("review-finding", args=[finding.pk]), {"validation": "Confirmed"})
        self.assertEqual(review.status_code, 200, review.content)
        evidence.refresh_from_db()
        self.assertTrue(evidence.redaction_confirmed)

        submitted = self.post_json(reverse("submit-report"), {"assessment": str(assessment.pk)})
        self.assertEqual(submitted.status_code, 201, submitted.content)
        report_id = submitted.json()["report"]["id"]

        pdf = self.client.get(reverse("report-pdf", args=[report_id]))
        self.assertEqual(pdf.status_code, 200)
        self.assertEqual(pdf["Content-Type"], "application/pdf")
        self.assertEqual(pdf.content[:5], b"%PDF-")
        self.assertEqual(assessment.reports.count(), 1)
        self.assertEqual(assessment.reports.first().report_data["evidence"][0]["reproductionSteps"], "Submitted a benign test value and recorded the staging response.")
        self.assertEqual(assessment.reports.first().report_data["manualTests"][0]["evidenceReference"], "Evidence note 3")
        self.assertEqual(assessment.reports.first().report_data["manualTests"][0]["result"], ManualTestRecord.Result.INCONCLUSIVE)
        duplicate = self.post_json(reverse("submit-report"), {"assessment": str(assessment.pk)})
        self.assertEqual(duplicate.status_code, 409)
        locked = self.client.put(reverse("assessment-detail", args=[assessment.pk]), data="{}", content_type="application/json")
        self.assertEqual(locked.status_code, 409)
        locked_review = self.post_json(reverse("review-finding", args=[finding.pk]), {"validation": "False Positive"})
        self.assertEqual(locked_review.status_code, 409)
        assessment.refresh_from_db()
        self.assertEqual(assessment.status, Assessment.Status.COMPLETED)
        self.assertIn("Synthetic length check", assessment.reports.first().report_data["findings"][0]["evidence"])

    def test_review_requires_redacted_evidence_and_reviewer_role(self):
        assessment_data = self.create_assessment()
        assessment = Assessment.objects.get(pk=assessment_data["id"])
        input_point = InputPoint.objects.create(assessment=assessment, route="/search", name="q", kind=InputPoint.Kind.QUERY_PARAMETER)
        finding = Finding.objects.create(
            assessment=assessment,
            input_point=input_point,
            title="Unverified observation",
            category="Other",
            severity=Finding.Severity.LOW,
            description="Observed behavior is not yet validated.",
        )
        blocked = self.post_json(reverse("review-finding", args=[finding.pk]), {"validation": "False Positive"})
        self.assertEqual(blocked.status_code, 400)
        self.assertIn("supporting evidence", blocked.json()["error"])

        Evidence.objects.create(
            finding=finding,
            input_point=input_point,
            title="Redaction pending",
            observed_at=date.today(),
            notes="Evidence awaiting redaction review.",
            redaction_confirmed=False,
            created_by=self.reviewer,
        )
        blocked = self.post_json(reverse("review-finding", args=[finding.pk]), {"validation": "Confirmed"})
        self.assertEqual(blocked.status_code, 400)
        self.assertIn("redaction confirmed", blocked.json()["error"])

        analyst = User.objects.create_user(username="analyst", password="Strong-test-password-43")
        Membership.objects.create(user=analyst, role=Membership.Role.ANALYST)
        self.client.force_login(analyst)
        denied = self.post_json(reverse("review-finding", args=[finding.pk]), {"validation": "Confirmed"})
        self.assertEqual(denied.status_code, 403)
