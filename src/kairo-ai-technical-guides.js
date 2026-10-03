// External implementation references. Reviewed against linked primary docs 2026-10-03.
// This module contains help content only; it does not add integrations or runtime AI features.
export const AI_TECHNICAL_HELP_ARTICLES = [
  {
    id: 'retrieval-permissions',
    title: 'How do I keep document answers within each person’s permissions?',
    section: 'Governance',
    kind: 'reference',
    category: 'AI implementation reference',
    keywords: ['RAG', 'retrieval', 'permissions', 'ACL', 'SharePoint', 'tenant', 'access denied', 'security trimming'],
    summary: 'Plan and test permission-aware retrieval in an external document assistant. Access to a search index does not automatically mean a person may read every document in it.',
    prerequisites: [
      'An approved external search or RAG application, a data owner, and non-sensitive test documents.',
      'Two test identities with different document access, plus a way to inspect retrieval results before generation.'
    ],
    steps: [
      'List the source, tenant, document owner, and allowed users or groups. Record how document edits, deletions, and permission changes reach the search index.',
      'Choose the documented authorization approach for that source. Check preview status and supported API/SDK versions before selecting Azure native ACL enforcement for production.',
      'Authenticate the caller on the server. Apply the permission check to every retrieval before content reaches a model. For application-built security filters, derive identity from the authenticated session, never from a model-supplied user ID.',
      'Define a fail-closed response for absent identity or permission metadata. Scope caches and stored conversation results so an answer created for one identity cannot be reused for another without authorization checks.',
      'Test allowed, denied, missing-identity, and cross-tenant queries. Then revoke access to a test document, synchronize the source permissions, and repeat the checks, including cached responses.'
    ],
    troubleshooting: [
      'Unexpected access: inspect the caller identity, query filter or authorization header, indexed ACL metadata, and permission-sync age. Do not solve it by giving the runtime app broader read access.',
      'No results for an allowed user: check both index access and document permissions. Native ACL enforcement depends on synchronized permission metadata; source changes are not necessarily reflected immediately.'
    ],
    successChecks: [
      'Authorized test documents are returned; denied documents never enter the generation context, snippets, citations, or cached answers.',
      'Revocation takes effect within a documented and tested refresh window; missing authorization data fails closed.'
    ],
    note: 'External reference only. Kairo does not currently run an LLM or RAG pipeline or enforce permissions in an external search service. Azure native document-level ACL options are marked preview in the reviewed documentation. Reviewed 2026-10-03.',
    sources: [
      { label: 'Microsoft: document-level access control and permission synchronization', url: 'https://learn.microsoft.com/en-us/azure/search/search-document-level-access-overview' },
      { label: 'Microsoft: application-built security filtering', url: 'https://learn.microsoft.com/en-us/azure/search/search-security-trimming-for-azure-search' }
    ],
    related: ['microsoft-permissions', 'entra-prerequisites', 'tenant-isolation', 'governance-retention', 'retrieval-quality']
  },
  {
    id: 'retrieval-quality',
    title: 'Why do document answers get worse when I add more files?',
    section: 'Systems',
    kind: 'reference',
    category: 'AI implementation reference',
    keywords: ['RAG', 'retrieval', 'wrong answers', 'files', 'chunks', 'embeddings', 'hybrid search', 'citations'],
    summary: 'Separate missing evidence from poor answer generation in an external RAG application. More indexed files can introduce competing passages, stale versions, and ambiguous context.',
    prerequisites: [
      'An external retrieval application with access to its search results and indexing configuration.',
      'A small approved test set with questions, expected source passages, and some questions the collection cannot answer.'
    ],
    steps: [
      'Run the same test questions against the smaller and expanded collections. Save document IDs, passage text, rank, filters, and final answers so you can compare like with like.',
      'Inspect retrieval before changing prompts. If the supporting passage is absent, examine extraction, index freshness, duplicate versions, metadata filters, and whether the source was ingested.',
      'Check chunk boundaries and source metadata. Preserve headings and document identity so a passage containing a number or rule still explains which policy or product it describes.',
      'Verify that query vectors and stored vectors use the same embedding model and compatible dimensions. Compare keyword, vector, and hybrid retrieval on the same test set rather than assuming one approach always wins.',
      'Change one setting at a time, then rerun the tests. Check the answer against the retrieved evidence and require an explicit unsupported-answer path when the necessary evidence is absent.'
    ],
    troubleshooting: [
      'A low score is not automatically a bad match. Azure vector, keyword, and fused hybrid scores have different meanings; do not reuse one universal cutoff across them.',
      'If retrieval is correct but the answer is wrong, inspect the actual context sent to the model, truncation, conflicting versions, and the instruction to cite supporting evidence.'
    ],
    successChecks: [
      'Expected passages remain retrievable after more files are added, and answers cite the correct source version.',
      'Unsupported questions are identified without fabricated evidence; quality is compared with a saved baseline.'
    ],
    note: 'External reference only. Kairo does not currently ingest documents into a vector index, run RAG, or generate model answers. These are tests for a separately implemented system. Reviewed 2026-10-03.',
    sources: [
      { label: 'Microsoft: vector relevance, embeddings, and search scores', url: 'https://learn.microsoft.com/en-us/azure/search/vector-search-ranking' },
      { label: 'Microsoft: layout-aware document chunking', url: 'https://learn.microsoft.com/en-us/azure/search/search-how-to-semantic-chunking' },
      { label: 'Microsoft: relevance and ranking overview', url: 'https://learn.microsoft.com/en-ie/azure/search/search-relevance-overview' }
    ],
    related: ['retrieval-permissions', 'document-extraction', 'diagnostic-evidence', 'ai-cost-latency']
  },
  {
    id: 'document-extraction',
    title: 'How do I prepare PDFs, tables, and scans for an AI workflow?',
    section: 'Systems',
    kind: 'reference',
    category: 'AI implementation reference',
    keywords: ['PDF', 'OCR', 'tables', 'scans', 'extraction', 'document quality', 'layout', 'missing rows'],
    summary: 'Validate extracted content before an external model or search index uses it. A readable PDF on screen is not proof that its text, tables, and reading order were extracted correctly.',
    prerequisites: [
      'Representative, approved sample documents and permission to process them with the chosen external service.',
      'A document extraction or OCR tool, access to its structured output, and a reviewer who can compare output with the originals.'
    ],
    steps: [
      'Sample the real input types: digital PDFs, scanned pages, rotated text, merged-cell tables, and multi-page sections. Check the chosen model’s current file, page, language, and size limits.',
      'Choose text extraction for the text you need, or a layout-capable model when headings, tables, and reading order matter. For scans, use clear, well-oriented images and an OCR-capable path.',
      'Keep structured output alongside any Markdown or plain text. Preserve file ID, page number, headings, table rows and columns, and the source location needed to audit an extracted value.',
      'Compare sample output with the original page. Check missing pages, row and column counts, merged headers, signs, decimals, dates, and text across page breaks. Mark uncertain values for review.',
      'Fix the extraction or route difficult documents to a separate review path before indexing. Rerun the sample checks after changing the parser, model, or API version.'
    ],
    troubleshooting: [
      'Missing text: verify that pages were processed, the file type is supported, and the content is actually available to the chosen extraction model; embedded images in office files may need separate handling.',
      'Flattened or shifted tables: inspect structured cell coordinates and row/column spans instead of trusting a plain-text rendering. Use a higher-quality scan when the original is unclear.'
    ],
    successChecks: [
      'A reviewer can trace every sampled extracted value back to a source page and table cell or text region.',
      'Known difficult samples meet documented acceptance criteria, and uncertain documents are visibly routed for review.'
    ],
    note: 'External reference only. Kairo does not currently provide OCR, document extraction, a native RAG index, or LLM processing. Document upload and processing happen in the separately approved service. Reviewed 2026-10-03.',
    sources: [
      { label: 'Microsoft: Document Intelligence layout model', url: 'https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0' },
      { label: 'Microsoft: Read model and input requirements', url: 'https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/read?view=doc-intel-4.0.0' }
    ],
    related: ['retrieval-quality', 'governance-retention', 'diagnostic-evidence']
  },
  {
    id: 'tool-contracts',
    title: 'Why does my agent use the wrong tool or return invalid data?',
    section: 'Agents',
    kind: 'reference',
    category: 'AI implementation reference',
    keywords: ['agent', 'tools', 'function calling', 'JSON', 'schema', 'invalid output', 'validation', 'MCP'],
    summary: 'Test the contract between an external model, its tools, and your application. Valid-looking JSON does not prove that a tool ran or that the requested action succeeded.',
    prerequisites: [
      'An external agent implementation, its model/SDK versions, tool definitions, and a redacted failing trace.',
      'Test-only tool endpoints or fixtures so invalid input cannot trigger a real-world action.'
    ],
    steps: [
      'Reduce the failure to one request and one tool. Record the exact model, endpoint, SDK versions, input schema, and ordered tool-call/result messages.',
      'Give the tool a clear purpose and typed arguments. Define required fields, allowed values, and units; keep authenticated identity and privileged context outside model-controlled arguments.',
      'Invoke the tool directly with known valid and invalid inputs. Check argument validation, permissions, return shape, error behavior, and the actual external result before involving the model.',
      'Verify the selected model and endpoint support the features together. In LangChain, combining tools with structured output requires support for both at the same time; select the documented provider or tool strategy.',
      'Validate the final response against the application schema. Use bounded correction attempts for fixable validation errors, and a clear failure or review path for persistent errors. Test again with tool execution enabled.'
    ],
    troubleshooting: [
      'Tool never runs: inspect whether a final-answer format is incompatible with tool calls, whether the tool is available, and whether its description matches the request.',
      'Tool appears successful but nothing changed: verify the returned status and external system. Preserve the matching tool-call ID and error result instead of converting every exception to a success message.'
    ],
    successChecks: [
      'Tests demonstrate the intended tool and arguments, reject invalid or unauthorized input, and distinguish failure from success.',
      'The application accepts only validated output and checks the external action result independently.'
    ],
    note: 'External reference only. Kairo does not currently call an LLM, execute model-selected tools, or provide an MCP agent runtime. This guide applies to a separately built integration. Reviewed 2026-10-03.',
    sources: [
      { label: 'LangChain: tool definitions, runtime context, and results', url: 'https://docs.langchain.com/oss/python/langchain/tools' },
      { label: 'LangChain: structured output and validation errors', url: 'https://docs.langchain.com/oss/python/langchain/structured-output' }
    ],
    related: ['approval-diagnostics', 'diagnostic-evidence', 'prompt-injection', 'graph-retries']
  },
  {
    id: 'prompt-injection',
    title: 'How do I handle instructions hidden in documents or webpages?',
    section: 'Governance',
    kind: 'reference',
    category: 'AI implementation reference',
    keywords: ['prompt injection', 'security', 'untrusted content', 'agent', 'MCP', 'malicious documents', 'permissions'],
    summary: 'Reduce the impact of prompt injection in an external AI application. Retrieved text, tool results, and webpages can contain instructions that conflict with the user’s authorized task.',
    prerequisites: [
      'An inventory of the external content the agent reads and the tools or data it can access.',
      'An isolated test environment with synthetic secrets, harmless tool stubs, and security-review ownership.'
    ],
    steps: [
      'Mark trust boundaries in the workflow: user request, system instructions, retrieved documents, websites, and tool responses. Treat external content as data rather than authority to change the task.',
      'Reduce tool permissions and data access to the minimum needed. Keep credentials out of model context and use server-side identity and authorization checks for every protected operation.',
      'Screen proposed tool actions against the original user request and allowed destinations. Validate parameters outside the model, and require an enforced approval gate for high-impact changes.',
      'Add layered input and output checks, including safe rendering of returned markup. Do not treat a keyword filter, system prompt, or second model as a complete protection.',
      'Run a maintained test set of hostile documents and benign controls using synthetic data. Record actual tool actions, blocked requests, false positives, and inconclusive runs; repeat after changes.'
    ],
    troubleshooting: [
      'If the agent follows a document’s instruction, inspect the trust boundary and action authorization layer before adding another prompt warning.',
      'A silent response or missing log is not evidence that an attack was blocked. Mark the test inconclusive and repair observability; check that legitimate tasks still succeed.'
    ],
    successChecks: [
      'Test content cannot authorize an unrequested tool action, access another tenant, or transmit synthetic secrets.',
      'The security review reports both observed violations and benign-task completion; no test result is presented as a guarantee against all injection attacks.'
    ],
    note: 'External reference only. Kairo does not currently operate a native LLM agent or provide prompt-injection protection for external models and tools. These controls must be implemented and tested in the system that executes the work. Reviewed 2026-10-03.',
    sources: [
      { label: 'OWASP: prompt injection prevention and testing', url: 'https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html' },
      { label: 'OWASP: AI agent security and tool permissions', url: 'https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html' }
    ],
    related: ['tool-contracts', 'approval-diagnostics', 'tenant-isolation', 'governance-retention']
  },
  {
    id: 'workflow-recovery',
    title: 'How do I resume an interrupted workflow without repeating actions?',
    section: 'Workflows',
    kind: 'reference',
    category: 'AI implementation reference',
    keywords: ['resume', 'pause', 'checkpoint', 'recovery', 'duplicate', 'idempotency', 'approval', 'LangGraph'],
    summary: 'Design recoverable state and replay-safe actions in an external workflow engine. Resuming execution can rerun code, so saving conversation text alone is not enough.',
    prerequisites: [
      'An external workflow implementation with durable storage and a stable run or conversation identifier.',
      'Test endpoints for side effects and a record of which operations can be safely repeated.'
    ],
    steps: [
      'Define the workflow states, stable identifiers, and evidence of completed operations. Separate a pending approval from an approved action and a verified external result.',
      'Use the engine’s persistent checkpointer in production and resume the correct saved thread. In LangGraph, the thread ID selects the saved state; a new ID starts a different thread.',
      'Put the approval pause before the protected side effect. Keep interrupt payloads serializable, and do not swallow the interrupt exception with a broad error handler.',
      'Make replayed writes safe with an operation key and an existing-result check, or split them into separately tracked steps. Do not assume a checkpoint gives an external API exactly-once execution.',
      'Interrupt before and after a test write, restart the worker, and resume. Also test rejection, repeated approval submission, and a timeout after the external system accepted the action.'
    ],
    troubleshooting: [
      'The workflow restarts from scratch: verify the thread ID, persistent checkpoint configuration, and access to the same store.',
      'Duplicate writes: inspect code before the interrupt and any retry path. LangGraph restarts the interrupted node on resume, so earlier side effects may run again.'
    ],
    successChecks: [
      'Restarted test runs recover the intended state and require the correct approval before a protected action.',
      'Repeated resume attempts do not duplicate the tested external operation; uncertain outcomes are reconciled before retrying.'
    ],
    note: 'External reference only. Kairo does not currently host an LLM agent runtime or LangGraph checkpoint engine. Existing Kairo workflow records must not be described as providing these external recovery guarantees. Reviewed 2026-10-03.',
    sources: [
      { label: 'LangGraph: persistence and thread-scoped state', url: 'https://docs.langchain.com/oss/python/langgraph/persistence' },
      { label: 'LangGraph: interrupts, resume, and replay-safe side effects', url: 'https://docs.langchain.com/oss/python/langgraph/interrupts' }
    ],
    related: ['approval-diagnostics', 'graph-retries', 'diagnostic-evidence', 'tool-contracts']
  },
  {
    id: 'ai-cost-latency',
    title: 'How do I find what makes an AI workflow slow or expensive?',
    section: 'AI Ops',
    kind: 'reference',
    category: 'AI implementation reference',
    keywords: ['cost', 'latency', 'tokens', 'budget', 'slow', 'performance', 'retries', 'monitoring'],
    summary: 'Measure a complete task in an external AI service before optimizing it. Token usage, repeated calls, retrieval, tools, hosting, and telemetry can all affect the result.',
    prerequisites: [
      'An external implementation, representative approved test inputs, and access to usage metrics and billing for the relevant resources.',
      'A quality baseline plus agreed limits for per-task cost, response time, and concurrent load.'
    ],
    steps: [
      'Define one completed task and trace its stages: retrieval, model requests, tool calls, retries, and final response. Record model/deployment, version, input/output tokens, and elapsed time.',
      'Measure time to first output separately from total completion time. Compare latency alongside token counts and load; a longer answer can explain a longer completion time.',
      'Estimate costs with the current pricing for the actual deployment and dependent services. Run a small representative workload, then reconcile the estimate with billing grouped by resource and meter.',
      'Optimize the measured bottleneck one change at a time: unnecessary context, oversized answers, repeated calls, blocking telemetry, or excessive concurrency. Rerun quality tests before accepting a cheaper or faster configuration.',
      'Set monitored budgets and an application-level stopping policy for tool steps, retries, or usage where required. Test the stop path; a billing alert alone is not a guaranteed spending cap.'
    ],
    troubleshooting: [
      'Costs appear incomplete: check the billing scope, dependent storage/search/monitoring resources, and ingestion delay before comparing totals.',
      'Latency rises with stable token counts: inspect concurrent load, throttling, retrieval time, tool time, and deployment utilization. Streaming improves perceived responsiveness but does not prove faster completion.'
    ],
    successChecks: [
      'The team can explain the main time and cost contributors for a representative task and reconcile estimates with metered usage.',
      'The chosen configuration meets the saved quality baseline, and the tested limit or escalation behavior is explicit.'
    ],
    note: 'External reference only. Kairo does not currently meter LLM tokens, run native models, or impose spend limits on external services. Prices and available billing controls must be checked for the chosen provider. Reviewed 2026-10-03.',
    sources: [
      { label: 'Microsoft: model performance and latency metrics', url: 'https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/latency' },
      { label: 'Microsoft: cost estimation, meters, budgets, and alerts', url: 'https://learn.microsoft.com/en-us/azure/foundry/concepts/manage-costs' }
    ],
    related: ['diagnostic-evidence', 'graph-retries', 'retrieval-quality', 'deployment-parity']
  },
  {
    id: 'deployment-parity',
    title: 'Why does my AI integration work locally but fail after deployment?',
    section: 'Integrations',
    kind: 'reference',
    category: 'AI implementation reference',
    keywords: ['deployment', 'production', 'staging', 'versions', 'dependencies', 'environment', 'rollback', 'configuration'],
    summary: 'Compare the exact artifact, configuration, identity, and runtime used by an external integration. A local success does not test the production network, permissions, or workload.',
    prerequisites: [
      'A recorded working build, a failing request with its timestamp, and access to redacted deployment logs.',
      'A staging environment, approved test identity, and a documented recovery plan for code and any state changes.'
    ],
    steps: [
      'Record the deployed build or image and dependency lockfile. Compare runtime, SDK, plugin, model/API, and database migration versions with the working environment.',
      'Compare configuration names and selected endpoints without printing secret values. Confirm the deployed workload identity, permissions, region, network route, and access to required storage or queues.',
      'Reproduce with the same non-sensitive input in staging that mirrors production. Check startup, dependency reachability, timeouts, and whether workers register with the intended environment.',
      'Run a small end-to-end smoke test, then representative concurrent load and failure-path tests. Include authentication, denied access, retry exhaustion, and worker restart where relevant.',
      'Release only through the team’s approved process. Use health gates and a limited initial rollout; stop on regressions and follow the tested recovery plan rather than repeatedly changing production configuration.'
    ],
    troubleshooting: [
      'Works only with a developer login: compare the production workload identity and effective permissions; do not copy personal credentials into the deployment.',
      'Only newer deployments fail: compare the artifact and dependency versions first. Check SDK-specific deployment requirements rather than mixing examples from different releases.'
    ],
    successChecks: [
      'The deployed artifact and configuration are identifiable, and staging reproduces the relevant production path.',
      'Smoke and failure-path tests pass; the team can stop or recover a bad rollout, including any stateful changes.'
    ],
    note: 'External reference only. Kairo does not currently deploy or host a native LLM, RAG, or voice runtime. These checks apply to the separately deployed integration and do not authorize a production release. Reviewed 2026-10-03.',
    sources: [
      { label: 'Microsoft: safe deployment practices and recovery', url: 'https://learn.microsoft.com/en-us/azure/well-architected/operational-excellence/safe-deployments' },
      { label: 'Microsoft: deployment testing and smoke tests', url: 'https://learn.microsoft.com/en-us/azure/well-architected/mission-critical/mission-critical-deployment-testing' },
      { label: 'LiveKit: deployment isolation and SDK requirements', url: 'https://docs.livekit.io/deploy/agents/deployments/' }
    ],
    related: ['diagnostic-evidence', 'microsoft-auth-errors', 'workflow-recovery', 'ai-cost-latency']
  },
  {
    id: 'voice-conversation',
    title: 'How do I debug interruptions, transcripts, and transfers in a voice agent?',
    section: 'Integrations',
    kind: 'reference',
    category: 'AI implementation reference',
    keywords: ['voice', 'phone', 'telephony', 'SIP', 'transcript', 'interruption', 'transfer', 'LiveKit'],
    summary: 'Trace the external voice pipeline and call lifecycle separately. Hearing audio, receiving a transcript, and completing a human transfer are different events.',
    prerequisites: [
      'An approved external voice service with known SDK versions, test callers, and a verified human-transfer destination.',
      'A documented recording/transcription notice and retention process, plus access to permitted call events and diagnostic metrics.'
    ],
    steps: [
      'Assign the test call a correlation ID and record the room, participant, and provider call IDs. Capture stage timings and state changes without exposing credentials or unnecessary conversation content.',
      'Test turn-taking with silence, background noise, short acknowledgments, and a deliberate interruption. Compare detected speech with transcription and playback events before tuning interruption settings.',
      'Capture committed conversation items for both speakers, including interruption status. In LiveKit, use the documented conversation_item_added event and distinguish it from interim user transcription events.',
      'Compare the saved transcript with what the caller actually heard. Interrupted agent speech can be truncated; do not assume the full generated answer was spoken. Test missing-transcript handling explicitly.',
      'Test an answered call, human transfer, no answer, and failed transfer. Verify the call is active and the trunk supports the required transfer mechanism. A cold transfer ends the LiveKit session; handle its failure before telling the caller it succeeded.',
      'Check the destination actually received the call and define a fallback when it does not. Repeat the test after SDK, speech provider, or trunk changes.'
    ],
    troubleshooting: [
      'Agent stops too early or talks over callers: inspect speech detection, end-of-turn, interruption, and transcription timing independently; do not change every threshold at once.',
      'Missing transcript: distinguish interim events, committed items, interrupted speech, and transcription-timeout events for the installed SDK.',
      'Transfer rejected or stuck: inspect active call state, SIP response, provider transfer support, destination format, and transfer timeout. Keep a clear caller fallback.'
    ],
    successChecks: [
      'Tests show coherent turn-taking and a transcript that reflects committed speech, including interrupted turns.',
      'Successful transfers are verified at the destination; no-answer and failure tests retain an understandable fallback.'
    ],
    note: 'External reference only. Kairo does not currently place calls, run a native voice agent, transcribe audio, or transfer live calls. Its planning material is not a live telephony integration. Reviewed 2026-10-03.',
    sources: [
      { label: 'LiveKit: turn detection and interruptions', url: 'https://docs.livekit.io/agents/logic/turns/' },
      { label: 'LiveKit: conversation events and errors', url: 'https://docs.livekit.io/reference/agents/events/' },
      { label: 'LiveKit: SIP participant call state and identifiers', url: 'https://docs.livekit.io/reference/telephony/sip-participant/' },
      { label: 'LiveKit: call forwarding, provider support, and timeouts', url: 'https://docs.livekit.io/telephony/features/transfers/cold/' }
    ],
    related: ['telephony-routing', 'telephony-transcription', 'telephony-testing', 'governance-retention', 'diagnostic-evidence']
  }
];
