import uuid

from django.conf import settings
from django.db import models


class Membership(models.Model):
    class Role(models.TextChoices):
        ADMINISTRATOR = "Administrator", "Administrator"
        ANALYST = "Analyst", "Analyst"
        REVIEWER = "Reviewer", "Reviewer"

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="trustlens_membership")
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.ANALYST)

    def __str__(self):
        return f"{self.user.get_full_name() or self.user.username} · {self.role}"


class Assessment(models.Model):
    class Status(models.TextChoices):
        PLANNING = "Planning", "Planning"
        IN_PROGRESS = "In Progress", "In Progress"
        UNDER_REVIEW = "Under Review", "Under Review"
        COMPLETED = "Completed", "Completed"

    class Approval(models.TextChoices):
        APPROVED = "Approved", "Approved"
        PENDING = "Pending", "Pending"
        NOT_REQUESTED = "Not requested", "Not requested"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=180)
    organization = models.CharField(max_length=180)
    scope = models.CharField(max_length=500)
    approval = models.CharField(max_length=20, choices=Approval.choices, default=Approval.PENDING)
    authorization_confirmed = models.BooleanField(default=False)
    start_date = models.DateField()
    end_date = models.DateField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PLANNING)
    notes = models.TextField(blank=True)
    archived = models.BooleanField(default=False)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="owned_assessments")
    team = models.ManyToManyField(settings.AUTH_USER_MODEL, related_name="team_assessments", blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-updated_at",)

    def __str__(self):
        return self.name


class InputPoint(models.Model):
    class Kind(models.TextChoices):
        FORM = "Form", "Form"
        QUERY_PARAMETER = "Query Parameter", "Query Parameter"
        SEARCH_FIELD = "Search Field", "Search Field"
        HEADER = "Header", "Header"
        OTHER = "Other", "Other"

    class ReviewStatus(models.TextChoices):
        NOT_REVIEWED = "Not reviewed", "Not reviewed"
        IN_REVIEW = "In review", "In review"
        REVIEWED = "Reviewed", "Reviewed"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    assessment = models.ForeignKey(Assessment, on_delete=models.CASCADE, related_name="input_points")
    route = models.CharField(max_length=500)
    name = models.CharField(max_length=180)
    kind = models.CharField(max_length=32, choices=Kind.choices)
    status = models.CharField(max_length=20, choices=ReviewStatus.choices, default=ReviewStatus.NOT_REVIEWED)
    notes = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("route", "name")
        constraints = [
            models.UniqueConstraint(fields=("assessment", "route", "name"), name="unique_assessment_input_point"),
        ]


class ManualTestRecord(models.Model):
    class Category(models.TextChoices):
        REQUIRED_FIELD = "Required field", "Required field"
        WHITESPACE_ONLY = "Whitespace-only input", "Whitespace-only input"
        LENGTH_LIMIT = "Length limits", "Length limits"
        FORMAT_VALIDATION = "Format validation", "Format validation"
        SPECIAL_CHARACTERS = "Special characters", "Special characters"
        OTHER = "Other", "Other"

    class Result(models.TextChoices):
        PASS = "Pass", "Pass"
        DEVIATION = "Deviation observed", "Deviation observed"
        INCONCLUSIVE = "Inconclusive", "Inconclusive"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    input_point = models.ForeignKey(InputPoint, on_delete=models.CASCADE, related_name="manual_tests")
    category = models.CharField(max_length=32, choices=Category.choices)
    description = models.CharField(max_length=1000)
    expected_behavior = models.TextField()
    actual_behavior = models.TextField()
    evidence_reference = models.CharField(max_length=500, blank=True)
    result = models.CharField(max_length=24, choices=Result.choices)
    recorded_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="manual_test_records")
    recorded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-recorded_at",)

    def __str__(self):
        return f"{self.category} · {self.input_point}"


class Finding(models.Model):
    class Severity(models.TextChoices):
        CRITICAL = "Critical", "Critical"
        HIGH = "High", "High"
        MEDIUM = "Medium", "Medium"
        LOW = "Low", "Low"
        INFORMATIONAL = "Informational", "Informational"

    class Validation(models.TextChoices):
        CONFIRMED = "Confirmed", "Confirmed"
        SUSPECTED = "Suspected", "Suspected"
        FALSE_POSITIVE = "False Positive", "False Positive"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    assessment = models.ForeignKey(Assessment, on_delete=models.CASCADE, related_name="findings")
    input_point = models.ForeignKey(InputPoint, on_delete=models.PROTECT, related_name="findings")
    title = models.CharField(max_length=220)
    category = models.CharField(max_length=80)
    severity = models.CharField(max_length=20, choices=Severity.choices)
    confidence = models.PositiveSmallIntegerField(default=50)
    validation = models.CharField(max_length=20, choices=Validation.choices, default=Validation.SUSPECTED)
    description = models.TextField()
    impact = models.TextField(blank=True)
    remediation = models.TextField(blank=True)
    reviewer = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="reviewed_findings")
    reviewed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-updated_at",)


class Evidence(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    finding = models.ForeignKey(Finding, on_delete=models.CASCADE, related_name="evidence")
    input_point = models.ForeignKey(InputPoint, on_delete=models.PROTECT, related_name="evidence")
    title = models.CharField(max_length=220)
    kind = models.CharField(max_length=80, default="Analyst note")
    observed_at = models.DateField()
    notes = models.TextField()
    reproduction_steps = models.TextField(blank=True)
    request_excerpt = models.TextField(blank=True)
    response_excerpt = models.TextField(blank=True)
    screenshot_reference = models.CharField(max_length=500, blank=True)
    redaction_confirmed = models.BooleanField(default=False)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="created_evidence")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-observed_at", "-created_at")


class ReportSubmission(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    assessment = models.ForeignKey(Assessment, on_delete=models.PROTECT, related_name="reports")
    submitted_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="report_submissions")
    report_data = models.JSONField()
    submitted_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-submitted_at",)


class ActivityEntry(models.Model):
    actor = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="trustlens_activity")
    action = models.CharField(max_length=80)
    subject = models.CharField(max_length=240)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ("-created_at",)
