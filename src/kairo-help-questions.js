// Curated entry points, not generated answers. Each question reuses one guide.
export const HELP_QUESTION_GROUPS = Object.freeze([
  {id:'business',label:'Business basics',description:'Choose useful work, build confidence, and help your team get started.'},
  {id:'technical',label:'Technical implementation',description:'Check access, quality, controls, and reliability in an external AI implementation.'}
])

export const HELP_QUESTIONS = Object.freeze([
  {id:'start-ai',group:'business',articleId:'getting-started',title:'Where should our business start with AI?',aliases:['first AI project','start small with artificial intelligence','AI beginner roadmap']},
  {id:'choose-tasks',group:'business',articleId:'workflow-basics',title:'Which tasks should we automate, and which need human judgment?',aliases:['human in the loop','choose automation use cases','what should stay manual','decide what to automate']},
  {id:'write-instructions',group:'business',articleId:'reusable-instructions',title:'How do I write useful AI instructions and reuse them?',aliases:['better prompts','prompt templates','reusable prompts','getting good answers','effective instructions']},
  {id:'company-writing',group:'business',articleId:'company-voice',title:'How do I make emails and documents sound like our company?',aliases:['brand voice','company tone','write like me','draft business emails','writing style']},
  {id:'check-answers',group:'business',articleId:'answer-quality',title:'How do I check whether an AI answer is accurate and sourced?',aliases:['AI accuracy','hallucinations','fact checking','check citations','trust answers','verify answer sources']},
  {id:'safe-information',group:'business',articleId:'safe-ai-data',title:'What company information is safe to put into AI?',aliases:['confidential data','safe uploads','privacy risks','sensitive business information','data protection']},
  {id:'meeting-actions',group:'business',articleId:'meeting-actions',title:'How do I turn meeting notes into decisions and action items?',aliases:['meeting summary','meeting minutes','owners deadlines','follow up from a transcript']},
  {id:'spreadsheet-checks',group:'business',articleId:'spreadsheet-validation',title:'How do I use AI with spreadsheets without trusting bad numbers?',aliases:['spreadsheet formulas','Excel validation','check spreadsheet calculations','incorrect totals','data analysis']},
  {id:'prepare-sops',group:'business',articleId:'sop-preparation',title:'How do I prepare our SOPs for an internal assistant?',aliases:['standard operating procedures','knowledge base preparation','internal knowledge assistant','company handbook']},
  {id:'support-handoff',group:'business',articleId:'support-handoff',title:'How do I use AI in customer support and hand off to a person?',aliases:['customer service escalation','human handoff','support chatbot','live agent']},
  {id:'measure-value',group:'business',articleId:'business-case',title:'How do we measure time savings, quality, and cost?',aliases:['AI return on investment','measure AI value','pilot success metrics','time saved','ROI measurement']},
  {id:'train-team',group:'business',articleId:'team-ai-training',title:'How do I train our team and set a practical AI policy?',aliases:['AI literacy','employee training','acceptable use','staff adoption','team guidelines']},
  {id:'microsoft-access',group:'technical',articleId:'microsoft-permissions',title:'Why can’t my AI app access Microsoft 365 or SharePoint files?',aliases:['SharePoint access denied','Microsoft 365 file permissions','Sites Selected','document access 403']},
  {id:'permission-retrieval',group:'technical',articleId:'retrieval-permissions',title:'How do I keep answers limited to files each person can access?',aliases:['permission aware retrieval','document permissions','RAG access control','security trimming','revoked access']},
  {id:'rag-quality',group:'technical',articleId:'retrieval-quality',title:'Why do document answers get worse when I add more files?',aliases:['RAG quality','retrieval quality','irrelevant chunks','too many documents','document assistant wrong answers']},
  {id:'parse-documents',group:'technical',articleId:'document-extraction',title:'How do I prepare messy PDFs, tables, and scans for AI?',aliases:['OCR','PDF extraction','scanned documents','table parsing','image only PDF']},
  {id:'action-approval',group:'technical',articleId:'approval-diagnostics',title:'How do I require approval before an agent changes or sends anything?',aliases:['human approval gate','approve before tools','agent approval','prevent automatic sends']},
  {id:'tool-output',group:'technical',articleId:'tool-contracts',title:'Why does my agent choose the wrong tool or return invalid output?',aliases:['tool calling','function calling','structured output','invalid JSON','schema validation','skips tools']},
  {id:'untrusted-content',group:'technical',articleId:'prompt-injection',title:'How do I stop hidden instructions in documents from controlling an agent?',aliases:['prompt injection','malicious webpage','untrusted content','indirect injection','data exfiltration']},
  {id:'avoid-duplicates',group:'technical',articleId:'graph-retries',title:'How do I avoid duplicate actions and endless API retries?',aliases:['idempotency','webhook duplicate actions','retry budget','rate limit backoff','repeated side effects']},
  {id:'resume-work',group:'technical',articleId:'workflow-recovery',title:'How do I pause and resume without losing work or repeating steps?',aliases:['durable workflow','checkpoint recovery','resume after crash','workflow state','replay safe']},
  {id:'cost-speed',group:'technical',articleId:'ai-cost-latency',title:'How do I control AI workflow cost and find what makes it slow?',aliases:['token costs','latency','performance bottleneck','AI budget','slow agent','response time']},
  {id:'safe-logging',group:'technical',articleId:'diagnostic-evidence',title:'What should I log to diagnose failures without exposing private data?',aliases:['privacy safe logging','redacted logs','trace IDs','observability','debug failed AI workflow']},
  {id:'deployment-failure',group:'technical',articleId:'deployment-parity',title:'Why does it work locally but fail after deployment or an upgrade?',aliases:['environment parity','production failure','dependency versions','deployment configuration','startup timeout']},
  {id:'voice-behavior',group:'technical',articleId:'voice-conversation',title:'How do I handle voice interruptions, transcripts, and human transfers?',aliases:['voice agent interruption','barge in','spoken transcript','phone assistant handoff','failed transfer']}
].map(question=>Object.freeze(question)))

export const getHelpQuestion = id => HELP_QUESTIONS.find(question=>question.id===id) || null
