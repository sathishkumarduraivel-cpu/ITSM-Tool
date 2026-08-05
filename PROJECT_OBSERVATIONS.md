# ITSM AI Project — Observations & Required Changes

*Prepared by: Sathish*
*Date: 2026-08-04*

I have gone through the ITSM AI application and listed the changes we need to make it
usable for our team. I checked each point against the actual application/code to confirm
it is genuinely missing, not just something I overlooked in the UI.

## My Observations

**1. Ticket ID should not always start with "INC"**
Right now every ticket — whether it is an Incident, Service Request, Problem, or Change —
gets an ID starting with "INC-" (example: INC-1001). We need separate ID formats for each
ticket type, for example INC- for Incidents, SR- for Service Requests, PRB- for Problems,
and CHG- for Changes. This will help us identify the ticket type just by looking at the ID.

**2. Requester details missing in ticket view**
When we open a ticket, the details panel shows status, priority, category, and team — but
it does not show who raised the ticket (requester name/email/contact). We need this added
so agents know who to follow up with without digging through comments.

**3. No edit option on the Dashboard**
The dashboard currently shows fixed charts and numbers with no way to customize what is
shown. We need an edit option so we can choose/rearrange what appears on the dashboard.

**4. No Admin Settings page**
There is currently no dedicated admin settings area in the app — no place to manage
things like company details, user/agent accounts and roles, general system preferences,
etc. We need a proper Admin Settings section.

**5. Workflow automation conditions need improvement**
The automation rules let us set a condition on ticket "type," but the value has to be
typed in as free text — there is no dropdown showing the valid options (Incident, Service
Request, Problem, Change). Because of this, it is not practical to reliably automate
Service Request tickets today. We need a proper dropdown of valid values for each
condition field so automations can be built accurately.

**6. Workflow automation actions need an "auto-approval" option**
Currently the automation actions only allow things like changing priority, status, team,
category, posting a comment, or notifying an integration. There is no action to
automatically approve a request. We need an "auto-approve" action added so simple,
low-risk requests can skip manual approval.

**7. Edit button missing in most sections**
I checked across the app — Assets, Service Catalog, Knowledge Base, SLA Policies,
Integrations, and Procurement currently have no Edit option; only Automations has one.
Everywhere else you can only create new records or view them, not edit existing ones. We
need Edit added consistently across all these sections.

**8. No filter in the Approvals section**
The Approvals page currently shows all approvals in one list with no way to filter (for
example by status, type, or requester). We need filters added so people can quickly find
the approvals relevant to them.

**9. Need rules to show/hide ticket fields**
Right now all ticket fields are fixed and always shown the same way for every ticket
type. We need a rule-based setting where admins can decide which fields should be shown
or hidden depending on ticket type/category — so, for example, a Service Request form
doesn't show irrelevant Change-only fields like "Rollback plan."

**10. Need a "Workspace" concept**
There is currently no workspace/team-separation concept — everything is one shared setup
for all teams. We need a workspace feature so different teams or departments can have
their own space if needed.

## Additional points I found while reviewing

**11. No user/agent management screen**
There is no page to add, remove, or deactivate agents, or change their role (agent/admin).
This should probably be part of the Admin Settings from point 4.

**12. No file/attachment upload on tickets**
Users cannot attach a screenshot or file to a ticket or comment. Most service desks need
this — for example, attaching an error screenshot.

**13. No search across the app**
There is no global search box to quickly find a ticket, asset, or KB article by keyword —
you have to go into each section and scroll/filter manually.

**14. Email notifications are not actually sent yet**
The system is built to send email notifications (e.g., "ticket resolved"), but right now
it only prints the message to the server console/log instead of actually emailing anyone.
Slack/Teams notifications do work for real. We should confirm with the team whether real
email sending is needed before go-live.

## Summary

The application is functional as a base/demo version, but it needs the above changes
before it can be used as our actual working tool. I'd suggest we prioritize points 1, 2,
7, and 8 first since they affect daily ticket handling, followed by 4, 5, 6, and 9, and
treat 10 (workspace), 11–14 as a second phase.
