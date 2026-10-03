// Practical exercises for an organization-approved external AI tool.
// These guides do not add generation, uploads, or provider calls to Kairo.
const source = (label,url) => ({label,url})
const prompting = source('Microsoft: write prompts with a goal, context, expectations and source','https://support.microsoft.com/en-us/microsoft-365-copilot/get-started-writing-prompts-in-microsoft-365-copilot')
const oversight = source('NIST AI RMF: roles, oversight, training and measurement','https://airc.nist.gov/airmf-resources/airmf/5-sec-core/')

export const BUSINESS_HELP_ARTICLES = [
  {
    id:'reusable-instructions',title:'Write and test reusable AI instructions',section:'Workflows',
    keywords:['prompt','prompts','instructions','template','reuse','reusable','examples','output','format'],
    summary:'Create a small, tested instruction template for one repeatable task in an approved AI tool.',
    prerequisites:['A low-risk task, an approved external AI tool, and sample inputs you are allowed to share.','A human reviewer who knows what a useful result looks like.'],
    steps:['Write the goal in one sentence: what should the output help someone do? Identify the reader and the input it should use.','Specify the result: length, tone, required fields, source references, and what to do when information is missing. Separate source material from instructions.','Try a template such as: “Using only [approved source], draft [output] for [audience]. Include [fields]. Mark missing facts as unknown. Do not invent commitments.” Replace the placeholders before use.','Run a few typical examples and one incomplete example. Compare facts and format with your own expected results; change one instruction at a time.','Save the reviewed template in your team’s approved document location with an owner, version, example input and review checklist. Re-test after changing the task or AI tool.'],
    troubleshooting:['If the answer is too broad, reduce the task and specify the exact input and result. Adding more adjectives is rarely a substitute for clear examples.','If output looks consistent but contains invented facts, add a missing-information rule and verify the underlying source; a prompt cannot guarantee accuracy.'],
    successChecks:['A teammate can use the template on a new example, identify unknowns and explain which facts came from the supplied source.'],
    note:'External AI practice. Kairo does not run prompts or store an executable prompt library. Use Workflows to document the process and its reviewer.',
    sources:[prompting],related:['company-voice','answer-quality','workflow-basics']
  },
  {
    id:'company-voice',title:'Draft in your company’s voice with a review step',section:'Workflows',
    keywords:['email','documents','writing','voice','tone','brand','style','draft','company'],
    summary:'Use approved examples and a short style brief without importing their old facts or promises.',
    prerequisites:['Two or three approved examples you may share with the external tool.','The intended audience, purpose, current facts and a person authorized to approve the final text.'],
    steps:['Extract a short style brief from the examples: formality, sentence length, terminology, greeting, closing and phrases to avoid. Remove personal details that the new task does not need.','Provide current facts separately from style examples. Tell the tool which material supplies style and which supplies today’s facts.','Ask for one draft with a defined length and purpose. Require missing details to remain placeholders rather than invented names, dates, prices or promises.','Compare every factual claim and commitment with the approved input. Check that the tone suits this recipient and that the examples have not been copied into unrelated content.','Have the appropriate person approve and send through the normal channel. Save a reviewed example only in an approved team location.'],
    troubleshooting:['If the result sounds generic, replace vague tone words with a short approved example and specific do/don’t rules.','If old client names or dates reappear, remove them from the style samples and keep the current fact sheet separate.'],
    successChecks:['The reviewer can trace every claim to current facts and recognizes the company’s tone without finding recycled details.'],
    note:'External AI practice. Kairo does not generate emails or documents. Its controlled Microsoft email workflow is separate and still requires review of the exact message.',
    sources:[source('Microsoft: effective prompts and reference documents in Word','https://support.microsoft.com/en-us/word/copilot/write-effective-prompts')],related:['reusable-instructions','answer-quality','email-approval']
  },
  {
    id:'answer-quality',title:'Check AI answers against evidence',section:'Governance',
    keywords:['accuracy','accurate','sources','citation','citations','verify','quality','hallucination','hallucinations','evaluation','facts'],
    summary:'Use a repeatable human review instead of treating a confident answer or citation as proof.',
    prerequisites:['A reviewer with access to authoritative source material.','A small set of representative questions and known correct outcomes, including a question the sources cannot answer.'],
    steps:['Define what a passing answer must contain: correct facts, relevant source references, current dates, and clear limits where evidence is missing.','For each important claim, open the cited source and check the actual passage, document version and date. A real URL can still point to evidence that does not support the claim.','Recalculate quantities with a spreadsheet or calculator and confirm names, obligations and deadlines with the responsible person. Raise the review standard when mistakes could cause harm.','Run the same small question set after prompt, model or source changes. Record wrong facts, missing context, unsupported claims and appropriate “unknown” answers separately.','Use the result only after the reviewer resolves material errors. Keep a minimal record of the test, change and approval in your approved team process.'],
    troubleshooting:['If citations are missing, request exact source locations and verify them yourself. Asking another AI to agree is not independent evidence.','If a known fact is omitted, inspect whether the correct source was available before rewriting the prompt.'],
    successChecks:['Each important claim is supported by a checked source; unanswerable questions are identified instead of filled with plausible details.','Your test record shows whether the latest change improved accuracy without hiding new failures.'],
    note:'External AI practice. Kairo does not evaluate model output, score answer confidence, or check citations. Its manually entered execution confidence is not evidence of factual accuracy.',
    sources:[source('NIST: Generative AI risk profile, including confabulation and evaluation','https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf')],related:['spreadsheet-validation','retrieval-quality','agent-controls']
  },
  {
    id:'safe-ai-data',title:'Decide what information an AI tool may receive',section:'Governance',
    keywords:['safe','company','information','privacy','confidential','sensitive','data','upload','protection','secrets'],
    summary:'Check the account, data classification and actual destination before sharing business information.',
    prerequisites:['Your organization’s approved-tool and information-handling policies.','An owner who can confirm the permitted purpose and recipients for the data.'],
    steps:['Identify the exact tool, account type and feature being used. A personal account and a managed business account can have different protections.','Classify the minimum information the task needs. Remove identifiers and confidential details where the task can be completed with synthetic or redacted examples.','Have the responsible owner check the provider’s retention, training use, access, sharing and connected-tool terms for this account. “Not used for training” does not mean nothing is stored.','Check whether web search, an agent, plug-in or external action passes data to an additional service. Microsoft’s enterprise data protection documentation distinguishes web queries and agents from the core experience.','Use only the approved sharing path. Keep passwords, tokens and secrets out of prompts, help searches and screenshots; stop and ask the owner when policy is unclear.'],
    troubleshooting:['If you cannot establish which account or protection applies, use synthetic data while the owner checks it. Do not assume a familiar product logo is sufficient.','If data was sent to the wrong place, follow your incident process and preserve minimal evidence. Deleting a visible chat is not proof that all copies were removed.'],
    successChecks:['You can name the approved recipient service, the data shared, its purpose and the owner who confirmed the handling rules.'],
    note:'External AI practice. This is a review checklist, not a legal or compliance certification. Kairo’s policy records do not enforce another AI provider’s data handling.',
    sources:[source('Microsoft: enterprise data protection and separate handling for web queries and agents','https://learn.microsoft.com/en-us/microsoft-365/copilot/enterprise-data-protection'),source('Microsoft: data, privacy and storage of Copilot interactions','https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-privacy?source=docs')],related:['governance','governance-retention','prompt-injection']
  },
  {
    id:'meeting-actions',title:'Turn meeting notes into a verified action list',section:'Workflows',
    keywords:['meeting','meetings','notes','decisions','actions','minutes','transcript','owners','deadlines'],
    summary:'Separate actual decisions, proposed ideas and assigned work before sharing a meeting recap.',
    prerequisites:['Notes or a transcript you are allowed to process, with the meeting’s date and participants.','Approved recording/transcription arrangements if audio is involved; a note-taking workflow does not itself authorize recording.'],
    steps:['Supply the approved notes to your organization’s external AI tool. Ask for three sections: decisions made, actions assigned, and open questions.','For each action, request the owner, exact task, due date if stated and a source quotation or timestamp. Mark unstated owners and dates as unassigned.','Compare the proposed summary with the source. Distinguish a suggestion from a decision and a discussion participant from the actual task owner.','Ask the meeting owner to confirm uncertain items. Resolve ambiguous names and relative dates against the meeting date and time zone.','Share the reviewed recap through the normal team channel, then create or update tasks only with the intended owners and dates confirmed.'],
    troubleshooting:['If the transcript omits a section or mishears a name, mark the gap and ask a participant; do not fill it with a guessed decision.','In Teams, access to post-meeting Copilot history depends on meeting configuration and transcription. Follow the approved organizer settings rather than assuming every meeting has a saved transcript.'],
    successChecks:['Every committed action has a confirmed owner and either a confirmed deadline or a clearly marked missing date.','The meeting owner agrees that proposals were not promoted into decisions.'],
    note:'External AI practice. Kairo does not record meetings, transcribe audio, summarize notes, or synchronize meeting tasks.',
    sources:[source('Microsoft: meeting Copilot, transcription and organizer settings','https://support.microsoft.com/en-us/teams/copilot/catch-up-on-meetings-with-microsoft-365-copilot-in-teams'),source('Microsoft: recap a meeting and verify its results','https://support.microsoft.com/en-us/teams/meetings-events/recap-a-teams-meeting')],related:['answer-quality','safe-ai-data','workflow-basics']
  },
  {
    id:'spreadsheet-validation',title:'Validate AI-assisted spreadsheet work',section:'Workflows',
    keywords:['spreadsheet','spreadsheets','excel','formula','formulas','numbers','calculations','totals','validation','analysis'],
    summary:'Work on a copy and reconcile formulas, units and totals before anyone relies on a result.',
    prerequisites:['An approved copy of the workbook, clear column definitions and permission to process its data.','A known expected result for a small sample and a reviewer who understands the calculation.'],
    steps:['Define the exact sheet, range, task and output. Identify headers, units, currency, date format, missing values and which cells must remain unchanged.','Ask the external AI tool to explain the proposed formula or analysis before applying it. Keep the original workbook as a recovery point.','Check cell references, absolute versus relative ranges, filters, hidden rows and treatment of blanks or zeroes. Recalculate a small example independently.','Test edge cases such as a blank value, a negative number, duplicate rows and a boundary date. Check that formulas still behave after adding a new row.','Reconcile source row counts and totals with the output. Review changed cells and downstream formulas, then have the owner accept the reviewed copy.'],
    troubleshooting:['If a total differs, inspect the selected range, filters, duplicate records and units before asking for another summary.','If the explanation is fluent but the formula is wrong, trust the independent calculation. AI-generated formulas and insights can be inaccurate.'],
    successChecks:['Sample calculations and reconciled totals match the independent baseline, and unchanged cells remain unchanged.','The reviewer can explain the calculation and its treatment of missing or exceptional data.'],
    note:'External AI practice. Kairo does not open, edit, or validate spreadsheets. Its opportunity calculations use the assumptions you enter and do not verify your workbook.',
    sources:[source('Microsoft: Copilot in Excel accuracy and review requirements','https://support.microsoft.com/en-us/excel/copilot/frequently-asked-questions-about-copilot-in-excel')],related:['answer-quality','business-case','safe-ai-data']
  },
  {
    id:'sop-preparation',title:'Prepare reliable SOPs for an internal assistant',section:'Systems',
    keywords:['sop','sops','procedures','knowledge','handbook','internal','assistant','documents','preparation'],
    summary:'Organize approved procedures and test questions before building any document assistant.',
    prerequisites:['A named content owner, current source documents and a defined audience.','An approved external assistant project and a plan for preserving source access permissions.'],
    steps:['Select one process and its authoritative procedure. Resolve conflicting versions and identify the effective date, owner and next review date.','Structure each procedure around purpose, prerequisites, numbered steps, exceptions, escalation and the responsible role. Keep headings and source identifiers with the content.','Remove obsolete duplicates and separate policy from examples. Document contradictions for the owner to resolve rather than letting an assistant choose a rule.','Build a small question list covering normal work, exceptions, missing information and a question outside the procedure. Write expected answers with source locations.','Have the implementation owner verify supported file formats, source synchronization and user access in the chosen system. Test the approved questions before adding more content.'],
    troubleshooting:['If answers combine incompatible procedures, check version metadata and source boundaries. A larger document collection will not fix unresolved source conflicts.','If the source is a scanned image or complex table, verify extraction first with the PDF and OCR guide.'],
    successChecks:['A staff member can locate the authoritative procedure and answer the test questions directly from it.','The external implementation has an owner for updates and a tested way to refuse unsupported or unauthorized questions.'],
    note:'External AI preparation. Kairo’s Systems inventory records context; it does not ingest files, create a knowledge base, or retrieve company documents.',
    sources:[source('Microsoft: knowledge sources, supported content and authentication considerations','https://learn.microsoft.com/en-in/microsoft-copilot-studio/knowledge-copilot-studio')],related:['retrieval-permissions','retrieval-quality','document-extraction']
  },
  {
    id:'support-handoff',title:'Design customer support with a clear human handoff',section:'Workflows',
    keywords:['support','customer','service','handoff','human','person','escalation','live','agent','chatbot'],
    summary:'Define which questions an external support assistant may handle and how a person takes over.',
    prerequisites:['Approved support answers, a staffed escalation destination and an owner for customer-facing content.','A reviewed external support platform with an actual human-routing integration.'],
    steps:['Start with a narrow set of routine questions. Identify cases requiring a person, including a direct request, uncertainty, repeated failure and sensitive or consequential decisions.','Write an escalation packet: customer’s stated problem, attempted steps, relevant record references and unresolved question. Include only information the receiving team is permitted to see.','Define the handoff behavior when staff are available, busy or offline. Tell the customer what actually happened and how to continue; do not promise a connected person before the transfer succeeds.','In the external platform, connect the supported engagement channel and test its real customer surface. A handoff node or demo response alone does not prove a staffed transfer works.','Test a routine answer, an unsupported question, an explicit human request and a failed transfer. Have the support owner review quality and update the content as policies change.'],
    troubleshooting:['If a handoff says it succeeded but no person receives it, inspect channel configuration and the receiving queue before sending customers through again.','If the assistant keeps answering after a human takes over, check conversation ownership and duplicate event handling in that external implementation.'],
    successChecks:['A real test reaches the intended support queue with enough approved context for the person to continue.','Unavailable staff and failed transfers produce an honest fallback rather than a dead end.'],
    note:'External AI practice. Kairo does not provide a customer chatbot, live-support queue, or human-transfer connector. Use its workflow inventory to document the process only.',
    sources:[source('Microsoft: live-agent handoff prerequisites and channel behavior','https://learn.microsoft.com/en-us/microsoft-copilot-studio/advanced-hand-off')],related:['workflow-basics','answer-quality','voice-conversation']
  },
  {
    id:'team-ai-training',title:'Train a team around a practical AI policy',section:'Governance',
    keywords:['training','team','staff','employees','literacy','adoption','policy','acceptable','guidelines'],
    summary:'Give people a small set of approved uses, review habits and a clear way to ask for help.',
    prerequisites:['A policy owner, approved tools and a low-risk example relevant to the team’s work.','A way for staff to report a mistake or ask whether a use is allowed.'],
    steps:['Write a one-page starting policy: approved tools, allowed information, forbidden uses, human review requirements and who approves exceptions. Have the responsible owner review it.','Show a role-specific task using synthetic or approved data. Demonstrate a useful result, a believable mistake and how to check the source.','Let each participant practice the task and explain their review. Include an exercise where the correct response is to stop, ask a person or avoid sharing data.','Assign content, policy and support owners. Keep the current policy and reviewed examples in a location staff can find.','Review feedback after the pilot: what people attempted, where checks failed and whether the work improved. Adjust the training and policy with the owner rather than measuring success only by usage.'],
    troubleshooting:['If people cannot name an approved task, replace generic tool demonstrations with one real team workflow.','If use increases but errors or rework increase too, review the task and checks before broadening the rollout.'],
    successChecks:['Participants can demonstrate an allowed task, identify prohibited information and name the person to contact when uncertain.','The team has an accessible, owned policy and a recurring process for reviewing issues.'],
    note:'External AI adoption guidance. Kairo can record governance expectations and team roles; it does not train staff automatically or enforce every written policy.',
    sources:[oversight],related:['safe-ai-data','reusable-instructions','governance']
  }
].map(article=>({...article,kind:'reference',category:'Everyday AI reference'}))
