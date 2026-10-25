from django.contrib import admin

from .models import ActivityEntry, Assessment, Evidence, Finding, InputPoint, ManualTestRecord, Membership, ReportSubmission


@admin.register(Membership)
class MembershipAdmin(admin.ModelAdmin):
    list_display = ("user", "role")
    list_filter = ("role",)


@admin.register(Assessment)
class AssessmentAdmin(admin.ModelAdmin):
    list_display = ("name", "organization", "status", "approval", "owner", "archived")
    list_filter = ("status", "approval", "archived")
    search_fields = ("name", "organization", "scope")


@admin.register(InputPoint)
class InputPointAdmin(admin.ModelAdmin):
    list_display = ("name", "route", "kind", "status", "assessment")
    list_filter = ("kind", "status")


@admin.register(ManualTestRecord)
class ManualTestRecordAdmin(admin.ModelAdmin):
    list_display = ("category", "input_point", "result", "recorded_by", "recorded_at")
    list_filter = ("category", "result")
    search_fields = ("description", "actual_behavior", "evidence_reference")
    readonly_fields = ("recorded_by", "recorded_at")


@admin.register(Finding)
class FindingAdmin(admin.ModelAdmin):
    list_display = ("title", "severity", "validation", "assessment", "reviewer")
    list_filter = ("severity", "validation", "category")
    search_fields = ("title", "description")


@admin.register(Evidence)
class EvidenceAdmin(admin.ModelAdmin):
    list_display = ("title", "finding", "input_point", "observed_at", "redaction_confirmed")
    list_filter = ("redaction_confirmed", "kind")


@admin.register(ReportSubmission)
class ReportSubmissionAdmin(admin.ModelAdmin):
    list_display = ("assessment", "submitted_by", "submitted_at")
    readonly_fields = ("assessment", "submitted_by", "report_data", "submitted_at")


@admin.register(ActivityEntry)
class ActivityEntryAdmin(admin.ModelAdmin):
    list_display = ("actor", "action", "subject", "created_at")
    readonly_fields = ("actor", "action", "subject", "created_at")
