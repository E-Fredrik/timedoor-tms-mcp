# Timedoor TMS MCP server

An MCP server that lets Claude work with the Timedoor Academy teacher portal (https://cms.timedooracademy.com/tms) as you. It logs in through the portal's own login API (no browser), keeps the session in a private file, reads your lists, works out report meeting ranges, fills in daily journal drafts with evidence photos, approves student projects, and sends journals to parents, by hand or automatically.

## Honest status

Tested: input validation, the report range logic (using the exact response shape captured from your portal), photo checks and real PDF to image rendering, the journal save flow against a fake page, the MCP protocol, and the installer.

NOT tested against the live portal: the login, the real form clicks, and the photo upload widget. Those were written from what was observed on the pages, so the first live run is a real test. Start with dry runs (see below).

## Tools

| Tool | What it does |
| --- | --- |
| tms_auth_status | Logs in and reports whether the session and API access work. Run this first. |
| tms_list_pending_journals | Journals still to write (not created or draft), with the ids you need. |
| tms_get_meeting_journal | Meeting details and the existing journal for one student meeting. |
| tms_save_journal_draft | Fills the journal form (notes, project, active project, up to 2 photos) and clicks Save as Draft. Never submits. |
| tms_find_report_range | For a student and book, finds the FROM and END meetings of a report from the exam lesson number. Read only. |
| tms_check_report_gaps | Manual report audit. Ignores the portal status (known bug). Compares each report's meeting range with the meeting history and lists missing blocks, e.g. at Lesson 22 with only a Lessons 1 to 8 report it flags 9 to 16. One student or all students. Read only. |
| tms_submit_journal | Submits an existing draft (needs note, AI summary, 1 to 2 photos already on it). Preview unless confirm=true. |
| tms_list_low_scores | Pending journals with a lesson quiz score below 75. Read only. Never changes grades. |
| tms_prepare_report | Read only. For a student and range: report language, ALL criteria of the course (3 or 4) with the portal's template in that language, journals in range, quiz scores below 75. |
| tms_create_report | Creates the report. Needs a score and a note for every criterion, in the student's language, no leftover placeholders. Preview unless confirm=true. |
| tms_check_attendance_gaps | Read only. Ended sessions with no attendance recorded, unapproved attendance, absence and lateness counts. |
| tms_update_lesson_scores | Changes quiz scores on an existing draft journal. Preview unless confirm=true. Unproven on the live site. |
| tms_list_journals_to_send | Read only. Journals that are submitted but not yet sent to parents (status created or revision), per class session, with the ids to send them. Default last 7 days, or one class with attendance_id or class_search. |
| tms_send_journal_to_parent | Sends one submitted journal to the parents by pressing the portal's own Send to Parent button. Preview unless confirm=true. Never re sends a sent journal. |
| tms_batch_journal_drafts | Up to 10 journal drafts in one call, optional AI summary each. Dry run unless confirm=true. |
| tms_get_class_attendance | Read only. One class session with its status and every student row (row_id, name, presence). Use it before marking. |
| tms_start_class | Starts a class and saves who is present, late or absent in one request (the portal's Start Class). Preview unless confirm=true. Reads back to verify. |
| tms_mark_attendance | Marks students present, late or absent in a class already started. Preview unless confirm=true. Reads back to verify. |
| tms_find_student | Read only. Finds your students whose name contains the text (case ignored) with id, code, status and the portal student detail for up to 5 matches. |
| tms_list_students, tms_list_classes | Your students and classes. |
| tms_list_report_reminders, tms_list_student_reports | Report reminders and existing reports. Read only. |

## Login and saved session (changed 5 Nov 2026)

How the portal logs in (read from its own code): one POST to /api/tms/auth/login with username and password returns an access token and a refresh token. Every API call sends the access token as a Bearer header. When it expires the portal calls /api/auth/refresh-token with the refresh token.

This server now does the same, with no browser:
1. It reads the saved session file (~/.config/timedoor-tms-mcp/session.json, owner only, tokens only, never the password).
2. If the portal answers 401 it uses the refresh token and saves the new tokens.
3. Only if that fails does it log in again with TMS_USERNAME and TMS_PASSWORD.

The browser is now only started for two steps that need the real page: uploading journal photos and pressing Send to Parent (the page draws the journal image itself). It opens already signed in, by loading the saved tokens as the portal's own cookies, so the password is never typed into a page. tms_forget_session deletes the saved session.

NOT proven live before release: the token login and refresh were built from the portal's code and tested against a fake portal. tms_auth_status is the first live check.

## Project approvals

How the portal works: the Project Approvals page lists projects with status on_review. Approve and Reject send one request, PATCH /api/v2/tms/student/{student}/book/{book}/project/{project}/status with {"status": "approved"} or {"status": "rejected"}. The portal only enables these buttons when the student attached a file or a link. There is no comment field.

Tools: tms_list_project_approvals, tms_set_project_status (one project, preview unless confirm=true), tms_auto_approve_projects.

## Automatic rules

Your classes = classes where your teacher id is listed with role main (tms_list_my_classes shows them). Substitute and assistant roles are never touched.

tms_auto_approve_projects: approves every waiting project in your classes that has a file or link. Never rejects. At most 30 per run by default. Each approval is read back.

tms_auto_send_journals: for the class sessions you taught on a date (default today), sends every submitted journal (status created) that is not sent yet. A journal with any quiz score below 75 is held and listed instead of sent. Drafts, missing journals and revision journals are listed for you.

Both are dry runs unless confirm=true or their switch is on in tms.config.json (read on every call):

    { "autoApproveProjects": false, "autoSendJournals": false }

tms_automation_settings shows or changes the switches. Every approval and send is written to ~/.config/timedoor-tms-mcp/actions.log.

## Photo inbox

Set TMS_PHOTO_DIR to the folder your class photos go into (an iCloud Drive folder lets your phone save straight into it). tms_list_inbox_photos lists them with the time each photo was taken (from the photo's metadata on macOS), so they can be matched to a class session and passed to tms_save_journal_draft.

## Report meeting rule

Reports cover a block of 8 lessons that ends with an exam (Lesson 8, 16, 24, 32). Give tms_find_report_range the exam lesson number. The END meeting is where that lesson was taught, and the FROM meeting is where the first lesson of the block was taught (exam lesson minus 7, so Lesson 8 starts at Lesson 1). If a lesson was taught more than once it uses the most recent one on or before the exam and tells you. If a lesson is missing it stops and lists the lessons it did find, plus any that look like exams.

## Report gap check and quiz warnings

Gap check: a block (Lessons 1 to 8, 9 to 16, ...) counts as done only when an existing report's name range ("Meeting A - Meeting B") covers the meeting where the block's first lesson was taught through the meeting where its exam lesson was taught. States: done, missing, partial, unlocatable, upcoming. Limits you should know: it relies on report NAMES, so a report with an unreadable name is listed in warnings and not counted. A short final block (for example Lessons 17 to 20) is only detected for the latest book of a session, where the portal gives a total lesson count.

Quiz warnings: tms_save_journal_draft returns quiz_check (also on dry runs) and tms_find_report_range returns quiz_check for the block. Scores below 75 are called out in attention. Scores are only visible for meetings still in the pending journal list, so for submitted journals the check says "not available" instead of guessing. A score of 0 or blank is treated as not scored (an inference, listed separately). Use tms_update_lesson_scores to change a score (also on created journals).

## Creating a report

How the portal works (read from its own code and pages): the From and Until lists only offer meetings that have a CREATED journal, so a report can only start and end on those. The form has 3 steps: meetings, criteria (a score 0 to 100 and a note per criterion, with English and Indonesian templates), preview. The final Next on the preview step creates the report immediately. There is no draft state.

Flow with this server: run tms_prepare_report, give me a score for every criterion, I write each note in the student's language, you approve, then tms_create_report with confirm=true. The language comes from the book's lang field in the portal (en or id). That this field means the student's chosen language is my inference, so check it on the first few.

Safety: refuses missing criteria, leftover (student_name) placeholders, notes in the wrong language (a rough word check, override with allow_language_mismatch), duplicates, and ranges whose first or last meeting has no created journal.

NOT proven live: the report POST itself. Its body was read from the portal code (journal ids plus criteria id, score, note) but I deliberately did not press the final button on a real student while exploring.

## Sending journals to parents

How the portal works (read from its own code on 5 Nov 2026): a journal goes not_created, draft, created (submitted), then sent. The Class Attendance page shows "Send Daily Journal" for created and revision journals and "View Daily Journal" for sent ones. Opening a created journal shows a preview with Download PDF and Send to Parent. Pressing Send to Parent makes the page render the journal as an image, upload it, and POST it to .../journal/{id}/send-journal. The branch setting says it goes to parents via WhatsApp. There is no confirmation dialog in the portal, the click sends immediately.

Flow with this server: tms_list_journals_to_send, then tms_send_journal_to_parent without confirm (preview: note, AI summary, photos, quiz scores below 75, and a check that the button is there), you approve, then the same call with confirm=true. It clicks the real button, waits for the portal's send request, and reads the journal back to check it is marked sent.

Safety: refuses drafts, journals with no journal yet, and anything already sent. If it cannot tell whether the send happened, it says so instead of retrying.

NOT proven live yet: the confirmed click. Everything up to it (finding the button on a real page) can be checked with the preview. Revision journals: the portal only opens the preview automatically for created journals, so a revision may need sending by hand.

Fixed on 5 Nov 2026: the attendance list was asked for plain dates, and the portal treats the end date as midnight, so the last day of every range was left out (tms_check_attendance_gaps was affected too). It now sends full Jakarta day bounds like the portal's own page.

## AI summary and batch drafts

tms_save_journal_draft and tms_batch_journal_drafts accept generate_ai_summary. The server clicks the portal's own Generate AI Summary button, so the real request is sent by the page, then saves the draft and reports whether the summary was stored. The portal says generating can save a draft by itself when none exists. Nothing is ever submitted. The pending list can include journals of other teachers, so only use meeting ids you mean.

## Grades

Scores travel with the journal save as a list of lesson id and score. tms_update_lesson_scores re sends an existing draft with new scores and reads it back. It works on draft and created journals. Existing photos are passed back as references, so nothing is re uploaded, and the read back checks the photos are still there. Sent journals are refused unless allow_sent=true. Built from the portal code, not yet proven live.

## Photos

HEIC photos are converted to a JPEG copy with macOS sips before upload (the portal returned a 500 on a raw HEIC; that this is the cause is my best guess, not confirmed). If an upload fails, the error now includes the portal's status.

The upload control takes JPG, PNG or HEIC, one file at a time, up to 2 photos, 15 MB each. Pass file paths that exist on THIS computer in the photos argument. A PDF also works: its first pages are turned into images (2 photos in total). Real file type is checked from the file contents, not the name. Photos are not uploaded during a dry run.

Photos you attach in chat: Claude copies them into the Mac folder (TMS_PHOTO_DIR) first, then passes those paths here.

Tip: keep photos in one folder and set TMS_PHOTO_DIR in .env to that folder. Photo paths outside it are then refused, which stops a mistaken or tricked request from uploading some other file.

## One command setup

1. Install Node 20.12 or newer, clone this repository, open a terminal in the folder.
2. Run: npm run setup
3. It installs dependencies and the browser, builds the server, asks for your teacher username and password (typed on your computer, hidden, saved only in .env with owner only permissions), backs up your Claude Desktop config, and registers the server.
4. Fully quit and reopen Claude Desktop.

Options: --skip-credentials keeps an existing .env, --skip-register leaves Claude Desktop alone, --skip-install skips install and build.

Using Claude Code instead: the setup prints the exact "claude mcp add" command to run.

## First live test, step by step

1. Ask Claude to run tms_auth_status. If apiReady is false, tell me what it says.
2. Run tms_list_pending_journals with limit 3.
3. Pick one row and run tms_save_journal_draft with dry_run set to true.
4. Run it again without dry_run, then open the portal and check the draft.
5. Repeat with a photo path.

## Safety notes

1. Credentials are only read from .env or environment variables, are never returned by any tool, and are removed from error messages.
2. Drafts never click Save and Continue. Submitting (tms_submit_journal) and sending to parents (tms_send_journal_to_parent) only happen with confirm=true.
3. It refuses to edit a journal that already exists unless that journal is a draft or you pass overwrite_existing.
4. Change your portal password. Using the username as the password is easy to guess.
5. Known audit note: npm reports a high severity zod issue about oversized arrays. These tools take no large arrays and only talk to your own Claude, so the practical risk looks low, but it has not been independently confirmed.

## If the site changes

Routes and API paths are in src/config.ts. The journal form labels are in src/journal.ts.

## Tests

npm test runs all the automated tests. They do not touch the real site.

## Class start and attendance (added Nov 2026)

Endpoints read from the portal's front end bundle (not from documentation): Start Class and presence save use POST /api/tms/attendance/{id}/start-update-and-send-key with {payload: [...student rows]}; presence changes on a started class use PATCH /api/tms/attendance/{id}/update-participant. Each row keeps the portal's own fields and only presence and rents change. Late needs late_minutes (1 to 180).

NOT proven live: nothing has been sent to the real portal yet. Run tms_get_class_attendance, then tms_start_class or tms_mark_attendance without confirm, check the preview, then confirm on a test class.

NOT built: ending a class. The teacher part of the portal bundle has no end or finish call. The only finish call found is under /api/cms/attendance/{id}/finish, which is the admin side and was not used.

Student search (tms_find_student): uses the portal student list search, then keeps only rows whose name contains the text. The detail comes from GET /api/tms/student/{id}, read from the portal bundle and not yet proven live.

## Portal update, 14 Nov 2026

Found by reading the portal's own front end code and checked with read only calls on the live site.

**Class start bug fixed.** `tms_mark_attendance` on a class that was never started (portal status `active`, which only means scheduled) used to save presence only: students showed present, the class stayed not started and no key went out. It now starts the class first, the same as `tms_start_class`, and the preview says `will_start_class`. `tms_get_class_attendance` also returns `started: true/false`.

A server that was already running keeps its old code. After any rebuild, restart Claude (or reconnect the MCP server) so the new build is loaded.

**New tools**

| Tool | What it does |
| --- | --- |
| `tms_get_lesson_access` | One student's lessons: locked or unlocked, progress percent, finished. Read only. |
| `tms_set_lesson_access` | `unlock_through` lesson N (first lesson to N) or `lock_from` lesson N (N to the last), like the portal buttons. Preview unless `confirm=true`. |
| `tms_list_courses` | Courses, or the books of one course. Read only. |
| `tms_get_book_lessons` | Chapters and lessons of a course book. Read only. |
| `tms_set_report_status` | Approve or delete one existing report. Preview unless `confirm=true`. |
| `tms_portal_get` | Read only GET of any teacher API path (schedule, time off, dashboard, events, quiz and exam lists ...). |

**Reports.** The portal's Create Report page is now lesson based. `tms_prepare_report` and `tms_create_report` detect this per book and then use the portal's own lesson ranges: pass `exam_lesson` (8, 16, 24 ...). The portal refuses a report while any learned lesson in the range has no daily journal, and the tools say which lessons. Books still on the old form work as before with meeting numbers. `tms_check_report_gaps` understands reports named "Lesson 9 - Lesson 16".

**Progress sheet.** `tms_sync_lesson_progress` can be called without `lesson`: it takes the highest lesson the portal shows as finished. `tms_batch_journal_drafts` now runs the sheet sync after each saved draft, like the single save always did, and a dry run never touches the sheet. Writing is still off until `TMS_SHEET_SYNC_ENABLED=true` in `.env`.

**Not proven on the live site yet** (built from the portal's code, tested against a fake portal only): the confirmed unlock and lock writes, creating a lesson based report, approving and deleting a report, and the start call inside `tms_mark_attendance`.

## Your own settings

Nothing personal ships with this repository. Each teacher uses their own `.env` (never committed):

- `TMS_USERNAME` and `TMS_PASSWORD`: your own portal login. `npm run setup` asks for them.
- Progress sheet sync (optional): set `TMS_SHEET_ID`, `TMS_SHEET_GID`, `TMS_SHEET_FIRST_ROW`, `TMS_SHEET_LESSON1_DATE_COLUMN`, `TMS_SHEET_CREDENTIALS` (path to a Google service account key that can edit the sheet) and `TMS_SHEET_HIGHLIGHT_COLOR`.
- `TMS_SHEET_HIGHLIGHT_COLOR` is the colour finished lessons get, as hex (example: `#00ffff`). There is no default, so pick your own.

See `.env.example` for the full list.
