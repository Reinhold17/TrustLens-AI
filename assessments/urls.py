from django.urls import path

from . import views


urlpatterns = [
    path("csrf/", views.csrf_token, name="csrf"),
    path("session/", views.session, name="session"),
    path("register/", views.register_view, name="register"),
    path("login/", views.login_view, name="login"),
    path("logout/", views.logout_view, name="logout"),
    path("bootstrap/", views.bootstrap, name="bootstrap"),
    path("assessments/", views.assessments, name="assessments"),
    path("assessments/<uuid:assessment_id>/", views.assessment_detail, name="assessment-detail"),
    path("assessments/<uuid:assessment_id>/archive/", views.archive_assessment, name="archive-assessment"),
    path("inputs/", views.inputs, name="inputs"),
    path("inputs/<uuid:input_id>/", views.input_detail, name="input-detail"),
    path("manual-tests/", views.manual_tests, name="manual-tests"),
    path("ai-analysis/", views.ai_analysis, name="ai-analysis"),
    path("findings/", views.findings, name="findings"),
    path("findings/<uuid:finding_id>/", views.finding_detail, name="finding-detail"),
    path("findings/<uuid:finding_id>/review/", views.review_finding, name="review-finding"),
    path("evidence/", views.evidence, name="evidence"),
    path("reports/", views.reports, name="reports"),
    path("reports/submit/", views.submit_report, name="submit-report"),
    path("reports/<uuid:report_id>/pdf/", views.report_pdf, name="report-pdf"),
]
