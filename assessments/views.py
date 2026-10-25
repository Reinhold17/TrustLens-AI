import json
from datetime import date
from functools import wraps
from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape
from uuid import UUID

from django.contrib.auth import authenticate, login, logout
from django.contrib.auth.forms import UserCreationForm
from django.contrib.auth.models import User
from django.db import IntegrityError, transaction
from django.http import HttpResponse, JsonResponse
from django.middleware.csrf import get_token
from django.utils import timezone
from django.utils.dateparse import parse_date
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST, require_http_methods
from reportlab import __file__ as reportlab_path
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .ai_service import AIProviderError, analyze as analyze_with_provider, build_analysis_context, provider_configured
from .models import ActivityEntry, Assessment, Evidence, Finding, InputPoint, ManualTestRecord, Membership, ReportSubmission


class APIError(Exception):
    def __init__(self, message, status=400):
        self.message = message
        self.status = status
        super().__init__(message)


def public_api(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        try:
            return view(request, *args, **kwargs)
        except APIError as error:
            return JsonResponse({"error": error.message}, status=error.status)

    return wrapped


def api_view(view):
    @wraps(view)
    def wrapped(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return JsonResponse({"error": "Authentication required."}, status=401)
        try:
            return view(request, *args, **kwargs)
        except APIError as error:
            return JsonResponse({"error": error.message}, status=error.status)
        except IntegrityError:
            return JsonResponse({"error": "The record conflicts with an existing record. Check the input and try again."}, status=409)

    return wrapped


def require_role(*roles):
    def decorate(view):
        @wraps(view)
        def wrapped(request, *args, **kwargs):
            role = membership_for(request.user).role
            if role not in roles and role != Membership.Role.ADMINISTRATOR:
                return JsonResponse({"error": "Your workspace role does not allow this action."}, status=403)
            return view(request, *args, **kwargs)

        return wrapped

    return decorate


def membership_for(user):
    if user.is_superuser:
        membership, _ = Membership.objects.get_or_create(user=user, defaults={"role": Membership.Role.ADMINISTRATOR})
        if membership.role != Membership.Role.ADMINISTRATOR:
            membership.role = Membership.Role.ADMINISTRATOR
            membership.save(update_fields=["role"])
        return membership
    membership, _ = Membership.objects.get_or_create(user=user)
    return membership


def body_json(request):
    try:
        payload = json.loads(request.body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise APIError("Request body must be valid JSON.") from None
    if not isinstance(payload, dict):
        raise APIError("Request body must be a JSON object.")
    return payload


def required_text(data, key, label, maximum=1000):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise APIError(f"{label} is required.")
    value = value.strip()
    if len(value) > maximum:
        raise APIError(f"{label} must be {maximum} characters or fewer.")
    return value


def optional_text(data, key, maximum=10000):
    value = data.get(key, "")
    if not isinstance(value, str):
        raise APIError(f"{key.replace('_', ' ').capitalize()} must be text.")
    if len(value) > maximum:
        raise APIError(f"{key.replace('_', ' ').capitalize()} must be {maximum} characters or fewer.")
    return value.strip()


def required_date(data, key, label):
    value = data.get(key)
    parsed = parse_date(value) if isinstance(value, str) else None
    if parsed is None:
        raise APIError(f"{label} must be a valid date.")
    return parsed


def record_activity(user, action, subject):
    ActivityEntry.objects.create(actor=user, action=action, subject=subject[:240])


def ensure_assessment_editable(assessment):
    if assessment.status == Assessment.Status.COMPLETED or assessment.reports.exists():
        raise APIError("This assessment is locked after report submission. Create a follow-up assessment for additional work.", 409)


def accessible_assessments(user):
    if user.is_superuser:
        return Assessment.objects.all()
    return Assessment.objects.filter(owner=user) | Assessment.objects.filter(team=user)


def get_assessment(user, assessment_id):
    try:
        assessment_id = UUID(str(assessment_id))
    except (ValueError, TypeError, AttributeError):
        raise APIError("Assessment not found.", 404) from None
    assessment = accessible_assessments(user).filter(pk=assessment_id).first()
    if assessment is None:
        raise APIError("Assessment not found.", 404)
    return assessment


def serialize_assessment(item):
    members = item.team.all()
    if not members.exists():
        members = [item.owner]
    return {
        "id": str(item.id),
        "name": item.name,
        "organization": item.organization,
        "scope": item.scope,
        "approval": item.approval,
        "approvedForTesting": item.authorization_confirmed,
        "start": item.start_date.isoformat(),
        "end": item.end_date.isoformat(),
        "status": item.status,
        "team": [member.get_full_name() or member.username for member in members],
        "notes": item.notes,
        "progress": assessment_progress(item),
        "archived": item.archived,
        "updated": item.updated_at.isoformat(),
    }


def assessment_progress(item):
    total = item.input_points.count()
    if not total:
        return 0
    reviewed = item.input_points.filter(status=InputPoint.ReviewStatus.REVIEWED).count()
    return round(reviewed * 100 / total)


def serialize_input(item):
    return {
        "id": str(item.id),
        "route": item.route,
        "name": item.name,
        "kind": item.kind,
        "status": item.status,
        "evidence": item.evidence.count(),
        "notes": item.notes,
        "assessment": str(item.assessment_id),
    }


def serialize_finding(item):
    return {
        "id": str(item.id),
        "title": item.title,
        "category": item.category,
        "inputId": str(item.input_point_id),
        "severity": item.severity,
        "confidence": item.confidence,
        "validation": item.validation,
        "description": item.description,
        "impact": item.impact,
        "evidence": [str(evidence_id) for evidence_id in item.evidence.values_list("id", flat=True)],
        "remediation": item.remediation,
        "reviewer": (item.reviewer.get_full_name() or item.reviewer.username) if item.reviewer else "Unassigned",
        "updated": item.updated_at.strftime("%b %d, %Y").replace(" 0", " "),
        "assessment": str(item.assessment_id),
    }


def serialize_evidence(item):
    return {
        "id": str(item.id),
        "title": item.title,
        "kind": item.kind,
        "date": item.observed_at.strftime("%b %d, %Y").replace(" 0", " "),
        "inputId": str(item.input_point_id),
        "findingId": str(item.finding_id),
        "redacted": item.redaction_confirmed,
        "notes": item.notes,
        "request": item.request_excerpt or "No request excerpt provided",
        "response": item.response_excerpt or "No response excerpt provided",
        "reproductionSteps": item.reproduction_steps,
        "reference": item.screenshot_reference,
    }


def serialize_manual_test(item):
    return {
        "id": str(item.id),
        "inputId": str(item.input_point_id),
        "assessment": str(item.input_point.assessment_id),
        "category": item.category,
        "description": item.description,
        "expectedBehavior": item.expected_behavior,
        "actualBehavior": item.actual_behavior,
        "evidenceReference": item.evidence_reference,
        "result": item.result,
        "recordedBy": item.recorded_by.get_full_name() or item.recorded_by.username,
        "recordedAt": item.recorded_at.isoformat(),
    }


def serialize_report(item):
    return {
        "id": str(item.id),
        "assessment": str(item.assessment_id),
        "assessmentName": item.assessment.name,
        "submittedBy": item.submitted_by.get_full_name() or item.submitted_by.username,
        "submittedAt": item.submitted_at.isoformat(),
    }


@ensure_csrf_cookie
@require_GET
def csrf_token(request):
    return JsonResponse({"csrfToken": get_token(request)})


@require_GET
def session(request):
    if not request.user.is_authenticated:
        return JsonResponse({"authenticated": False}, status=401)
    membership = membership_for(request.user)
    return JsonResponse({
        "authenticated": True,
        "user": {
            "id": request.user.pk,
            "name": request.user.get_full_name() or request.user.username,
            "username": request.user.username,
            "role": membership.role,
        },
    })


@public_api
@require_POST
def register_view(request):
    data = body_json(request)
    form = UserCreationForm(data={
        "username": data.get("username", ""),
        "password1": data.get("password", ""),
        "password2": data.get("confirmPassword", ""),
    })
    if not form.is_valid():
        error = next(iter(form.errors.values()))[0]
        raise APIError(str(error))
    with transaction.atomic():
        user = form.save()
        Membership.objects.create(user=user, role=Membership.Role.ANALYST)
        record_activity(user, "created workspace account", user.username)
    login(request, user)
    return JsonResponse({"user": {"id": user.pk, "name": user.get_full_name() or user.username, "username": user.username, "role": Membership.Role.ANALYST}}, status=201)


@public_api
@require_POST
def login_view(request):
    data = body_json(request)
    username = required_text(data, "username", "Username", 150)
    password = data.get("password")
    if not isinstance(password, str) or not password:
        raise APIError("Password is required.")
    user = authenticate(request, username=username, password=password)
    if user is None:
        return JsonResponse({"error": "Username or password is incorrect."}, status=401)
    if not user.is_active:
        return JsonResponse({"error": "This account is disabled."}, status=403)
    login(request, user)
    membership = membership_for(user)
    return JsonResponse({"user": {"id": user.pk, "name": user.get_full_name() or user.username, "username": user.username, "role": membership.role}})


@api_view
@require_POST
def logout_view(request):
    logout(request)
    return JsonResponse({"ok": True})


@api_view
@require_GET
def bootstrap(request):
    assessments = accessible_assessments(request.user)
    users = User.objects.filter(is_active=True, trustlens_membership__isnull=False).select_related("trustlens_membership")
    return JsonResponse({
        "assessments": [serialize_assessment(item) for item in assessments],
        "inputs": [serialize_input(item) for item in InputPoint.objects.filter(assessment__in=assessments).select_related("assessment")],
        "manualTests": [serialize_manual_test(item) for item in ManualTestRecord.objects.filter(input_point__assessment__in=assessments).select_related("input_point__assessment", "recorded_by")],
        "findings": [serialize_finding(item) for item in Finding.objects.filter(assessment__in=assessments).select_related("input_point", "reviewer")],
        "evidence": [serialize_evidence(item) for item in Evidence.objects.filter(finding__assessment__in=assessments).select_related("finding", "input_point")],
        "reports": [serialize_report(item) for item in ReportSubmission.objects.filter(assessment__in=assessments).select_related("assessment", "submitted_by")],
        "team": [{
            "name": user.get_full_name() or user.username,
            "initials": "".join(part[0] for part in (user.get_full_name() or user.username).split()[:2]).upper(),
            "role": membership_for(user).role,
            "username": user.username,
        } for user in users],
        "activity": [{
            "id": item.pk,
            "actor": item.actor.get_full_name() or item.actor.username,
            "action": item.action,
            "subject": item.subject,
            "createdAt": item.created_at.isoformat(),
        } for item in ActivityEntry.objects.filter(actor__in=users).select_related("actor")[:25]],
    })


def validate_assessment_data(data, instance=None):
    name = required_text(data, "name", "Assessment name", 180)
    organization = required_text(data, "organization", "Organization or project", 180)
    scope = required_text(data, "scope", "Authorized target scope", 500)
    start = required_date(data, "start", "Start date")
    end = required_date(data, "end", "End date")
    if end < start:
        raise APIError("End date cannot be before the start date.")
    approval = data.get("approval", instance.approval if instance else Assessment.Approval.PENDING)
    if approval not in Assessment.Approval.values:
        raise APIError("Select a valid scope approval status.")
    status = data.get("status", instance.status if instance else Assessment.Status.PLANNING)
    if status not in Assessment.Status.values:
        raise APIError("Select a valid assessment status.")
    authorization_confirmed = data.get("approvedForTesting", instance.authorization_confirmed if instance else False)
    if not isinstance(authorization_confirmed, bool):
        raise APIError("Authorization confirmation must be a boolean.")
    if status == Assessment.Status.IN_PROGRESS and (approval != Assessment.Approval.APPROVED or not authorization_confirmed):
        raise APIError("An assessment can only be marked In Progress after approved scope and explicit authorization confirmation.")
    if status == Assessment.Status.UNDER_REVIEW:
        if approval != Assessment.Approval.APPROVED or not authorization_confirmed:
            raise APIError("Under Review requires approved scope and explicit authorization confirmation.")
        if instance is None or instance.status not in (Assessment.Status.IN_PROGRESS, Assessment.Status.UNDER_REVIEW):
            raise APIError("Move an in-progress assessment to Under Review before report submission.")
    if status == Assessment.Status.COMPLETED and (instance is None or instance.status != Assessment.Status.COMPLETED):
        raise APIError("An assessment is completed when its final report is submitted.")
    return {
        "name": name,
        "organization": organization,
        "scope": scope,
        "approval": approval,
        "authorization_confirmed": authorization_confirmed,
        "start_date": start,
        "end_date": end,
        "status": status,
        "notes": optional_text(data, "notes", 10000),
    }


@api_view
@require_role(Membership.Role.ANALYST)
@require_http_methods(["GET", "POST"])
def assessments(request):
    if request.method == "GET":
        return JsonResponse({"assessments": [serialize_assessment(item) for item in accessible_assessments(request.user)]})
    data = body_json(request)
    fields = validate_assessment_data(data)
    item = Assessment.objects.create(owner=request.user, **fields)
    item.team.add(request.user)
    record_activity(request.user, "created assessment", item.name)
    return JsonResponse({"assessment": serialize_assessment(item)}, status=201)


@api_view
@require_role(Membership.Role.ANALYST)
@require_http_methods(["PUT", "PATCH"])
def assessment_detail(request, assessment_id):
    item = get_assessment(request.user, assessment_id)
    ensure_assessment_editable(item)
    data = body_json(request)
    fields = validate_assessment_data(data, item)
    for key, value in fields.items():
        setattr(item, key, value)
    item.save()
    record_activity(request.user, "updated assessment", item.name)
    return JsonResponse({"assessment": serialize_assessment(item)})


@api_view
@require_role(Membership.Role.ANALYST)
@require_POST
def archive_assessment(request, assessment_id):
    item = get_assessment(request.user, assessment_id)
    data = body_json(request)
    archived = data.get("archived")
    if not isinstance(archived, bool):
        raise APIError("Archived state must be a boolean.")
    item.archived = archived
    item.save(update_fields=["archived", "updated_at"])
    record_activity(request.user, "archived assessment" if archived else "restored assessment", item.name)
    return JsonResponse({"assessment": serialize_assessment(item)})


def validate_input_data(data, assessment):
    route = required_text(data, "route", "Page or route", 500)
    name = required_text(data, "name", "Input name", 180)
    kind = data.get("kind")
    if kind not in InputPoint.Kind.values:
        raise APIError("Select a valid input type.")
    status = data.get("status", InputPoint.ReviewStatus.NOT_REVIEWED)
    if status not in InputPoint.ReviewStatus.values:
        raise APIError("Select a valid input review status.")
    return {"assessment": assessment, "route": route, "name": name, "kind": kind, "status": status, "notes": optional_text(data, "notes", 5000)}


@api_view
@require_role(Membership.Role.ANALYST)
@require_http_methods(["GET", "POST"])
def inputs(request):
    if request.method == "GET":
        assessment_id = request.GET.get("assessment")
        queryset = InputPoint.objects.filter(assessment__in=accessible_assessments(request.user))
        if assessment_id:
            queryset = queryset.filter(assessment_id=assessment_id)
        return JsonResponse({"inputs": [serialize_input(item) for item in queryset]})
    data = body_json(request)
    assessment = get_assessment(request.user, data.get("assessment"))
    ensure_assessment_editable(assessment)
    item = InputPoint.objects.create(**validate_input_data(data, assessment))
    record_activity(request.user, "documented input point", f"{item.route} · {item.name}")
    return JsonResponse({"input": serialize_input(item)}, status=201)


@api_view
@require_role(Membership.Role.ANALYST)
@require_http_methods(["PUT", "PATCH"])
def input_detail(request, input_id):
    item = InputPoint.objects.filter(pk=input_id, assessment__in=accessible_assessments(request.user)).first()
    if item is None:
        raise APIError("Input point not found.", 404)
    ensure_assessment_editable(item.assessment)
    data = body_json(request)
    assessment = get_assessment(request.user, data.get("assessment", str(item.assessment_id)))
    fields = validate_input_data(data, assessment)
    for key, value in fields.items():
        setattr(item, key, value)
    item.save()
    record_activity(request.user, "updated input point", f"{item.route} · {item.name}")
    return JsonResponse({"input": serialize_input(item)})


def validate_manual_test_data(data):
    category = data.get("category")
    if category not in ManualTestRecord.Category.values:
        raise APIError("Select a valid manual test category.")
    result = data.get("result")
    if result not in ManualTestRecord.Result.values:
        raise APIError("Select a valid manual test result.")
    return {
        "category": category,
        "description": required_text(data, "description", "Test description", 1000),
        "expected_behavior": required_text(data, "expectedBehavior", "Expected behavior", 5000),
        "actual_behavior": required_text(data, "actualBehavior", "Actual observed behavior", 10000),
        "evidence_reference": optional_text(data, "evidenceReference", 500),
        "result": result,
    }


@api_view
@require_role(Membership.Role.ANALYST)
@require_http_methods(["GET", "POST"])
def manual_tests(request):
    accessible = accessible_assessments(request.user)
    if request.method == "GET":
        queryset = ManualTestRecord.objects.filter(input_point__assessment__in=accessible).select_related("input_point__assessment", "recorded_by")
        input_id = request.GET.get("input")
        if input_id:
            queryset = queryset.filter(input_point_id=input_id)
        return JsonResponse({"manualTests": [serialize_manual_test(item) for item in queryset]})
    data = body_json(request)
    try:
        input_id = UUID(str(data.get("inputId")))
    except (ValueError, TypeError, AttributeError):
        raise APIError("Choose a valid input point.") from None
    input_point = InputPoint.objects.filter(pk=input_id, assessment__in=accessible).select_related("assessment").first()
    if input_point is None:
        raise APIError("Input point not found.", 404)
    assessment = input_point.assessment
    ensure_assessment_editable(assessment)
    if (
        assessment.status != Assessment.Status.IN_PROGRESS
        or assessment.approval != Assessment.Approval.APPROVED
        or not assessment.authorization_confirmed
    ):
        raise APIError("Manual test records require an In Progress assessment with approved scope and documented authorization.")
    item = ManualTestRecord.objects.create(
        input_point=input_point,
        recorded_by=request.user,
        **validate_manual_test_data(data),
    )
    record_activity(request.user, "recorded manual input test", f"{input_point.route} · {input_point.name} · {item.category}")
    return JsonResponse({"manualTest": serialize_manual_test(item)}, status=201)


@api_view
@require_role(Membership.Role.ANALYST, Membership.Role.REVIEWER)
@require_http_methods(["GET", "POST"])
def ai_analysis(request):
    if request.method == "GET":
        return JsonResponse({"connected": provider_configured()})

    data = body_json(request)
    if not provider_configured():
        return JsonResponse({"mode": "simulated", "analysis": None})
    if data.get("confirmSanitized") is not True:
        raise APIError("Review the selected records and confirm they contain no secrets or personal information before sending them to the configured AI provider.")
    try:
        finding_id = UUID(str(data.get("findingId")))
    except (ValueError, TypeError, AttributeError):
        raise APIError("Choose a valid finding.") from None
    finding = Finding.objects.filter(
        pk=finding_id,
        assessment__in=accessible_assessments(request.user),
    ).select_related("assessment", "input_point").first()
    if finding is None:
        raise APIError("Finding not found.", 404)
    if (
        finding.assessment.approval != Assessment.Approval.APPROVED
        or not finding.assessment.authorization_confirmed
    ):
        raise APIError("AI analysis requires approved scope and documented authorization.")

    try:
        analysis = analyze_with_provider(build_analysis_context(finding))
    except AIProviderError as error:
        raise APIError(str(error), 502) from None
    return JsonResponse({"mode": "ai", "analysis": analysis})


def validate_finding_data(data, assessment, existing=None):
    input_id = data.get("inputId", str(existing.input_point_id) if existing else "")
    try:
        input_id = UUID(str(input_id))
    except (ValueError, TypeError, AttributeError):
        raise APIError("Choose an input point belonging to this assessment.") from None
    input_point = InputPoint.objects.filter(pk=input_id, assessment=assessment).first()
    if input_point is None:
        raise APIError("Choose an input point belonging to this assessment.")
    severity = data.get("severity", existing.severity if existing else None)
    if severity not in Finding.Severity.values:
        raise APIError("Select a valid finding severity.")
    confidence = data.get("confidence", existing.confidence if existing else 50)
    if isinstance(confidence, bool) or not isinstance(confidence, int) or not 0 <= confidence <= 100:
        raise APIError("Confidence must be a whole number from 0 to 100.")
    return {
        "assessment": assessment,
        "input_point": input_point,
        "title": required_text(data, "title", "Finding title", 220),
        "category": required_text(data, "category", "Finding category", 80),
        "severity": severity,
        "confidence": confidence,
        "description": required_text(data, "description", "Observed behavior", 10000),
        "impact": optional_text(data, "impact", 10000),
        "remediation": optional_text(data, "remediation", 10000),
    }


@api_view
@require_role(Membership.Role.ANALYST)
@require_http_methods(["GET", "POST"])
def findings(request):
    if request.method == "GET":
        queryset = Finding.objects.filter(assessment__in=accessible_assessments(request.user)).select_related("input_point", "reviewer")
        assessment_id = request.GET.get("assessment")
        if assessment_id:
            queryset = queryset.filter(assessment_id=assessment_id)
        return JsonResponse({"findings": [serialize_finding(item) for item in queryset]})
    data = body_json(request)
    assessment = get_assessment(request.user, data.get("assessment"))
    ensure_assessment_editable(assessment)
    item = Finding.objects.create(**validate_finding_data(data, assessment))
    record_activity(request.user, "documented finding", item.title)
    return JsonResponse({"finding": serialize_finding(item)}, status=201)


@api_view
@require_role(Membership.Role.ANALYST)
@require_http_methods(["PUT", "PATCH"])
def finding_detail(request, finding_id):
    item = Finding.objects.filter(pk=finding_id, assessment__in=accessible_assessments(request.user)).first()
    if item is None:
        raise APIError("Finding not found.", 404)
    ensure_assessment_editable(item.assessment)
    data = body_json(request)
    assessment = get_assessment(request.user, data.get("assessment", str(item.assessment_id)))
    fields = validate_finding_data(data, assessment, item)
    for key, value in fields.items():
        setattr(item, key, value)
    item.save()
    record_activity(request.user, "updated finding", item.title)
    return JsonResponse({"finding": serialize_finding(item)})


@api_view
@require_role(Membership.Role.REVIEWER)
@require_POST
def review_finding(request, finding_id):
    item = Finding.objects.filter(pk=finding_id, assessment__in=accessible_assessments(request.user)).first()
    if item is None:
        raise APIError("Finding not found.", 404)
    ensure_assessment_editable(item.assessment)
    data = body_json(request)
    validation = data.get("validation")
    if validation not in (Finding.Validation.CONFIRMED, Finding.Validation.FALSE_POSITIVE):
        raise APIError("Review status must be Confirmed or False Positive.")
    evidence = list(item.evidence.all())
    if not evidence:
        raise APIError("Add supporting evidence before recording a review conclusion.")
    if any(not record.redaction_confirmed for record in evidence):
        raise APIError("Every linked evidence record must have redaction confirmed before review.")
    item.validation = validation
    item.reviewer = request.user
    item.reviewed_at = timezone.now()
    item.save(update_fields=["validation", "reviewer", "reviewed_at", "updated_at"])
    record_activity(request.user, f"reviewed finding as {validation.lower()}", item.title)
    return JsonResponse({"finding": serialize_finding(item)})


@api_view
@require_role(Membership.Role.ANALYST)
@require_http_methods(["GET", "POST"])
def evidence(request):
    if request.method == "GET":
        queryset = Evidence.objects.filter(finding__assessment__in=accessible_assessments(request.user)).select_related("finding", "input_point")
        return JsonResponse({"evidence": [serialize_evidence(item) for item in queryset]})
    data = body_json(request)
    finding = Finding.objects.filter(pk=data.get("findingId"), assessment__in=accessible_assessments(request.user)).first()
    if finding is None:
        raise APIError("Choose a finding in an assessment you can access.")
    try:
        input_id = UUID(str(data.get("inputId")))
    except (ValueError, TypeError, AttributeError):
        raise APIError("Choose the input point affected by this finding.") from None
    input_point = InputPoint.objects.filter(pk=input_id, assessment=finding.assessment).first()
    if input_point is None or input_point.pk != finding.input_point_id:
        raise APIError("Evidence must reference the input point affected by this finding.")
    ensure_assessment_editable(finding.assessment)
    redaction = data.get("redacted")
    if redaction is not True:
        raise APIError("Confirm redaction before saving evidence.")
    observed_at = required_date(data, "date", "Observation date")
    item = Evidence.objects.create(
        finding=finding,
        input_point=input_point,
        title=required_text(data, "title", "Evidence title", 220),
        kind=required_text(data, "kind", "Evidence type", 80) if data.get("kind") else "Analyst note",
        observed_at=observed_at,
        notes=required_text(data, "notes", "Observation notes", 10000),
        reproduction_steps=optional_text(data, "reproductionSteps", 10000),
        request_excerpt=optional_text(data, "request", 10000),
        response_excerpt=optional_text(data, "response", 10000),
        screenshot_reference=optional_text(data, "reference", 500),
        redaction_confirmed=True,
        created_by=request.user,
    )
    record_activity(request.user, "recorded evidence", item.title)
    return JsonResponse({"evidence": serialize_evidence(item)}, status=201)


@api_view
@require_GET
def reports(request):
    queryset = ReportSubmission.objects.filter(assessment__in=accessible_assessments(request.user)).select_related("assessment", "submitted_by")
    return JsonResponse({"reports": [serialize_report(item) for item in queryset]})


def build_report_snapshot(assessment, user):
    findings = list(assessment.findings.select_related("input_point", "reviewer").prefetch_related("evidence"))
    manual_tests = list(ManualTestRecord.objects.filter(input_point__assessment=assessment).select_related("input_point", "recorded_by"))
    counts = {severity: sum(finding.severity == severity for finding in findings) for severity in Finding.Severity.values}
    evidence = []
    for finding in findings:
        for record in finding.evidence.all():
            evidence.append({
                "title": record.title,
                "finding": finding.title,
                "date": record.observed_at.isoformat(),
                "notes": record.notes,
                "reproductionSteps": record.reproduction_steps,
                "request": record.request_excerpt,
                "response": record.response_excerpt,
                "reference": record.screenshot_reference,
                "redacted": record.redaction_confirmed,
            })
    return {
        "title": assessment.name,
        "organization": assessment.organization,
        "scope": assessment.scope,
        "approval": assessment.approval,
        "period": f"{assessment.start_date.isoformat()} — {assessment.end_date.isoformat()}",
        "limitations": assessment.notes,
        "status": assessment.status,
        "submittedBy": user.get_full_name() or user.username,
        "findingsBySeverity": counts,
        "findings": [{
            "id": str(finding.id),
            "title": finding.title,
            "category": finding.category,
            "severity": finding.severity,
            "validation": finding.validation,
            "confidence": finding.confidence,
            "input": f"{finding.input_point.route} · {finding.input_point.name}",
            "description": finding.description,
            "impact": finding.impact,
            "remediation": finding.remediation,
            "reviewer": (finding.reviewer.get_full_name() or finding.reviewer.username) if finding.reviewer else "Unassigned",
            "evidence": [record.title for record in finding.evidence.all()],
        } for finding in findings],
        "manualTests": [{
            "input": f"{item.input_point.route} · {item.input_point.name}",
            "category": item.category,
            "description": item.description,
            "expectedBehavior": item.expected_behavior,
            "actualBehavior": item.actual_behavior,
            "evidenceReference": item.evidence_reference,
            "result": item.result,
            "recordedBy": item.recorded_by.get_full_name() or item.recorded_by.username,
            "recordedAt": item.recorded_at.isoformat(),
        } for item in manual_tests],
        "evidence": evidence,
        "methodology": "This workspace records manually entered observations and evidence for an authorized scope. TrustLens performs no automated scanning, crawling, or exploit testing.",
        "aiDisclosure": "AI analysis may be generated through an optional configured provider. Any AI output is advisory, requires human review, and is not included in this report snapshot.",
        "retestingPlan": [
            "Reconfirm written authorization and the in-scope environment.",
            "Review each finding and the linked sanitized evidence.",
            "Verify remediation in a controlled, authorized environment using benign test data.",
            "Record retest evidence and have a reviewer independently validate the outcome.",
        ],
    }


@api_view
@require_role(Membership.Role.REVIEWER)
@require_POST
def submit_report(request):
    data = body_json(request)
    assessment = get_assessment(request.user, data.get("assessment"))
    if assessment.reports.exists():
        raise APIError("A final report has already been submitted for this assessment. Create a follow-up assessment for additional work.", 409)
    if assessment.approval != Assessment.Approval.APPROVED or not assessment.authorization_confirmed:
        raise APIError("Report submission requires approved scope and documented authorization confirmation.")
    if assessment.status not in (Assessment.Status.UNDER_REVIEW, Assessment.Status.COMPLETED):
        raise APIError("Move the assessment to Under Review or Completed before submitting its report.")
    if assessment.findings.filter(validation=Finding.Validation.SUSPECTED).exists():
        raise APIError("Review every suspected finding as Confirmed or False Positive before submitting.")
    if assessment.findings.filter(evidence__redaction_confirmed=False).exists():
        raise APIError("Confirm redaction on all evidence before submitting the report.")
    with transaction.atomic():
        snapshot = build_report_snapshot(assessment, request.user)
        report = ReportSubmission.objects.create(assessment=assessment, submitted_by=request.user, report_data=snapshot)
        if assessment.status != Assessment.Status.COMPLETED:
            assessment.status = Assessment.Status.COMPLETED
            assessment.save(update_fields=["status", "updated_at"])
        record_activity(request.user, "submitted assessment report", assessment.name)
    return JsonResponse({"report": serialize_report(report)}, status=201)


def report_styles():
    styles = getSampleStyleSheet()
    for name, style in styles.byName.items():
        style.fontName = "TrustLens-Bold" if name.startswith("Heading") or name == "Title" else "TrustLens"
    styles.add(ParagraphStyle(name="ReportTitle", parent=styles["Title"], textColor=colors.HexColor("#15243a"), fontSize=22, leading=28, alignment=0, spaceAfter=6))
    styles.add(ParagraphStyle(name="SectionHeading", parent=styles["Heading2"], textColor=colors.HexColor("#177f82"), fontSize=12, leading=16, spaceBefore=12, spaceAfter=5))
    styles.add(ParagraphStyle(name="BodySmall", parent=styles["BodyText"], textColor=colors.HexColor("#45566c"), fontSize=9, leading=13, spaceAfter=5))
    styles.add(ParagraphStyle(name="MutedSmall", parent=styles["BodyText"], textColor=colors.HexColor("#748196"), fontSize=8, leading=11, spaceAfter=4))
    styles.add(ParagraphStyle(name="Callout", parent=styles["BodyText"], textColor=colors.HexColor("#725b39"), backColor=colors.HexColor("#fff8ec"), borderColor=colors.HexColor("#eedfbe"), borderWidth=.5, borderPadding=8, fontSize=8, leading=12, spaceAfter=8))
    return styles


def safe_paragraph(value):
    text = str("Not provided" if value is None else value)
    supported = pdfmetrics.getFont("TrustLens").face.charWidths
    text = "".join(character if ord(character) in supported else "?" for character in text)
    return escape(text).replace("\n", "<br/>")


def report_pdf_bytes(report):
    font_directory = Path(reportlab_path).resolve().parent / "fonts"
    if "TrustLens" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("TrustLens", str(font_directory / "Vera.ttf")))
        pdfmetrics.registerFont(TTFont("TrustLens-Bold", str(font_directory / "VeraBd.ttf")))
        pdfmetrics.registerFontFamily("TrustLens", normal="TrustLens", bold="TrustLens-Bold", italic="TrustLens", boldItalic="TrustLens-Bold")
    snapshot = report.report_data
    buffer = BytesIO()
    document = SimpleDocTemplate(buffer, pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm, topMargin=17 * mm, bottomMargin=17 * mm, title=safe_paragraph(snapshot["title"]))
    styles = report_styles()
    story = [
        Paragraph("TRUSTLENS AI · SECURITY ASSESSMENT", styles["MutedSmall"]),
        Paragraph(safe_paragraph(snapshot["title"]), styles["ReportTitle"]),
        Paragraph(f"{safe_paragraph(snapshot['organization'])} · {safe_paragraph(snapshot['period'])}", styles["BodySmall"]),
        Paragraph("<b>SUBMITTED REPORT</b> · Submitted by " + safe_paragraph(snapshot["submittedBy"]) + " · " + safe_paragraph(report.submitted_at.strftime("%Y-%m-%d %H:%M UTC")), styles["MutedSmall"]),
        Spacer(1, 5 * mm),
        Paragraph("<b>User-entered assessment data.</b> TrustLens does not independently verify authorization or reproduce reported behavior. Confirm scope and conclusions with the responsible assessment team.", styles["Callout"]),
    ]
    sections = [
        ("01 · Executive summary", [
            f"Assessment {snapshot['title']} for {snapshot['organization']} documented {len(snapshot['findings'])} finding(s).",
            "Severity counts: " + ", ".join(f"{severity}: {count}" for severity, count in snapshot["findingsBySeverity"].items()) + ".",
        ]),
        ("02 · Scope and authorization", [
            f"Authorized target scope: {snapshot['scope']}",
            f"Approval status: {snapshot['approval']}",
            f"Assessment period: {snapshot['period']}",
        ]),
        ("03 · Methodology and limitations", [snapshot["methodology"], f"Testing limitations: {snapshot['limitations'] or 'No additional limitations were recorded.'}"]),
        ("04 · Findings summary by severity", [", ".join(f"{severity}: {count}" for severity, count in snapshot["findingsBySeverity"].items())]),
    ]
    for heading, paragraphs in sections:
        story.append(Paragraph(heading, styles["SectionHeading"]))
        story.extend(Paragraph(safe_paragraph(text), styles["BodySmall"]) for text in paragraphs)
    story.append(Paragraph("05 · Detailed findings and evidence", styles["SectionHeading"]))
    if not snapshot["findings"]:
        story.append(Paragraph("No findings were recorded for this assessment at submission time.", styles["BodySmall"]))
    for finding in snapshot["findings"]:
        story.append(Paragraph(safe_paragraph(f"{finding['id']} · {finding['title']}"), styles["Heading3"]))
        for label, value in (
            ("Category / severity / status", f"{finding['category']} / {finding['severity']} / {finding['validation']}"),
            ("Affected input", finding["input"]),
            ("Observed behavior", finding["description"]),
            ("Potential impact", finding["impact"]),
            ("Remediation", finding["remediation"]),
            ("Reviewer / confidence", f"{finding['reviewer']} / {finding['confidence']}%"),
            ("Evidence references", ", ".join(finding["evidence"]) or "No linked evidence"),
        ):
            story.append(Paragraph(f"<b>{safe_paragraph(label)}:</b> {safe_paragraph(value)}", styles["BodySmall"]))
    story.append(Paragraph("06 · Manual input test records", styles["SectionHeading"]))
    if snapshot["manualTests"]:
        for item in snapshot["manualTests"]:
            story.append(Paragraph(safe_paragraph(f"{item['category']} · {item['input']} · {item['result']}"), styles["Heading3"]))
            for label, value in (
                ("Test description", item["description"]),
                ("Expected behavior", item["expectedBehavior"]),
                ("Actual observed behavior", item["actualBehavior"]),
                ("Evidence reference", item["evidenceReference"]),
                ("Recorded by", item["recordedBy"]),
            ):
                if value:
                    story.append(Paragraph(f"<b>{safe_paragraph(label)}:</b> {safe_paragraph(value)}", styles["BodySmall"]))
    else:
        story.append(Paragraph("No manual input test records were submitted.", styles["BodySmall"]))
    story.append(Paragraph("07 · Evidence register", styles["SectionHeading"]))
    if snapshot["evidence"]:
        rows = [[safe_paragraph(value) for value in ("Evidence", "Finding", "Observed", "Redacted")]]
        rows.extend([[safe_paragraph(value) for value in (e["title"], e["finding"], e["date"], "Yes" if e["redacted"] else "No")] for e in snapshot["evidence"]])
        table = Table(rows, repeatRows=1, colWidths=[48 * mm, 54 * mm, 30 * mm, 22 * mm])
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef5f4")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#30585b")),
            ("GRID", (0, 0), (-1, -1), .35, colors.HexColor("#dfe7e9")),
            ("FONTSIZE", (0, 0), (-1, -1), 7),
            ("FONTNAME", (0, 0), (-1, 0), "TrustLens-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "TrustLens"),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(table)
        for evidence in snapshot["evidence"]:
            story.append(Paragraph(safe_paragraph(evidence["title"]), styles["Heading3"]))
            for label, value in (
                ("Finding", evidence["finding"]),
                ("Observation", evidence["notes"]),
                ("Reproduction steps", evidence["reproductionSteps"]),
                ("Sanitized request excerpt", evidence["request"]),
                ("Sanitized response excerpt", evidence["response"]),
                ("Screenshot reference", evidence["reference"]),
            ):
                if value:
                    story.append(Paragraph(f"<b>{safe_paragraph(label)}:</b> {safe_paragraph(value)}", styles["BodySmall"]))
    else:
        story.append(Paragraph("No evidence records were linked at submission time.", styles["BodySmall"]))
    story.extend([
        Paragraph("08 · AI usage disclosure", styles["SectionHeading"]),
        Paragraph(safe_paragraph(snapshot["aiDisclosure"]), styles["BodySmall"]),
        Paragraph("09 · Retesting plan", styles["SectionHeading"]),
    ])
    for index, step in enumerate(snapshot["retestingPlan"], start=1):
        story.append(Paragraph(f"{index}. {safe_paragraph(step)}", styles["BodySmall"]))

    def draw_footer(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor("#e6ecef"))
        canvas.line(18 * mm, 13 * mm, A4[0] - 18 * mm, 13 * mm)
        canvas.setFont("TrustLens", 7)
        canvas.setFillColor(colors.HexColor("#8793a2"))
        canvas.drawString(18 * mm, 8 * mm, "TrustLens AI · Confidential assessment report")
        canvas.drawRightString(A4[0] - 18 * mm, 8 * mm, f"Page {doc.page}")
        canvas.restoreState()

    document.build(story, onFirstPage=draw_footer, onLaterPages=draw_footer)
    return buffer.getvalue()


@api_view
@require_GET
def report_pdf(request, report_id):
    report = ReportSubmission.objects.filter(pk=report_id, assessment__in=accessible_assessments(request.user)).select_related("assessment").first()
    if report is None:
        raise APIError("Submitted report not found.", 404)
    response = HttpResponse(report_pdf_bytes(report), content_type="application/pdf")
    response["Content-Disposition"] = f'attachment; filename="TrustLens-report-{report.assessment_id}.pdf"'
    response["Cache-Control"] = "private, no-store"
    return response
