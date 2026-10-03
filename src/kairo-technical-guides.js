// Static, source-reviewed technical guidance. No provider SDK, fetch, or tenant data.
const microsoft = (label,path) => ({label,url:`https://learn.microsoft.com/en-us/${path}`})
export const TECHNICAL_HELP_ARTICLES = [
  {
    id:'capability-map',title:'Choose a supported Kairo implementation path',section:'Overview',
    keywords:['capability','capabilities','supported','native','implementation','technical','features','boundary'],
    summary:'Separate the live tools, planning records, and external implementation references before starting.',
    prerequisites:['Confirm the selected company and your intended outcome.'],
    steps:['Use Systems, workflow inventory, Opportunities, and integration inventory to document a plan. Creating those records does not provision a service.','The current Workflow builder offers Microsoft health, profile, inbox status, upcoming calendar, and email approval steps.','Use Agents to configure records and assigned workflow permissions. Those records do not add a general-purpose AI model or arbitrary tool execution.','Use the labeled external references to plan provider-side work. Telephony is reference material: this Kairo build has no native calling, call-routing, recording, or transcription connector.','Validate permissions and a single authorized run before choosing an ongoing schedule.'],
    troubleshooting:['If a provider or action is absent from the builder, adding its name in inventory will not make it executable. Record the implementation requirement instead.'],
    note:'Help is a local documentation library. It does not generate answers, install connectors, or execute the steps for you.',
    related:['automation','microsoft-permissions','telephony-architecture']
  },
  {
    id:'schedule-diagnostics',title:'Diagnose a workflow schedule that did not run',section:'Workflows',
    keywords:['schedule','schedules','scheduled','cadence','hourly','daily','weekly','timezone','time','paused','next run'],
    summary:'Check saved scheduling state and execution evidence before retrying work.',
    prerequisites:['An existing workflow schedule and permission to view its company.'],
    steps:['In Workflows, confirm the intended definition is Active; activating a definition and creating a schedule are separate actions.','Review the saved schedule, its Active or Paused state, and displayed Next run. Confirm your device time zone when interpreting displayed times.','Compare the due time with Workflow run history and Recent integration runs. A schedule row is configuration, not proof that a scheduler dispatched it.','If the workflow is Waiting Approval, inspect the linked request in Integrations instead of repeatedly running it.','If a due schedule has no run, keep the cadence, due time, time zone and last visible run timestamp for the platform operator to inspect. Avoid creating a duplicate schedule.'],
    troubleshooting:['A Next run time that remains in the past without a new run needs scheduler-side investigation. The help panel cannot verify that background service.','After a send-related timeout, establish the original outcome before any manual run; another run may create another message.'],
    note:'The current form offers hourly, daily and weekly cadences. Verify actual execution times; this guide does not certify timing, daylight-saving behavior, or background scheduler health.',
    related:['automation','approval-diagnostics','run-status']
  },
  {
    id:'approval-diagnostics',title:'Trace approval and execution status safely',section:'Workflows',
    keywords:['approval','diagnose','diagnostics','pending','approved','executed','failed','waiting','duplicate','resend','email status'],
    summary:'Follow a workflow, its approval request, and the provider outcome as separate records.',
    prerequisites:['The intended company and the workflow or email request being investigated.','Permission to inspect the request; an authorized approver is needed to change it.'],
    steps:['Start in Workflow run history. Waiting Approval means you should inspect the corresponding email request in Integrations.','For Pending requests, read recipient, subject and full message. A missing message preview is a reason to stop, not bypass review.','For Approved requests, review the request again before using Send approved email. Approval and successful execution are distinct states.','For Failed requests or uncertain sends, read the recorded error and check the sender’s Microsoft Sent Items or an authorized delivery trace before recreating or resending.','Compare the final workflow result with the request result. An agent request marked dispatched does not establish successful downstream delivery.'],
    troubleshooting:["If you cannot find the request, check the selected company and time window; do not create another request solely to clear a waiting label.","An Executed label is a platform outcome. Microsoft acceptance is not a guarantee that a recipient received the email.","If an action runs before review, inspect the execution gate and policy mapping, rather than adding only a prompt that asks the model to wait.","If review resumes the wrong work, check the stored thread/run identity and the action ordering required by the installed SDK."],
    note:"Do not treat a policy record or an auto-execute setting as proof that approval safeguards are enforced end to end. Verify the actual run and request behavior. External-agent approval gates require a separate implementation. Kairo’s existing approval records must not be presented as a native LLM tool-execution gate. Reviewed 2026-10-03.",
    sources:[{"label":"Kairo workflow and email request interface, revision 069cef8"},{"label":"Microsoft Graph sendMail response","url":"https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0"},{"label":"LangChain: human-in-the-loop decisions and execution gates","url":"https://docs.langchain.com/oss/python/langchain/human-in-the-loop"}],
    related:['email-approval','run-status','graph-retries'],
    successChecks:["Rejected test actions never execute, approved actions use the reviewed arguments, and duplicate decision submissions do not duplicate the operation."],
    externalSteps:["For an external model-driven tool, enforce review in the executor or middleware before the tool runs. Show the proposed tool, destination, and arguments, then bind the reviewer’s decision to that exact action.","Use the framework’s distinct approve and reject paths. In LangChain human-in-the-loop middleware, reject skips the action; respond supplies a synthetic successful tool result and must not be used as a denial of a side-effecting tool.","Test multiple pending actions, edited arguments, rejection, and repeated submission. Match decisions to the correct paused actions and verify the external result after approved execution."],
  },
  {
    id:'microsoft-permissions',title:'Match Microsoft permissions to Kairo actions',section:'Integrations',
    keywords:['microsoft','permissions','permission','scopes','scope','mail read','mail send','calendars read','files','disabled','inbox','calendar','profile'],
    summary:'Use the permissions shown by the connection to explain available and disabled actions.',
    prerequisites:['An authorized Microsoft administrator and a specific workflow requirement.'],
    steps:['Review the connected account and displayed scopes in Integrations. Confirm this is the intended account and company.','Kairo’s connection form always requests User.Read for profile access, alongside sign-in and ongoing-access scopes.','Inbox status is enabled only when the saved scopes include Mail.Read; upcoming calendar needs Calendars.Read.','The controlled-email area requires Mail.Send. Do not add email sending permission for a workflow that only reads a calendar.','Files.Read.All is an optional permission in the form, but the current Workflow builder has no file-reading action. Select only access justified by a supported requirement.','If approved access must change, have the administrator review the connection and consent path. A checked box alone is not evidence that Microsoft granted permission.'],
    troubleshooting:["A connected badge verifies neither every permission nor every target resource. Check the action-specific result.","If an action remains forbidden despite a listed scope, check Microsoft consent, the signed-in user’s access and tenant policy with the authorization-error guide.","For a Selected-permission 403, inspect the target tenant/resource, app identity, resource assignment, token permission, and delegated user access. A global administrator’s role is not a substitute for the API permissions required by the actual token.","Assignments at list, item, folder, or file level can break permission inheritance. Confirm the intended scope and unique-permission limits before an administrator applies changes."],
    note:"These names describe Kairo’s current UI gates. Microsoft’s minimum permissions can differ by API endpoint; do not broaden access to make an unrelated operation work. Review and configuration belong in the Microsoft tenant and the separately authorized integration. This guide does not grant Kairo new SharePoint or LLM capabilities. Reviewed 2026-10-03.",
    sources:[{"label":"Kairo Integrations and Workflow builder, revision 069cef8"},{"label":"Microsoft Graph permissions overview","url":"https://learn.microsoft.com/en-us/graph/permissions-overview"},{"label":"Microsoft: Selected permissions, assignments, and access calculation","url":"https://learn.microsoft.com/en-us/graph/permissions-selected-overview"},{"label":"Microsoft: least privilege and delegated versus app-only access","url":"https://learn.microsoft.com/en-us/graph/best-practices-concept"}],
    related:['microsoft-setup','entra-prerequisites','microsoft-auth-errors'],
    successChecks:["A read-only test succeeds on the explicitly granted resource and is denied on a comparable ungranted resource."],
    externalSteps:["For SharePoint or OneDrive Selected permissions, verify three separate requirements: Entra consent for the chosen permission, an explicit assignment on the intended resource, and a valid access token carrying the required permission. Consent alone grants no Selected-resource access.","Confirm whether the workload is delegated or app-only. With delegated access, effective access is the intersection of the app’s permissions and the signed-in user’s permissions; app-only access has no signed-in user to supply that boundary.","Have an authorized administrator verify the resource assignment and its read/write role. Permission-management privileges belong to the authorized provisioning process; do not broaden the runtime app’s permissions merely to make a failed test pass."],
  },
  {
    id:'entra-prerequisites',title:'Check Entra registration and consent prerequisites',section:'Integrations',kind:'reference',
    keywords:['entra','azure','microsoft','registration','client','tenant','consent','oauth','redirect','prerequisites','delegated','application','secret'],
    summary:'Administrator reference for preparing the Microsoft sign-in flow used by the Kairo connection.',
    prerequisites:['An approved app registration, its responsible administrator and the intended Microsoft tenant.','The exact callback URI and app configuration from your Kairo deployment owner; never guess them.'],
    steps:['Confirm the registration’s supported account type and tenant match the intended users. Distinguish the application client ID from other object IDs.','Have the deployment owner supply the exact redirect URI and required platform configuration. Compare the registered value before sign-in; do not invent a callback from the public site URL.','Kairo’s current form starts user consent with delegated-style scopes and ongoing access. A client secret does not by itself mean this is an app-only client-credentials flow.','Review only the delegated permissions required by the intended action. Whether an administrator must consent also depends on tenant policy.','Keep secret values in the approved setup and server-side secret-handling path. Never put secrets, tokens or authorization codes in help searches, screenshots, source code or support notes.','After authorized setup, complete sign-in and inspect the connected account and scopes before trying a read-only action.'],
    troubleshooting:['A redirect mismatch is a registration/deployment mismatch; changing the browser URL is not a fix.','App-only client credentials use application permissions without a signed-in user and need a separate reviewed implementation. They are not a drop-in fix for the current connection.'],
    note:'External Microsoft administrator reference. This guide does not create a registration, grant consent, rotate credentials, or certify the deployment’s backend OAuth implementation.',
    sources:[microsoft('Register an application','entra/identity-platform/quickstart-register-app'),microsoft('Authorization code flow','entra/identity-platform/v2-oauth2-auth-code-flow'),microsoft('Client credentials flow','entra/identity-platform/v2-oauth2-client-creds-grant-flow')],
    related:['microsoft-permissions','microsoft-auth-errors']
  },
  {
    id:'microsoft-auth-errors',title:'Diagnose Microsoft sign-in, 401 and 403 errors',section:'Integrations',kind:'reference',
    keywords:['microsoft','entra','outlook','401','403','unauthorized','forbidden','invalid client','invalid_client','aadsts','aadsts700016','aadsts7000215','aadsts7000222','aadsts50011','700016','7000215','7000222','50011','expired','denied','error','authentication'],
    summary:'Narrow the failure to registration, authentication, permissions or tenant policy before changing access.',
    prerequisites:['The exact non-secret error code, timestamp, and correlation or request ID if available.','An administrator who can inspect the approved registration and relevant sign-in logs.'],
    steps:['For AADSTS700016, compare the application ID and target tenant. For AADSTS50011, compare the exact redirect URI with the registration.','AADSTS7000215 indicates an invalid client secret; AADSTS7000222 indicates expired client secrets. Have the owner use the approved credential-management process, never chat or help search.','For Graph 401, investigate missing, invalid or expired access credentials through the connector’s supported sign-in path. Do not copy access tokens into online debugging tools.','For Graph 403, compare the called API, permission type, consent and account/resource access. Delegated permissions and application permissions are not interchangeable.','If the error is interaction_required or insufficient_claims, follow the organization’s approved sign-in or conditional-access process. Do not disable MFA or tenant restrictions to clear it.','Retry the smallest intended read only after the underlying cause is corrected. For a send, establish the original outcome first.'],
    troubleshooting:['A successful health check does not prove Mail.Read, Calendars.Read or Mail.Send will work.','Repeated 401/403 failures usually need a configuration or access correction, not a tight retry loop. Preserve a redacted error record for the responsible administrator.'],
    note:'External Microsoft diagnostic reference. Error text can vary by flow. Use the complete current provider error and documentation; do not expose tokens or broaden permissions speculatively.',
    sources:[microsoft('Resolve Graph authorization errors','graph/resolve-auth-errors'),microsoft('Entra error-code reference','entra/identity-platform/reference-error-codes')],
    related:['microsoft-permissions','entra-prerequisites','diagnostic-evidence']
  },
  {
    id:'graph-retries',title:'Handle Graph throttling and uncertain email sends',section:'Integrations',kind:'reference',
    keywords:['graph','microsoft','429','throttling','rate limit','retry','retries','retry after','backoff','timeout','duplicate','send','delivery','202'],
    summary:'External implementation checks for bounded retries and avoiding duplicate side effects.',
    prerequisites:['The failing operation, response status, time and a redacted request ID.','Access to provider results through an authorized operator.'],
    steps:["For HTTP 429, honor the Retry-After delay instead of clicking Run repeatedly. Reduce unnecessary request frequency.","For a custom integration with no Retry-After header, use exponential backoff. Set a bounded retry/time budget and an observable failed state; avoid stacked SDK and application retry loops.","Treat authentication/permission failures separately from throttling; a retry does not grant missing access.","For any API write, use the endpoint’s documented duplicate-prevention or concurrency mechanism when available. Do not assume every Graph endpoint accepts an idempotency key.","For timeouts or transport failures after an email submission, mark the outcome uncertain and inspect Sent Items or an authorized delivery trace before resending.","Graph sendMail returns 202 when accepted, without a message body. That acceptance is not confirmation of completed processing or recipient delivery.","In a test environment, verify rate-limit, timeout and duplicate-submission behavior before enabling an unattended schedule.","For batched work, inspect each item and retry only the failed operations after the appropriate delay. Verify SDK batch-retry behavior separately from single requests."],
    troubleshooting:["HTTP 200 on a Graph batch does not mean every subrequest succeeded; inspect each response and its retry delay.","If you cannot establish whether a side effect happened, stop automatic resubmission and preserve the evidence for review.","Repeated 401 or 403 responses need authentication, claims, licensing, or permission diagnosis; they are not ordinary throttling to solve by waiting.","If polling creates avoidable load, consider supported change notifications and delta queries, including a recovery/backstop strategy for missed notifications."],
    note:"External implementation reference. This does not claim that Kairo currently implements retry budgets, deduplication, batching, or delivery tracing. Retry behavior must be verified in the actual external integration. This addition does not imply Kairo runs a native LLM or a new Graph execution path. Reviewed 2026-10-03.",
    sources:[{"label":"Microsoft Graph throttling","url":"https://learn.microsoft.com/en-us/graph/throttling"},{"label":"sendMail acceptance and delivery","url":"https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0"},{"label":"Microsoft: Graph error codes","url":"https://learn.microsoft.com/en-us/graph/errors"},{"label":"Microsoft: change tracking and notifications","url":"https://learn.microsoft.com/en-us/graph/best-practices-concept"}],
    related:['approval-diagnostics','schedule-diagnostics','diagnostic-evidence'],
    successChecks:["A simulated 429 waits correctly, failed batch items are retried selectively, and an uncertain write does not create a duplicate in the test system."],
  },
  {
    id:'access-diagnostics',title:'Check missing access and company selection',section:'Team Access',
    keywords:['access','role','member','missing','company','organization','tenant','invitation','invite','login','sign in','permission'],
    summary:'Separate an account or company mismatch from a permission problem.',
    prerequisites:['Know which company and account should have access.'],
    steps:['Confirm the signed-in account, then inspect the selected company before reading or changing records.','Use Team Access to review the membership and role visible to you. A Microsoft connection does not grant a Kairo membership or approver role.','For an invitation problem, check that the intended account received the intended invitation. Do not share or paste a live invitation link into help search.','For an action denied by the service, record the action and error for an authorized owner or administrator. A visible button is not proof of permission.','After an authorized membership correction, reload the company and check the desired view before repeating any write.'],
    troubleshooting:['An empty view can reflect the wrong company, unfinished loading, no records, or limited access. Do not assume data was deleted.','Do not switch to a different account, guess record IDs or bypass an access denial to investigate.'],
    note:'Help cannot grant membership or change roles. Follow your organization’s access-approval process.',
    related:['team-access','tenant-isolation','save-trouble']
  },
  {
    id:'tenant-isolation',title:'Check tenant boundaries and unexpected data',section:'Governance',
    keywords:['tenant','isolation','company','organization','data','security','boundary','cross tenant','leak','privacy'],
    summary:'Verify the selected company and respond safely if information appears out of place.',
    prerequisites:['An authorized company membership and an understanding of which records belong there.'],
    steps:['Confirm company selection before viewing runs, approvals, invitations, exports or connected-account details.','After switching company or account, wait for its information to finish loading; do not act on stale content.','The help panel clears its search and open guide on account, company or section changes. Its suggestions use only allowlisted setup statuses and counts.','Application authorization must be enforced by backend access checks. A hidden control, company filter, or cleared help panel is not proof of server-side isolation.','If another company’s data appears, stop interacting with it. Record the time and affected screen using the minimum information needed, and notify the designated security owner through the approved channel.'],
    troubleshooting:['Do not test a suspected boundary issue by editing IDs, opening additional records or exporting data you are not authorized to access.','If loading fails, preserve unsaved work and use the workspace refresh path before retrying an authorized action.'],
    note:'This is a self-check and incident-handling guide, not an audit or certification of tenant isolation. Help does not read company free text, credentials, email bodies or staff records.',
    related:['access-diagnostics','diagnostic-evidence','governance-retention']
  },
  {
    id:'diagnostic-evidence',title:'Collect a safe diagnostic record',section:'Audit',
    keywords:['diagnostic','diagnostics','logging','logs','log','audit','troubleshoot','evidence','incident','redact','support','error','request id'],
    summary:'Gather the smallest useful record so a technical owner can trace a failure without exposing private content.',
    prerequisites:['Access to the relevant company’s screen and permission to inspect its outcome.'],
    steps:['Record the action, expected result, actual status, local time and time zone. Include a visible run or request identifier only in an approved support channel.','Compare Workflow run history, Recent integration runs and the relevant approval status. Audit is a record of changes; it does not replace execution evidence.','Keep exact error codes and redacted messages. Remove secrets, tokens, cookies, invitation links, message bodies and unrelated personal information from screenshots or logs.','State whether the action was retried and whether a provider-side effect may already have occurred. Do not repeat a send just to reproduce an error.','Use a synthetic or non-sensitive example when possible. Send diagnostic material only to the responsible authorized operator through the organization’s approved channel.'],
    troubleshooting:["If no run appears, note that absence and the observed time rather than asserting success or failure.","Do not attach a full tenant export or browser network archive by default; these may contain far more data than needed.","A missing log is not a successful run. Check logging failures and clock alignment, and distinguish never started, blocked, failed, and unknown outcomes.","A trace that shows model output alone cannot prove a tool action completed. Correlate the tool result with the external system’s status."],
    note:"The help search neither uploads diagnostics nor sends a support message. Keep sensitive evidence out of the search box even though searches remain local. External model/tool telemetry is separate from Kairo’s current diagnostics. Do not imply native LLM, RAG, or voice traces exist in Kairo. Reviewed 2026-10-03.",
    related:['run-status','approval-diagnostics','tenant-isolation'],
    successChecks:["An authorized teammate can locate the failed stage from the evidence without receiving raw credentials or unrelated sensitive content."],
    sources:[{"label":"Kairo interface reviewed at revision e9e1c66"},{"label":"OWASP: logging, sensitive-data exclusion, and verification","url":"https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html"},{"label":"Microsoft: Graph request correlation and reliability","url":"https://learn.microsoft.com/en-us/graph/best-practices-concept"},{"label":"Microsoft: structured Graph error details","url":"https://learn.microsoft.com/en-us/graph/errors"}],
    externalSteps:["For an external AI workflow, capture a correlation ID, timestamp, deployed version, failed stage, sanitized error code, duration, and retry count. Add model/deployment and token metrics only when that system actually makes model calls.","For Graph requests, record a generated client-request-id and returned request-id so failures can be traced across systems. Preserve machine-readable error codes rather than making program logic depend on changing error-message wording.","Redact secrets and unnecessary personal content before storing or sharing evidence. Limit log access and retention; use an approved non-sensitive reproduction instead of exporting production prompts, documents, or transcripts by default."],
  },
  {
    id:'governance-retention',title:'Review retention and export expectations',section:'Governance',
    keywords:['retention','export','deletion','delete','policy','governance','audit','execution','approval','download'],
    summary:'Understand what the governance screen records and what an administrator must verify separately.',
    prerequisites:['An approved retention policy and an authorized administrator for any change or export.'],
    steps:['Review the audit, execution and approval retention values for the selected company. Confirm units and the intended policy before changing anything.','Review whether exports are enabled and whether deletion is marked as requiring approval.','Distinguish a saved policy value from evidence that background retention or deletion has run. Ask the responsible operator to verify enforcement where required.','Before an authorized tenant export, confirm the company, purpose and approved storage location. Review the resulting file as potentially sensitive business data.','Keep provider-side email, call recordings and transcripts in their own retention review; a Kairo policy record does not change an external provider’s storage policy.'],
    troubleshooting:['If an export is denied, review the applicable role and policy with the owner; do not bypass the restriction.','A missing record alone does not prove policy-driven deletion. Use authorized operational evidence to establish what happened.'],
    note:'The current screen stores policy settings and offers an export action. This guide does not certify automated deletion, legal compliance or the completeness of any export.',
    related:['governance','tenant-isolation','diagnostic-evidence']
  }
,
{
  "id": "telephony-architecture",
  "title": "Plan telephony controls and call architecture",
  "keywords": [
    "telephony",
    "telephone",
    "phone",
    "calling",
    "voice",
    "twilio",
    "controls",
    "implementation",
    "architecture",
    "inbound",
    "outbound",
    "call",
    "dial",
    "twiml"
  ],
  "summary": "Design an external voice integration and understand which component controls each stage of a call.",
  "prerequisites": [
    "A technical owner, an external backend design and approved call destinations."
  ],
  "steps": [
    "Draw inbound caller → provider number → HTTPS call-control webhook → TwiML instructions → routing or playback. Keep status notifications separate from this synchronous control path.",
    "For a new outbound call, design a server-side Calls API operation with an approved destination and caller identity. A Dial instruction connects a party within an existing call.",
    "Track CallSid and parent/child call relationships, plus the provider’s call-progress events.",
    "Define permission checks, destination restrictions, consent requirements and human fallback before any provider-side build.",
    "Test the flow with local fixtures first; use real destinations only in an explicitly authorized integration test."
  ],
  "troubleshooting": [
    "If a connected call has no intended behavior, inspect the control URL, HTTP method and returned TwiML. A notification acknowledgement is not a call-control response.",
    "Completed is a network status; voicemail or an IVR may have answered. It does not prove a person completed the business task."
  ],
  "sources": [
    {
      "label": "Twilio Voice webhooks",
      "url": "https://www.twilio.com/docs/usage/webhooks/voice-webhooks"
    },
    {
      "label": "TwiML overview",
      "url": "https://www.twilio.com/docs/voice/twiml"
    },
    {
      "label": "Calls resource",
      "url": "https://www.twilio.com/docs/voice/api/call-resource"
    },
    {
      "label": "Dial reference",
      "url": "https://www.twilio.com/docs/voice/twiml/dial"
    }
  ],
  "related": [
    "capability-map",
    "telephony-routing",
    "telephony-webhooks"
  ],
  "section": "Integrations",
  "kind": "reference",
  "category": "Telephony reference",
  "note": "External implementation reference only. Kairo has no native telephony connector. These steps do not configure a provider, place calls, record audio or process transcripts from this help panel."
},
{
  "id": "telephony-routing",
  "title": "Design call routing, queues and fallback",
  "keywords": [
    "telephony",
    "twilio",
    "call",
    "routing",
    "route",
    "queue",
    "queues",
    "transfer",
    "fallback",
    "failover",
    "timeout",
    "hold",
    "busy",
    "no answer"
  ],
  "summary": "Specify bounded waiting, transfer outcomes and a failure path outside Kairo.",
  "prerequisites": [
    "An approved routing matrix, business hours, maximum wait and fallback message."
  ],
  "steps": [
    "Define outcomes for answered, busy, no-answer, failed routing and caller cancellation. Do not leave an undefined branch.",
    "Use bounded Dial timeouts and an action handler that interprets DialCallStatus. When an action URL is set, that handler supplies the next instructions.",
    "For queued callers, design Enqueue, waitUrl and a dequeue/exit path. Handle queue-full, error, hangup and leave results.",
    "Enforce a maximum queue wait using QueueTime and an explicit exit path; hold content can otherwise repeat.",
    "Design a minimal number-level fallback webhook on independent infrastructure. Distinguish provider retrieval failure from an unavailable agent.",
    "Test each routing branch and a primary-endpoint outage in an isolated harness before any production change."
  ],
  "troubleshooting": [
    "Inspect QueueResult for queue failures and ErrorCode/ErrorUrl for fallback retrieval failures.",
    "A business-hours or busy-agent decision belongs to application routing; it does not automatically invoke infrastructure failover."
  ],
  "sources": [
    {
      "label": "Dial behavior",
      "url": "https://www.twilio.com/docs/voice/twiml/dial"
    },
    {
      "label": "Enqueue and queue results",
      "url": "https://www.twilio.com/docs/voice/twiml/enqueue"
    },
    {
      "label": "Voice failover practices",
      "url": "https://www.twilio.com/docs/voice/twilio-voice-failover-best-practices"
    }
  ],
  "related": [
    "telephony-architecture",
    "telephony-recording",
    "telephony-testing"
  ],
  "section": "Integrations",
  "kind": "reference",
  "category": "Telephony reference",
  "note": "External implementation reference only. Kairo has no native telephony connector. These steps do not configure a provider, place calls, record audio or process transcripts from this help panel."
},
{
  "id": "telephony-recording",
  "title": "Plan call recording consent and retention",
  "keywords": [
    "telephony",
    "twilio",
    "call",
    "recording",
    "record",
    "consent",
    "notice",
    "retention",
    "audio",
    "recordings",
    "recordingsid"
  ],
  "summary": "Design notice, consent, capture and access as a reviewed external workflow.",
  "prerequisites": [
    "An approved recording purpose, jurisdiction-appropriate review, retention requirements and a non-recording path."
  ],
  "steps": [
    "Keep recording disabled until the required notice and consent conditions are satisfied. Do not assume a beep is universally sufficient.",
    "Choose the capture mechanism deliberately: Record for the caller’s voice, Dial recording for a bridged call, or Start Recording during execution.",
    "Place required notice/consent before the recording-start instruction; Start Recording begins immediately.",
    "Track recording availability through recordingStatusCallback. An action’s RecordingUrl can arrive before usable media exists.",
    "Define who can retrieve audio, when it must be removed and how consent outcomes are retained separately from RecordingSid. Test the non-recording path."
  ],
  "troubleshooting": [
    "A completed call is not proof that media is ready. Handle absent or failed recording outcomes.",
    "If a Record flow repeats, inspect its action URL and continuation rather than turning recording on again."
  ],
  "sources": [
    {
      "label": "Record behavior and legal considerations",
      "url": "https://www.twilio.com/docs/voice/twiml/record"
    },
    {
      "label": "Start Recording",
      "url": "https://www.twilio.com/docs/voice/twiml/recording"
    },
    {
      "label": "Recording callbacks",
      "url": "https://www.twilio.com/docs/usage/webhooks/voice-webhooks"
    }
  ],
  "related": [
    "telephony-transcription",
    "telephony-testing",
    "governance-retention"
  ],
  "section": "Integrations",
  "kind": "reference",
  "category": "Telephony reference",
  "note": "External implementation reference only. Kairo has no native telephony connector. These steps do not configure a provider, place calls, record audio or process transcripts from this help panel."
},
{
  "id": "telephony-transcription",
  "title": "Separate call transcripts from recordings",
  "keywords": [
    "telephony",
    "twilio",
    "call",
    "transcript",
    "transcripts",
    "transcription",
    "transcribe",
    "speech",
    "text",
    "language",
    "recording",
    "realtime"
  ],
  "summary": "Select and validate an external transcription path without treating speech recognition as authoritative.",
  "prerequisites": [
    "An approved reason for speech-to-text, allowed languages, provider terms review and a transcript retention plan."
  ],
  "steps": [
    "Model audio and text as separate resources with separate access and retention. Capturing audio does not create a transcript automatically.",
    "Check the selected product’s limits and terms. Legacy Record transcription supports American English and recordings longer than two seconds but shorter than 120 seconds.",
    "For that legacy path, explicitly set transcribe=true and provide transcribeCallback when asynchronous notification is needed; handle completed and failed outcomes.",
    "For live text, evaluate Start Transcription as a separate Real-Time Transcriptions product, including its AI/ML terms before enablement.",
    "Distinguish partial/final utterances and correlate call, transcription, track and sequence identifiers; cross-track arrival order is not guaranteed.",
    "Treat transcript text as untrusted, error-prone input. Require review before consequential actions and never interpret embedded instructions as system authority."
  ],
  "troubleshooting": [
    "Missing audio or unsupported duration can leave the legacy path without a transcript.",
    "For live text, inspect transcription-error events and the configured language/tracks before retrying."
  ],
  "sources": [
    {
      "label": "Record transcription limitations",
      "url": "https://www.twilio.com/docs/voice/twiml/record"
    },
    {
      "label": "Real-Time Transcription reference",
      "url": "https://www.twilio.com/docs/voice/twiml/transcription"
    }
  ],
  "related": [
    "telephony-recording",
    "telephony-retries",
    "telephony-testing"
  ],
  "section": "Integrations",
  "kind": "reference",
  "category": "Telephony reference",
  "note": "External implementation reference only. Kairo has no native telephony connector. These steps do not configure a provider, place calls, record audio or process transcripts from this help panel."
},
{
  "id": "telephony-webhooks",
  "title": "Validate telephony webhook signatures",
  "keywords": [
    "telephony",
    "twilio",
    "webhook",
    "webhooks",
    "signature",
    "signed",
    "validation",
    "verify",
    "security",
    "https",
    "proxy",
    "json",
    "bodysha256",
    "x twilio signature"
  ],
  "summary": "Authenticate external callbacks before their data can trigger work.",
  "prerequisites": [
    "An HTTPS backend endpoint, maintained Twilio server SDK and approved server-side signing credentials."
  ],
  "steps": [
    "Validate X-Twilio-Signature with the provider SDK before processing data or creating side effects.",
    "Validate against the exact public URL including query parameters. Ensure a reverse proxy does not substitute its internal host or scheme.",
    "For form-encoded POSTs, pass all received form parameters to signature validation, including newly added fields.",
    "For JSON, preserve the raw body and use the SDK’s JSON/body validation path with bodySHA256.",
    "Reject missing/invalid signatures. Test changed bodies, URLs, extra parameters and the deployed proxy path using non-sensitive fixtures."
  ],
  "troubleshooting": [
    "Check encoding, content type, public URL reconstruction, body preservation and account credential selection when valid requests fail.",
    "Do not disable verification or assume a fixed source-IP range is a replacement for signature authentication."
  ],
  "sources": [
    {
      "label": "Twilio webhook security",
      "url": "https://www.twilio.com/docs/usage/webhooks/webhooks-security"
    },
    {
      "label": "REST and credential best practices",
      "url": "https://www.twilio.com/docs/usage/rest-api-best-practices"
    }
  ],
  "related": [
    "telephony-retries",
    "telephony-testing",
    "tenant-isolation"
  ],
  "section": "Integrations",
  "kind": "reference",
  "category": "Telephony reference",
  "note": "External implementation reference only. Kairo has no native telephony connector. These steps do not configure a provider, place calls, record audio or process transcripts from this help panel."
},
{
  "id": "telephony-retries",
  "title": "Handle voice webhook retries and duplicate events",
  "keywords": [
    "telephony",
    "twilio",
    "voice",
    "webhook",
    "callback",
    "retry",
    "retries",
    "duplicate",
    "idempotency",
    "ordering",
    "sequence",
    "timeout",
    "events"
  ],
  "summary": "Keep call control timely and prevent repeated notifications from repeating a business action.",
  "prerequisites": [
    "A durable event store, the callback family’s documented schema and an explicit retry policy."
  ],
  "steps": [
    "Return synchronous call-control TwiML promptly. Twilio documents a hard 15-second upper limit for call-related HTTP requests.",
    "For notifications, validate and durably accept the event, acknowledge promptly and move expensive processing to a worker.",
    "Choose deduplication keys from the callback schema. CallSid plus SequenceNumber can distinguish call-progress events; other callbacks need their own key.",
    "Apply transitions using event metadata rather than arrival order. Independent requests can arrive out of sequence.",
    "Use I-Twilio-Idempotency-Token for retry diagnostics; do not treat it as a universal exactly-once guarantee.",
    "Test duplicate, reordered and timeout deliveries, including failure after persistence. A callback retry must not initiate a second outbound call."
  ],
  "troubleshooting": [
    "Review the actual connection-override timeout, retry count and retry classes. Do not infer defaults from one successful request.",
    "Voice retries are not separate Request Inspector entries. URL fragments used for overrides are excluded from signature computation."
  ],
  "sources": [
    {
      "label": "Webhook connection overrides",
      "url": "https://www.twilio.com/docs/usage/webhooks/webhooks-connection-overrides"
    },
    {
      "label": "Call progress callback sequence",
      "url": "https://www.twilio.com/docs/voice/api/call-resource"
    },
    {
      "label": "Webhook response handling",
      "url": "https://www.twilio.com/docs/usage/webhooks/webhooks-faq"
    }
  ],
  "related": [
    "telephony-webhooks",
    "telephony-testing",
    "graph-retries"
  ],
  "section": "Integrations",
  "kind": "reference",
  "category": "Telephony reference",
  "note": "External implementation reference only. Kairo has no native telephony connector. These steps do not configure a provider, place calls, record audio or process transcripts from this help panel."
},
{
  "id": "telephony-testing",
  "title": "Test and troubleshoot an external voice integration",
  "keywords": [
    "telephony",
    "twilio",
    "voice",
    "testing",
    "test",
    "debugger",
    "11200",
    "troubleshoot",
    "troubleshooting",
    "debug",
    "logging",
    "logs",
    "media",
    "recording",
    "credentials",
    "audio",
    "error"
  ],
  "summary": "Use safe fixtures, protected media and correlated evidence before any live rollout.",
  "prerequisites": [
    "A non-production harness, approved test destinations for any later live test and an access-controlled diagnostic store."
  ],
  "steps": [
    "Keep credentials in server-side secret management, outside browser bundles and source control. REST API keys and webhook signing credentials have different roles.",
    "Require authenticated recording access and test that an unauthenticated download fails. Retrieve media through a reviewed backend path.",
    "Log identifiers, times, status/error codes and handler latency. Redact phone numbers where possible; omit tokens, raw audio and transcript content from routine logs.",
    "Test valid/invalid signatures, TwiML responses, duplicate callbacks, unavailable media and fallback using local fixtures.",
    "Existing legacy test credentials simulate only supported API operations; Calls API test requests do not execute TwiML or produce status callbacks. Current documentation says new-console test credentials cannot be created.",
    "For a failing authorized test, correlate CallSid with Twilio Debugger, Request Inspector and application logs before repeating it."
  ],
  "troubleshooting": [
    "For 11200, inspect endpoint reachability, HTTP method/status, response content type, TLS, WAF/firewall behavior and latency.",
    "A simulated API success is not an end-to-end call test. Do not switch to production credentials merely to make a test pass."
  ],
  "sources": [
    {
      "label": "REST API practices",
      "url": "https://www.twilio.com/docs/usage/rest-api-best-practices"
    },
    {
      "label": "Recording access",
      "url": "https://www.twilio.com/docs/voice/api/recording"
    },
    {
      "label": "Test credential capabilities",
      "url": "https://www.twilio.com/docs/iam/test-credentials"
    },
    {
      "label": "Voice troubleshooting",
      "url": "https://www.twilio.com/docs/voice/troubleshooting"
    },
    {
      "label": "Twilio error 11200",
      "url": "https://www.twilio.com/docs/api/errors/11200"
    }
  ],
  "related": [
    "telephony-webhooks",
    "telephony-retries",
    "diagnostic-evidence"
  ],
  "section": "Integrations",
  "kind": "reference",
  "category": "Telephony reference",
  "note": "External implementation reference only. Kairo has no native telephony connector. These steps do not configure a provider, place calls, record audio or process transcripts from this help panel."
}
]
