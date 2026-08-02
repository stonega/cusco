# Idle sidebar refresh memory growth

Date: 2026-08-02

Affected release: 0.5.30

## Summary

An installed Cusco process reached approximately 6.2 GiB of resident memory after being left open for about half a day. The application remained responsive and mostly idle, but memory increased continuously until restart.

## Impact

- Long-running sessions consumed several gigabytes of physical memory.
- Restarting Cusco recovered the memory, but the growth returned in later sessions.
- No conversation data was lost or corrupted.

## Root cause

Cusco checks cron run logs every 30 seconds. A user with no crontab receives `no crontab for <user>`, which the cron backend correctly interprets as an available, empty crontab. The window then treated every successful poll as a reason to refresh the conversation sidebar.

The refresh replaced the complete `Gtk.StringList` even when its conversation IDs were unchanged. GTK consequently unbound and rebound visible rows, recreating each row's action menu, popover, motion controller, and GJS signal closures. Those native and JavaScript ownership cycles were not released promptly, so every poll retained additional memory.

## Detection and diagnosis

The issue was reported from GNOME System Monitor after an idle half-day session. An accelerated probe used the installed code and a temporary copy of the 117-conversation database:

- The original sidebar reached about 1.16 GiB after 200 forced refreshes and continued growing, despite explicit GJS garbage collection.
- The measured increase was about 4.6 MiB per refresh, which predicts roughly 6.7 GiB over 12 hours at the 30-second polling interval.
- Repeating only the crontab subprocess operation remained stable around 34 MiB.
- Replacing the complex conversation menu rows with simple rows removed the linear growth.

## Resolution

- Cron synchronization now refreshes the sidebar and restores selection only when it creates or repairs a cron conversation or appends a new run log.
- Recycled sidebar rows explicitly disconnect action signals, remove motion controllers, and detach their popovers.
- Window shutdown detaches the list model and factory before GTK finalization.
- Regression coverage verifies that unchanged cron polls perform no sidebar or selection updates and that row cleanup releases its action popover.

## Verification

- The accelerated 200-refresh probe plateaued around 567 MiB after its initial GTK allocation high-water mark instead of growing linearly.
- The complete smoke suite passed.
- The Meson build completed successfully.

## Follow-up

- Keep recurring background synchronization change-aware; a successful poll is not itself a UI change.
- Give GTK widgets that own popovers, controllers, or GJS signal closures an explicit teardown path when used in recycled list rows.
- Retain the accelerated sidebar refresh probe as a diagnostic method when reviewing future list-row lifecycle changes.
