export const PROVIDER_HELP_ARTICLES = [
  {
    id:'provider-setup',title:'Choose Microsoft 365, Google Workspace or AWS',section:'Integrations',category:'Integrations and cloud providers',
    keywords:['provider','integration','connection','connect','setup','google','workspace','aws','microsoft','plan','resume'],
    summary:'Save a plan for the provider and first use case your business needs.',
    prerequisites:['A mapped business workflow and the systems it uses.'],
    steps:['Open Integrations and choose Plan Microsoft 365, Plan Google Workspace or Plan AWS.','Select the first use case, then save the integration plan. The saved plan remains in this company’s integration inventory.','Review the availability label. Microsoft actions are implemented; Google Workspace and AWS connectors are planned and cannot connect or run yet.','Return to Integrations to review saved plans and their next setup requirements. You can record more than one provider for a mixed environment.'],
    troubleshooting:['If a save is not confirmed, check the current company and refresh before repeating it.','A Planned availability label means the provider cannot connect or execute yet.'],
    note:'A saved plan is not a connection, access grant, scheduled job or runnable workflow. Keep passwords, client secrets and access keys out of inventory notes.',
    successChecks:['The saved plan shows the intended provider and use case without claiming an account is connected.'],
    related:['google-workspace-plan','aws-plan','microsoft-setup']
  },
  {
    id:'google-workspace-plan',title:'Plan a Google Workspace integration',section:'Integrations',category:'Integrations and cloud providers',
    keywords:['google','workspace','gmail','drive','calendar','oauth','profile','file','permission','connect','connection','integration','plan'],
    summary:'Plan profile, selected Drive files, Gmail inbox status or upcoming Calendar events. The Google connector is not implemented yet.',
    prerequisites:['An intended Google Workspace task and an administrator who can review third-party app access.'],
    steps:['Choose Google Workspace in the integration planner and save one first use case.','Start with identity verification and explicitly selected files; request Calendar or Gmail permissions only when a feature needs them.','Before connection becomes available, the implementation must include secure OAuth, actual permission checks, reconnect handling, review requirements and tested read actions.','Return to Integrations to review the saved plan and its availability before attempting any setup.'],
    externalSteps:['Google user OAuth authorizes Workspace data access separately from signing into Kairo. A Workspace administrator may need to approve the app.','Google’s drive.file permission limits file access but can permit writes. A read-only connector must separately restrict its methods.','Gmail metadata and Gmail read-only are restricted scopes. Server-side processing can require additional verification and security assessment; metadata is not an exemption.'],
    troubleshooting:['Do not interpret a saved plan or Google sign-in as Workspace access.','If your organization restricts third-party apps, have the Workspace administrator review the intended feature first.'],
    note:'Kairo cannot currently connect Google Workspace or execute these actions. Saving this plan does not request consent or grant access.',
    sources:[{label:'Google web-server OAuth',url:'https://developers.google.com/identity/protocols/oauth2/web-server'},{label:'Drive scope guide',url:'https://developers.google.com/workspace/drive/api/guides/api-specific-auth'},{label:'Gmail scope guide',url:'https://developers.google.com/workspace/gmail/api/auth/scopes'}],
    related:['provider-setup','aws-plan','workflow-basics']
  },
  {
    id:'aws-plan',title:'Plan AWS identity, S3 and CloudWatch reads',section:'Integrations',category:'Integrations and cloud providers',
    keywords:['aws','amazon','cloud','s3','cloudwatch','iam','role','temporary','identity','metric','alarm','storage','connect','integration','plan'],
    summary:'Plan AWS identity checks, approved S3 reads or CloudWatch metrics and alarms. The AWS connector is not implemented yet.',
    prerequisites:['A business task, an AWS account owner, and the smallest set of resources that task needs.'],
    steps:['Choose AWS in the integration planner and save one first use case.','Record the requirement without entering AWS access keys. A future connector should use a reviewed customer IAM role and temporary STS credentials.','Have the implementation owner define permitted buckets, prefixes, regions and read actions. Treat CloudWatch Logs as a separate feature with its own permission and cost review.','Before connection becomes available, test role identity, permitted reads and denied resources independently. A successful identity check does not prove data access.'],
    externalSteps:['Cross-account role access uses an approved trusted principal and a unique external ID. OIDC federation is a separate trust mechanism; ordinary Google sign-in does not grant AWS access.','Some CloudWatch metric reads need broader IAM resource access than an individual metric. Application-level selections do not narrow the underlying grant.','Read-only requests can incur AWS charges. Define query limits and review cost before live testing.'],
    troubleshooting:['An identity check does not establish that the intended S3 prefix or CloudWatch action is allowed.','Do not solve a permission failure by granting account-wide administrator access.'],
    note:'Kairo cannot currently connect AWS or run these checks. A saved plan does not create a role, change IAM, provision resources or incur provider request charges.',
    sources:[{label:'AWS third-party role access',url:'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_common-scenarios_third-party.html'},{label:'AWS caller identity',url:'https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html'},{label:'CloudWatch pricing',url:'https://aws.amazon.com/cloudwatch/pricing/'}],
    related:['provider-setup','google-workspace-plan','governance']
  }
]
