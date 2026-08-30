# Linear workflows

## Exact issue, project, or URL

Fetch the supplied identifier or URL directly. Verify the returned team and
workspace before applying a change. Preserve the identifier in the result so
the user can trace the source.

## Create an issue

Resolve the target team and its current workflow, labels, and members first.
Use only facts in the user's report for title, description, priority, estimate,
assignee, labels, and due date. If the target team is clear but an optional
field is unknown, omit it instead of inventing a value. Return the new issue
identifier and URL.

## Standup or meeting notes

Match notes by explicit issue ID first, then exact title or strong contextual
evidence. Show the matched issue and exact proposed comment or field update
before changing multiple issues. Keep unmatched notes separate with a short
reason.

## Project and roadmap planning

Read the source plan, then propose the project objective, scope, milestones,
issues, and relationships for review. Create the approved structure in a stable
order: project or initiative, milestones, parent issues, sub-issues, then
relationships. Add dependencies only when the source material supports them.

## Cycle and project summaries

Resolve the exact team, cycle, or date window. Gather the relevant issues and
group results by completed, active, blocked, and not started when useful. Base
progress claims on current status and activity rather than issue count alone.

## Historical timelines

Gather issues, projects, updates, and meaningful activity around the topic.
Order dated facts chronologically, cite the originating Linear objects, and
call out gaps rather than inferring events.
