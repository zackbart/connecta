import { skill } from "./skill.generated.js";
import { remoteMcp, withCredentialDefaults, type RemoteMcpAuth } from "../../connectors/remote-mcp.js";
import { keys, optionsOf } from "../../config-schema.js";
import { REMOTE_MCP_AUTH } from "../../connectors/option-shapes.js";
import { reviewedCatalog } from "../../catalog-drift.js";
import { defineProvider, PROVIDER_COMMON, type ProviderOptions } from "../../provider.js";
import type { ConnectorCallAdmissionPolicy, ToolClassification } from "../../types.js";

/** Which of Linear's two hosted MCP endpoints this connection is bound to. */
export type LinearAccess = "read-write" | "read-only";

/**
 * Linear publishes two hosted endpoints. `read-only` is not a client-side
 * filter: it advertises the `read` scope alone, so the token minted for it
 * cannot reach Linear's write APIs at all. The deprecated `/sse` transport is
 * deliberately absent — it now answers 404.
 */
export const LINEAR_MCP_ENDPOINTS: Readonly<Record<LinearAccess, string>> = {
  "read-write": "https://mcp.linear.app/mcp",
  "read-only": "https://mcp.linear.app/mcp/readonly",
};

export interface LinearOptions extends ProviderOptions {
  /**
   * Human-readable display name; defaults to "Linear", or
   * "Linear (read-only)" when `access` is `"read-only"`.
   */
  title?: string;
  /** Which workspace this is and what decisions it answers. */
  purpose: string;
  /**
   * Endpoint selection, required with no default. Linear's read-only endpoint
   * advertises the `read` scope alone, so its token cannot reach the write APIs
   * — a stronger guarantee than any annotation. Neither default is safe:
   * read-write hands out access nobody asked for, and read-only breaks a
   * writing deployment at runtime, where no agent can repair it.
   */
  access: LinearAccess;
  /**
   * OAuth 2.1 with dynamic client registration by default. Linear's MCP server
   * also accepts a personal API key in `Authorization: Bearer` — note this is
   * the MCP endpoint's own documented contract, not the GraphQL API convention.
   * A personal key carries the acting user's full permissions, so pair it with
   * `access: "read-only"` unless the deployment genuinely writes.
   */
  auth?: RemoteMcpAuth;
  /** Workspace-specific conventions appended to the maintained provider guide. */
  instructions?: string;
  /**
   * Optional per-runtime policy. There is no default: Linear documents no
   * MCP-specific limit, the GraphQL limits it rides are metered per user per
   * hour (and its own page disagrees with itself on the API-key figure), and
   * Connecta's counter is per runtime. Only the operator knows the workspace.
   */
  callAdmission?: ConnectorCallAdmissionPolicy;
}

/**
 * Every `save_*` is destructive because Linear's `save_*` tools are upserts:
 * omitting a record id creates, supplying one overwrites in place, and the
 * schema cannot tell them apart.
 */
const UPSERT =
  "An upsert: supplying a record id overwrites that record in place, and the schema cannot tell a create from an update.";

/**
 * The release-reviewed classification (P5), used both to classify a live tool
 * and as the record the drift check compares against, so the annotation a
 * caller gets and the verdict a check reads can never disagree. It is a
 * superset: Linear's hosted `tools/list` varies by plan and enabled features,
 * so a name this workspace never returns costs nothing, while an unlisted new
 * one without an explicit read annotation fails closed. The genuine creates —
 * the `create_*_label` and attachment tools — are plain writes rather than
 * destructive.
 */
const LINEAR_CLASSIFICATION: ToolClassification = {
  tools: {
    // Issues
    list_issues: {
      schemaDigest: "sha256:294b644db541de9f1f4cec011164fe7cec29153aa12d5d94d0748fe35fe973d4",
      "verdict": "read",
      "reason": "Reads existing Linear list issues data without changing workspace state.",
    },
    get_issue: {
      schemaDigest: "sha256:33b204248ae63119751ed4cbade909b05cfbd9aa241cd39e4cec5690d062688e",
      "verdict": "read",
      "reason": "Reads existing Linear get issue data without changing workspace state.",
    },
    list_issue_statuses: {
      schemaDigest: "sha256:8a740e800811796eab16dee1c22db5d8e3c971bebf3ccec7d7d2ee36157f4316",
      "verdict": "read",
      "reason": "Reads existing Linear list issue statuses data without changing workspace state.",
    },
    get_issue_status: {
      schemaDigest: "sha256:ea4e287dc5fc9b930b790430ca02f221a75444d789a252d87aff838767ce4f05",
      "verdict": "read",
      "reason": "Reads existing Linear get issue status data without changing workspace state.",
    },
    list_issue_labels: {
      schemaDigest: "sha256:5eb361d26464fcaef257499c150bf9cb9349308d03ef31c119e826752cbc998e",
      "verdict": "read",
      "reason": "Reads existing Linear list issue labels data without changing workspace state.",
    },
    save_issue: {
      schemaDigest: "sha256:23a22fd38cd3234f3a112c460daf04779034e54e45ed00ca27232574f3d60547",
      verdict: "destructive",
      reason: UPSERT,
    },
    save_issue_label: {
      schemaDigest: "sha256:a39c5e1194b33f1a07139c6c2219a991a818f7027b26aef059959bc67248d528",
      verdict: "destructive",
      reason: UPSERT,
    },
    retire_issue_label: {
      schemaDigest: "sha256:d9f254b2c134123d14a9b91ed0df063d45aa99d85f2ccdaf90ac57aa3c50a3de",
      verdict: "destructive",
      reason:
        "Retires an existing issue label or group, including child labels, so it cannot be applied to new records.",
    },
    restore_issue_label: {
      schemaDigest: "sha256:d9f254b2c134123d14a9b91ed0df063d45aa99d85f2ccdaf90ac57aa3c50a3de",
      verdict: "destructive",
      reason: "Restores an existing issue label or group and every child label, including children retired separately.",
    },
    create_issue_label: {
      schemaDigest: "sha256:92a9bbefc33410795f6c23ae609b1cb61d6168b36b5b60f4563090e468c7f53c",
      "verdict": "write",
      "reason": "Creates Linear state through create_issue_label; the reviewed operation only appends.",
    },
    // Projects
    list_projects: {
      schemaDigest: "sha256:3cadc9d39d1372e89bf671ae44b88aee4d7bc0d23af24979e2401facedd0253f",
      "verdict": "read",
      "reason": "Reads existing Linear list projects data without changing workspace state.",
    },
    get_project: {
      schemaDigest: "sha256:e752476aabfdf9d25b03a57f682f6fcb187b10d823a3c6371abe49f7dda8a6e0",
      "verdict": "read",
      "reason": "Reads existing Linear get project data without changing workspace state.",
    },
    list_project_labels: {
      schemaDigest: "sha256:5eb361d26464fcaef257499c150bf9cb9349308d03ef31c119e826752cbc998e",
      "verdict": "read",
      "reason": "Reads existing Linear list project labels data without changing workspace state.",
    },
    save_project: {
      schemaDigest: "sha256:2531c09aba662f0793dad42fa43d32708fe68047479cf2c00b32f368e1014413",
      verdict: "destructive",
      reason: UPSERT,
    },
    save_project_label: {
      schemaDigest: "sha256:703b141f537e40c693fd6cf5e6fc8ba97359830f943e022f4b32414562e72719",
      verdict: "destructive",
      reason: UPSERT,
    },
    retire_project_label: {
      schemaDigest: "sha256:d9f254b2c134123d14a9b91ed0df063d45aa99d85f2ccdaf90ac57aa3c50a3de",
      verdict: "destructive",
      reason:
        "Retires an existing project label or group, including child labels, so it cannot be applied to new records.",
    },
    restore_project_label: {
      schemaDigest: "sha256:d9f254b2c134123d14a9b91ed0df063d45aa99d85f2ccdaf90ac57aa3c50a3de",
      verdict: "destructive",
      reason:
        "Restores an existing project label or group and every child label, including children retired separately.",
    },
    // Milestones
    list_milestones: {
      schemaDigest: "sha256:97e2d99f903538f1a99d7aef71bb8215dc99279e4395310c14a1c5c67852444a",
      "verdict": "read",
      "reason": "Reads existing Linear list milestones data without changing workspace state.",
    },
    get_milestone: {
      schemaDigest: "sha256:5631cd5fdcd020ad3b57ee65dc92ec32a8be0df06136a7bcb1a83e5fb333df71",
      "verdict": "read",
      "reason": "Reads existing Linear get milestone data without changing workspace state.",
    },
    save_milestone: {
      schemaDigest: "sha256:d55f3018b2e8693c950e71751a6769f056f85cc51f351c1df26674f45eda4974",
      verdict: "destructive",
      reason: UPSERT,
    },
    // Initiatives
    list_initiatives: {
      schemaDigest: "sha256:7d4bf3b546207ae0e41e215dc1f115ae05c61125b3299335a290e42498a63704",
      "verdict": "read",
      "reason": "Reads existing Linear list initiatives data without changing workspace state.",
    },
    get_initiative: {
      schemaDigest: "sha256:dda5376b85019b51df65b94ed0baed0bf2715d59567ff6169bbcf67c6794ba81",
      "verdict": "read",
      "reason": "Reads existing Linear get initiative data without changing workspace state.",
    },
    list_initiative_labels: {
      schemaDigest: "sha256:8c844c2f031db6e3c2665dac47e3ea8b006330b4bcc6df4b6479055e57ee057d",
      "verdict": "read",
      "reason": "Reads existing Linear list initiative labels data without changing workspace state.",
    },
    save_initiative: {
      schemaDigest: "sha256:65a4b02ead7630b12db3d9811192fb2595b8a34c79e1146a19318d640bf8b104",
      verdict: "destructive",
      reason: UPSERT,
    },
    save_initiative_label: {
      schemaDigest: "sha256:23a42a87a9420428381a719b5a64d4514c5edd97bddb885517ade6306d36bbe0",
      verdict: "destructive",
      reason: UPSERT,
    },
    retire_initiative_label: {
      schemaDigest: "sha256:d9f254b2c134123d14a9b91ed0df063d45aa99d85f2ccdaf90ac57aa3c50a3de",
      verdict: "destructive",
      reason:
        "Retires an existing initiative label or group, including child labels, so it cannot be applied to new records.",
    },
    restore_initiative_label: {
      schemaDigest: "sha256:d9f254b2c134123d14a9b91ed0df063d45aa99d85f2ccdaf90ac57aa3c50a3de",
      verdict: "destructive",
      reason:
        "Restores an existing initiative label or group and every child label, including children retired separately.",
    },
    create_initiative_label: {
      schemaDigest: "sha256:442e098c4e81e46071f13f9359dd296acd1cb03eee0c71d68fc7a329cc503277",
      "verdict": "write",
      "reason": "Creates Linear state through create_initiative_label; the reviewed operation only appends.",
    },
    // Saved views
    list_custom_views: {
      schemaDigest: "sha256:ec3cbc000f325d82c0b4949acf6995cf4c11d4b4084c84037ee5aa5801eea92d",
      verdict: "read",
      reason: "Lists accessible saved view metadata without changing views or their matching records.",
    },
    // Cycles
    list_cycles: {
      schemaDigest: "sha256:39d0ade50e1bbe3e68f366b12b9ce001d4ab39dda416e061cc670c402963237f",
      "verdict": "read",
      "reason": "Reads existing Linear list cycles data without changing workspace state.",
    },
    // Comments
    list_comments: {
      schemaDigest: "sha256:cd004335be5c0e9dfcd7997be16527cbaaf1eafddfa1ff0c367d904fb4c7372b",
      "verdict": "read",
      "reason": "Reads existing Linear list comments data without changing workspace state.",
    },
    save_comment: {
      schemaDigest: "sha256:795f5d486218ccfe5d2d3480d8624feecb0af92cbff80804c3030a994aa343aa",
      verdict: "destructive",
      reason: UPSERT,
    },
    delete_comment: {
      schemaDigest: "sha256:2c78afdc6b2a0e16421b88ad51e84fcc86f64ae7b551eae01a2f3c8437ebbb2b",
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through delete_comment.",
    },
    // Documents
    list_documents: {
      schemaDigest: "sha256:0c34f1ad0045ed166a200790b80cc274357f8dd916bade75267ce17ad3a0cd70",
      "verdict": "read",
      "reason": "Reads existing Linear list documents data without changing workspace state.",
    },
    get_document: {
      schemaDigest: "sha256:3cb4635f04b8a5b10b6973a579123b0ff38b9942a4e5c019140c94c67bd23c29",
      "verdict": "read",
      "reason": "Reads existing Linear get document data without changing workspace state.",
    },
    save_document: {
      schemaDigest: "sha256:a1022c0e1a427aca42a5032acc1fe798eb41a6b503a9b8f2b0b1842bcc42b77a",
      verdict: "destructive",
      reason: UPSERT,
    },
    // Inbox
    get_notifications: {
      schemaDigest: "sha256:eae99e7b6395842bd0aa3008dc4b8b75c12be444bca1111f68352127db852750",
      verdict: "read",
      reason: "Lists the authenticated user's inbox notifications without marking or snoozing them.",
    },
    mark_notification: {
      schemaDigest: "sha256:96190ee9b29c980c1df2bf741ec1eebc49eed9a87f6db74d89bfa87b800b7fac",
      verdict: "write",
      reason:
        "Changes read/unread or snooze state in the authenticated user's inbox; the reviewed operation removes no workspace record.",
    },
    // Teams and users
    list_teams: {
      schemaDigest: "sha256:35496fcc47293f7976a418f5babd99f063465c9b614606b1feb0ab13879a4048",
      "verdict": "read",
      "reason": "Reads existing Linear list teams data without changing workspace state.",
    },
    get_team: {
      schemaDigest: "sha256:4e62e3954a183e2256921cd40450335d3fcd6b4ba52354854a4257efabebf256",
      "verdict": "read",
      "reason": "Reads existing Linear get team data without changing workspace state.",
    },
    list_users: {
      schemaDigest: "sha256:2ce638c3be81ff50ac7a4f2c929cce39a62a011aad006ba9a26569a45ad095e5",
      "verdict": "read",
      "reason": "Reads existing Linear list users data without changing workspace state.",
    },
    get_user: {
      schemaDigest: "sha256:5046c1d7d44be9142585a2fbd71785fb6f5832b99d723763251913e1a4ccc6f9",
      "verdict": "read",
      "reason": "Reads existing Linear get user data without changing workspace state.",
    },
    get_workspace: {
      schemaDigest: "sha256:caa1215d2278f303733e5fcb008a09853e2bc0e4d5545416a1f40eb4e3ba29fe",
      "verdict": "read",
      "reason": "Reads existing Linear get workspace data without changing workspace state.",
    },
    get_triage_responsibility: {
      schemaDigest: "sha256:8ee4f3c9799a763001089d1a56691020fac5bf9866b80bdbc21495702051737b",
      verdict: "read",
      reason: "Reads a team's current triage responsibility and upcoming rotation shifts without changing assignments.",
    },
    // Templates
    list_templates: {
      schemaDigest: "sha256:387aea405fd7d1ebd9b44228865f55dcc03cdbf1ff82dfe6a6766994177b3531",
      "verdict": "read",
      "reason": "Reads existing Linear list templates data without changing workspace state.",
    },
    get_template: {
      schemaDigest: "sha256:b5feb94b620c9466a87c0feb232e19223e73abb1965579208c1aa47e6ef2b082",
      "verdict": "read",
      "reason": "Reads existing Linear get template data without changing workspace state.",
    },
    // Status updates
    get_status_updates: {
      schemaDigest: "sha256:af40904370cffcca265f1a05bff133d561c7009f6960a84096025cf8163663f3",
      "verdict": "read",
      "reason": "Reads existing Linear get status updates data without changing workspace state.",
    },
    save_status_update: {
      schemaDigest: "sha256:5078fdc9f3ea4ee104d05def28e45949083d4f2ff6f2435bd6b856abccbece75",
      verdict: "destructive",
      reason: UPSERT,
    },
    delete_status_update: {
      schemaDigest: "sha256:5e4e4cdac2d818bdc2a572947a11a28b251797e59affea97aa3b853f5439bf7f",
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through delete_status_update.",
    },
    // Releases
    list_release_pipelines: {
      schemaDigest: "sha256:7a20220ffbd895f834a0bd85ab6a444fbe7d71ee5b1d5dcbf8c109c7451984e0",
      "verdict": "read",
      "reason": "Reads existing Linear list release pipelines data without changing workspace state.",
    },
    list_releases: {
      schemaDigest: "sha256:c9c6fa51eb980c3304a37f64e2a73f6e2e03e252330fcdb4ab9fc2e995c949cc",
      "verdict": "read",
      "reason": "Reads existing Linear list releases data without changing workspace state.",
    },
    get_release: {
      schemaDigest: "sha256:6adeb4b4a0cb4888cfb45bf0a0d047f6de516dc05b7067912f5ba77025155fdb",
      "verdict": "read",
      "reason": "Reads existing Linear get release data without changing workspace state.",
    },
    list_release_notes: {
      schemaDigest: "sha256:b0f1da15034143f29d44d949ea08bdfec2509ef196175a7a8ee5db11b655b06a",
      "verdict": "read",
      "reason": "Reads existing Linear list release notes data without changing workspace state.",
    },
    get_release_note: {
      schemaDigest: "sha256:d28c0187ad65bca21b32451f8ab1d4a1c1a26efb485b9d4395e9b3d41555f532",
      "verdict": "read",
      "reason": "Reads existing Linear get release note data without changing workspace state.",
    },
    save_release: {
      schemaDigest: "sha256:97db7fa9246750a0533d07ed73d633fadc3fe2f27f2bf95deb6ea86bbcb2bc4b",
      verdict: "destructive",
      reason: UPSERT,
    },
    save_release_note: {
      schemaDigest: "sha256:933c46faa3bb1edb4e9cc89299ab7dbcdaafab4bee6615aa43d538703fe4dab7",
      verdict: "destructive",
      reason: UPSERT,
    },
    // Code review
    list_diffs: {
      schemaDigest: "sha256:1eccf293d83cd2d962e6f840cd42dac43eaee1a15cbf7ea6b78bd6b55fe94313",
      "verdict": "read",
      "reason": "Reads existing Linear list diffs data without changing workspace state.",
    },
    get_diff: {
      schemaDigest: "sha256:692aaf3e4a1adb0b82e38bf01574b6615747f48619e295f0377255cf2fd3dbaa",
      "verdict": "read",
      "reason": "Reads existing Linear get diff data without changing workspace state.",
    },
    get_diff_threads: {
      schemaDigest: "sha256:98b66ecda18665bf883e70169c472802105fc113c0f39d3e25da76824b3e3457",
      "verdict": "read",
      "reason": "Reads existing Linear get diff threads data without changing workspace state.",
    },
    save_diff_comment: {
      schemaDigest: "sha256:29a06cce756a5f3a6987693129a260659cad50083f7400723fb0b8bc9dd2b8bb",
      verdict: "destructive",
      reason: UPSERT,
    },
    resolve_diff_thread: {
      schemaDigest: "sha256:e493a5e74c1fd7e7bf104dbed8032c721c15209991aa12686c7f46b82a49ab2e",
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through resolve_diff_thread.",
    },
    delete_diff_comment: {
      schemaDigest: "sha256:88db600198790b6c99b6e9397d26649f49d48b0deaa758dc64e6f8b516d817c7",
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through delete_diff_comment.",
    },
    submit_diff_review: {
      schemaDigest: "sha256:97aa13f00d23db8d16191104dae0ddd2a3dd1c047415bf770474be0180320acf",
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through submit_diff_review.",
    },
    update_diff: {
      schemaDigest: "sha256:8e5b77961d3d344b99a68cb82901d3764f6fb4c700f42c3c2fc59ea12a490f27",
      verdict: "destructive",
      reason:
        "Changes an existing diff's metadata, review requests, issue links or status; combined updates can partially succeed.",
    },
    merge_diff: {
      schemaDigest: "sha256:e809bf0416c3cfb99794448eb66f69f83bbd7a451604faec7f622f47025f17fc",
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through merge_diff.",
    },
    // Attachments
    get_attachment: {
      schemaDigest: "sha256:158ac0e0add99d9a9109a4f3549266be8f2d1eb5fa0832c861a4c56c20708a3b",
      "verdict": "read",
      "reason": "Reads existing Linear get attachment data without changing workspace state.",
    },
    prepare_attachment_upload: {
      schemaDigest: "sha256:641559612992b1f6c1cd69fec3c66b898c12d2a21bc58973589be81fc2612c9c",
      verdict: "write",
      reason: "Mints an upload URL: a side effect, but it changes no existing record.",
    },
    create_attachment_from_upload: {
      schemaDigest: "sha256:10818ba9327b9b70816512fd557ed3b4b85776f47cf8ca498f0d3ba17953dc2a",
      "verdict": "write",
      "reason": "Creates Linear state through create_attachment_from_upload; the reviewed operation only appends.",
    },
    create_attachment: {
      schemaDigest: "sha256:0a4e4d5f6b62b5fbfd52d466d8b3167005e3574f3d00cf92e2fbfbbe769d8a1e",
      "verdict": "write",
      "reason": "Creates Linear state through create_attachment; the reviewed operation only appends.",
    },
    delete_attachment: {
      schemaDigest: "sha256:ef21d1c1a7d09827b3c44bdefe18fc2dec28af468d19d2060f97df0a0f76bd0e",
      "verdict": "destructive",
      "reason": "Changes or removes existing Linear state through delete_attachment.",
    },
    // Explicit issue access.
    share_issue: {
      schemaDigest: "sha256:f41410b4cf5effc62a03ad26bcf76ba792a1f7bea52a78da9183b5279b4a0433",
      verdict: "destructive",
      reason: "Changes who can see an existing issue.",
    },
    unshare_issue: {
      schemaDigest: "sha256:f41410b4cf5effc62a03ad26bcf76ba792a1f7bea52a78da9183b5279b4a0433",
      verdict: "destructive",
      reason: "Changes who can see an existing issue.",
    },
    // Agent skills
    list_agent_skills: {
      schemaDigest: "sha256:38fc34a53e932314e0bf6abc6493bca1256d37a951befceb95c1fe13bfa46ebd",
      "verdict": "read",
      "reason": "Reads existing Linear list agent skills data without changing workspace state.",
    },
    get_agent_skill: {
      schemaDigest: "sha256:deb4296f3f7612ffb1af1e6ec75976acdc04ba12aff6c129a92b5a87e7a9ee09",
      "verdict": "read",
      "reason": "Reads existing Linear get agent skill data without changing workspace state.",
    },
    // Documentation search
    search_documentation: {
      schemaDigest: "sha256:c2b89b06275e7b0cb63b73af749ae88b694446066058584e65c9208e33339efa",
      "verdict": "read",
      "reason": "Reads existing Linear search documentation data without changing workspace state.",
    },
    // Customer requests (plan-gated)
    list_customers: {
      "verdict": "read",
      optional: true,
      "reason": "Reads existing Linear list customers data without changing workspace state.",
    },
    list_customer_needs: {
      verdict: "read",
      optional: true,
      reason:
        "Lists customer requests for an issue, project or initiative; announced in Linear's 2026-10-08 changelog and plan-gated in hosted catalogs.",
    },
    save_customer: { verdict: "destructive", optional: true, reason: UPSERT },
    delete_customer: {
      "verdict": "destructive",
      optional: true,
      "reason": "Changes or removes existing Linear state through delete_customer.",
    },
    save_customer_need: { verdict: "destructive", optional: true, reason: UPSERT },
    delete_customer_need: {
      "verdict": "destructive",
      optional: true,
      "reason": "Changes or removes existing Linear state through delete_customer_need.",
    },
    // Markdown helper.
    extract_images: {
      schemaDigest: "sha256:1d7273f64621448fd901fb4ac94ee3b29a4c4a833f0b27083775bd685f8a401c",
      verdict: "read",
      reason:
        "Reads images out of content it is handed and touches no workspace state; the hosted server ships it annotated readOnlyHint: true and idempotentHint: true.",
    },
  },
};

/**
 * Connection-independent conventions. The access note and purpose lead the
 * rendered guide; deployment instructions follow it.
 */

/** The closed options linear() accepts, checked against LinearOptions. */
const LINEAR_OPTIONS = optionsOf<LinearOptions>()({
  ...PROVIDER_COMMON,
  ...keys("access"),
  auth: REMOTE_MCP_AUTH,
});

/** A maintained Linear hosted-MCP connection. */
export const linear = defineProvider<LinearOptions>({
  name: "linear",
  title: "Linear",
  kind: "mcp",
  readme: "Linear",
  bundle: { "baselineGzip": 127244 },
  skill,
  options: LINEAR_OPTIONS,
  classify: LINEAR_CLASSIFICATION,
  create(id, options, provider) {
    const access = options.access;
    if (access !== "read-write" && access !== "read-only") {
      throw new Error(`linear("${id}") requires access "read-write" or "read-only".`);
    }
    // Leads the guide because discovery summarizes a connector by its first
    // content line: whether this connection can write at all is the one thing
    // an agent must know before it opens the guide, and `search_tools` shows
    // the summary without the description.
    const accessNote =
      access === "read-only"
        ? "Read-only connection: bound to Linear's read-only endpoint, whose token is scope-limited downstream, so every write fails at Linear regardless of arguments. Route writes to a connector configured for read-write access."
        : "Read-write connection: treat every `save_`, `create_`, `delete_`, `retire_`, `restore_`, `mark_`, `update_`, `resolve_`, `submit_`, `share_`, `unshare_`, `prepare_`, and `merge_` operation as a write. Connecta classifies the maintained writes explicitly, and a read-only endpoint refuses them. Unknown tools without an explicit, uncontradicted read annotation fail closed.";
    return remoteMcp(id, {
      url: LINEAR_MCP_ENDPOINTS[access],
      ...provider.connectorOptions,
      // The title is what browse-time discovery renders; a read-only
      // connection says so there rather than only in a description the caller
      // may not see.
      title: options.title ?? (access === "read-only" ? "Linear (read-only)" : "Linear"),
      description:
        access === "read-only"
          ? `Linear issue tracking and project planning (read-only) — ${options.purpose}`
          : `Linear issue tracking and project planning — ${options.purpose}`,
      // Linear's MCP endpoint takes an API key the same way it takes an OAuth
      // token — `Authorization: Bearer <yourtoken>` — so only the slot copy is
      // provider-specific and the bearer framing default stands. The
      // bare-header convention belongs to Linear's GraphQL API, not to this
      // endpoint.
      auth: withCredentialDefaults(options.auth ?? { type: "oauth" }, {
        credential: {
          label: "Personal API key",
          description:
            "A Linear personal API key. It carries the issuing user's full workspace access and is stored encrypted; the read-only endpoint still limits what it can reach.",
          placeholder: "lin_api_…",
        },
      }),
      requireHttps: true,
      classify: provider.classify,
      usageGuide: provider.usageGuide({
        context: [accessNote, `Workspace purpose: ${options.purpose}`],
        // Explicit rather than derived. The derived summary would truncate the
        // access note mid-sentence at 120 characters, and the one thing a
        // browsing agent must not get wrong is whether this connection can
        // write at all ([#342](https://github.com/zackbart/connecta/issues/342)).
        // Not `required`: Linear's own schemas describe each call correctly;
        // the guide adds cross-tool sequence advice worth reading before a
        // write, not before every read.
        summary:
          access === "read-only"
            ? "Read-only: every write fails at Linear. Id resolution, upsert semantics, and cursor paging."
            : "Read-write. Id resolution, `save_*` upsert semantics, plan-gated areas, and cursor paging.",
      }),
    });
  },
});

/**
 * The reviewed classification in the legacy manifest form.
 *
 * @deprecated Read `linear.definition.classify` instead. This alias is derived
 * from it and retained for existing public imports.
 */
export const LINEAR_VETTED_CATALOG = reviewedCatalog(linear.definition.classify!, 'defineProvider("linear")');
