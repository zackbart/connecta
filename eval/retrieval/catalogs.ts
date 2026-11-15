import { fixture as calendar } from "../../src/providers/calendar/fixtures.js";
import { fixture as cloudflare } from "../../src/providers/cloudflare/fixtures.js";
import { fixture as docs } from "../../src/providers/docs/fixtures.js";
import { fixture as drive } from "../../src/providers/drive/fixtures.js";
import { fixture as forms } from "../../src/providers/forms/fixtures.js";
import { fixture as github } from "../../src/providers/github/fixtures.js";
import { fixture as gmail } from "../../src/providers/gmail/fixtures.js";
import { fixture as granola } from "../../src/providers/granola/fixtures.js";
import { fixture as intercom } from "../../src/providers/intercom/fixtures.js";
import { fixture as meet } from "../../src/providers/meet/fixtures.js";
import { fixture as people } from "../../src/providers/people/fixtures.js";
import { fixture as sheets } from "../../src/providers/sheets/fixtures.js";
import { fixture as slides } from "../../src/providers/slides/fixtures.js";
import { fixture as stripe } from "../../src/providers/stripe/fixtures.js";
import { fixture as vercel } from "../../src/providers/vercel/fixtures.js";
import type { Connector, ToolDef } from "../../src/types.js";

export type Deployment = "personal" | "studio" | "product";

type Spec = readonly [name: string, description: string, inputs?: readonly string[]];

const READ = { readOnlyHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true } as const;

function tools(reads: readonly Spec[], writes: readonly Spec[] = []): ToolDef[] {
  const make =
    (annotations: NonNullable<ToolDef["annotations"]>) =>
    (spec: Spec): ToolDef => ({
      name: spec[0],
      description: spec[1],
      annotations,
      inputSchema: { type: "object", properties: Object.fromEntries((spec[2] ?? []).map((key) => [key, {}])) },
    });
  return [...reads.map(make(READ)), ...writes.map(make(WRITE))];
}

function remote(id: string, title: string, description: string, list: ToolDef[]): Connector {
  return {
    id,
    kind: "mcp",
    title,
    description,
    listTools: async () => list.map((tool) => ({ ...tool })),
    callTool: async () => ({ content: [] }),
  };
}

type ProviderFixture = { create(id?: string): Connector };

const accounts = (provider: ProviderFixture, base: string, suffixes: readonly string[]) =>
  ["", ...suffixes].map((suffix) => provider.create(suffix ? `${base}_${suffix}` : base));

const finance = remote(
  "finance",
  "Budget Money",
  "Household accounts, budgets, bills and cash flow.",
  tools(
    [
      [
        "list_accounts",
        "List linked bank, card, loan and investment accounts with their institution and current balance.",
        ["include_hidden"],
      ],
      ["get_account_history", "Get the daily balance history of one account.", ["account_id", "start_date"]],
      [
        "get_net_worth",
        "Get net worth over time: total assets minus liabilities across every linked account.",
        ["start_date", "interval"],
      ],
      [
        "search_transactions",
        "Search transactions by merchant, category, account, amount or date range. Rows carry date, merchant, amount and category.",
        ["search", "category_ids", "account_ids", "start_date", "end_date", "limit", "offset"],
      ],
      ["get_transaction", "Get one transaction with its splits, notes and attachments.", ["id"]],
      ["get_cashflow_summary", "Summarize income, expenses and savings rate for a period.", ["start_date", "end_date"]],
      [
        "get_spending_by_category",
        "Total spending per category for a period, largest first.",
        ["start_date", "end_date"],
      ],
      ["get_budgets", "Get budgeted amounts and actuals per category for a month, with what remains.", ["month"]],
      [
        "get_upcoming_recurring",
        "List upcoming recurring charges and bills with expected dates and amounts.",
        ["days"],
      ],
      ["list_categories", "List transaction categories and their groups."],
      ["list_tags", "List transaction tags."],
      ["list_institutions", "List connected institutions and their last sync status."],
      ["get_goals", "List savings goals with target, saved amount and progress."],
    ],
    [
      [
        "update_transaction",
        "Change a transaction's category, merchant name, notes or hidden flag.",
        ["id", "category_id", "notes"],
      ],
      [
        "set_budget_amount",
        "Set the budgeted amount for one category in one month.",
        ["category_id", "month", "amount"],
      ],
      [
        "create_manual_account",
        "Add an account that is tracked by hand rather than synced.",
        ["name", "type", "balance"],
      ],
      ["refresh_accounts", "Ask every institution to sync new transactions now."],
    ],
  ),
);

const fitness = remote(
  "fitness",
  "Training Watch",
  "Activities, sleep, heart rate, recovery and training plans recorded by a sports watch.",
  tools(
    [
      [
        "querySportRecords",
        "Query recorded activities (runs, rides, swims, strength) with date, distance, duration and pace.",
        ["startDay", "endDay", "sportType"],
      ],
      ["queryActivityDetail", "Get one activity's laps, splits, heart rate and route summary.", ["activityId"]],
      ["querySleepOverview", "Sleep stages, duration and sleep score per night.", ["startDay", "endDay"]],
      [
        "queryDailyHealthData",
        "Daily steps, calories burned, active minutes and floors climbed.",
        ["startDay", "endDay"],
      ],
      ["queryRestingHeartRate", "Resting heart rate per day.", ["startDay", "endDay"]],
      ["queryAvgHeartRate", "Average heart rate per day and per activity.", ["startDay", "endDay"]],
      ["queryRecoveryStatus", "Current recovery percentage and suggested rest before the next hard session."],
      ["queryTrainingLoadAssessment", "Acute and chronic training load, load ratio and fatigue trend."],
      ["queryFitnessAssessmentOverview", "Estimated VO2max, threshold pace and race time predictions."],
      ["queryTrainingPlanDetails", "Get one training plan's weeks and sessions.", ["planId"]],
      [
        "queryTrainingSchedule",
        "Workouts scheduled on the training calendar between two dates.",
        ["startDay", "endDay"],
      ],
      ["queryTrainingPlanLibrary", "Browse available training plans by sport and goal.", ["sportType"]],
      ["queryStressLevel", "Daily stress score.", ["startDay", "endDay"]],
      ["queryStressTimeSeries", "Stress readings through one day.", ["day"]],
      [
        "queryHealthCheckTimeSeries",
        "Heart rate variability and blood oxygen readings over time.",
        ["startDay", "endDay"],
      ],
      ["queryDeviceList", "Paired watches with battery level and firmware version."],
      ["queryPersonalRecords", "Personal best times and distances per sport."],
    ],
    [
      [
        "createWorkout",
        "Create a structured workout with intervals and pace or heart rate targets.",
        ["name", "steps"],
      ],
      ["scheduleWorkout", "Put a saved workout on the training calendar for a date.", ["workoutId", "day"]],
      ["deleteScheduledWorkout", "Remove one workout from the training calendar.", ["scheduleId"]],
    ],
  ),
);

const meals = remote(
  "meals",
  "Meal Log",
  "Food diary with calories, macros and daily goals.",
  tools(
    [
      [
        "list_meals",
        "List logged meals with foods, calories and macros between two dates.",
        ["start_date", "end_date"],
      ],
      ["get_today", "Today's meals with calorie and macro totals against goals."],
      ["get_daily_summaries", "Calorie and macro totals per day for a date range.", ["start_date", "end_date"]],
      ["search_foods", "Search the food database by name or barcode.", ["query"]],
      ["get_goals", "Daily calorie and macro targets."],
    ],
    [
      ["log_meal", "Log a meal or snack with its foods and portions.", ["meal_type", "foods", "eaten_at"]],
      ["delete_meal", "Delete one logged meal.", ["id"]],
      ["update_goals", "Change the daily calorie and macro targets.", ["calories", "protein"]],
    ],
  ),
);

const flights = remote(
  "flights",
  "Flight Search",
  "Fares, dates and airports.",
  tools([
    [
      "search_flights",
      "Search one-way or round-trip flights between airports on given dates, cheapest first.",
      ["origin", "destination", "depart_date", "return_date"],
    ],
    ["search_dates", "Find the cheapest days to fly a route within a month.", ["origin", "destination", "month"]],
    ["find_airports", "Find airports by city or name and return their IATA codes.", ["query"]],
    [
      "get_flight_status",
      "Departure, arrival and delay status of one flight number on a date.",
      ["flight_number", "date"],
    ],
  ]),
);

const social = remote(
  "social",
  "Microblog",
  "Short public posts, timelines and followers.",
  tools(
    [
      ["search_posts", "Search public posts by keyword, author or hashtag.", ["query", "since"]],
      ["home_timeline", "Posts from accounts you follow, newest first.", ["count"]],
      ["user_timeline", "Recent posts by one account.", ["handle"]],
      ["followers", "Accounts that follow a user.", ["handle"]],
      ["following", "Accounts a user follows.", ["handle"]],
      ["bookmarks", "Posts you have bookmarked."],
      ["mentions", "Posts that mention you."],
      ["get_post", "One post with its replies and engagement counts.", ["id"]],
    ],
    [
      ["post_update", "Publish a new post, optionally replying to or quoting another.", ["text", "reply_to"]],
      ["like_post", "Like one post.", ["id"]],
      ["delete_post", "Delete one of your posts.", ["id"]],
    ],
  ),
);

const PROJECT_RECORDS: readonly (readonly [singular: string, plural: string, label: string, parent: string])[] = [
  ["todo", "todos", "to-do", "to-do list"],
  ["todolist", "todolists", "to-do list", "project"],
  ["todolist_group", "todolist_groups", "to-do list group", "to-do list"],
  ["message", "messages", "message", "message board"],
  ["comment", "comments", "comment", "record"],
  ["lounge", "lounges", "lounge (the project's group chat room)", "project"],
  ["lounge_line", "lounge_lines", "lounge chat line", "lounge"],
  ["schedule_entry", "schedule_entries", "schedule entry", "schedule"],
  ["document", "documents", "document", "folder"],
  ["upload", "uploads", "uploaded file", "folder"],
  ["vault", "vaults", "folder", "project"],
  ["card", "cards", "card", "card table column"],
  ["card_column", "card_columns", "card table column", "card table"],
  ["card_step", "card_steps", "card step", "card"],
  ["question", "questions", "automatic check-in question", "questionnaire"],
  ["question_answer", "question_answers", "check-in answer", "question"],
  ["forward", "forwards", "forwarded email", "inbox"],
  ["inbox_reply", "inbox_replies", "reply to a forwarded email", "forward"],
  ["client_approval", "client_approvals", "client approval request", "project"],
  ["client_correspondence", "client_correspondences", "client correspondence", "project"],
  ["client_reply", "client_replies", "client reply", "client correspondence"],
  ["webhook", "webhooks", "webhook", "project"],
  ["template", "templates", "project template", "account"],
  ["boost", "boosts", "boost (a short reaction)", "record"],
  ["timesheet_entry", "timesheet_entries", "timesheet entry", "record"],
  ["lineup_marker", "lineup_markers", "lineup marker", "account"],
  ["chatbot", "chatbots", "lounge chatbot", "lounge"],
  ["message_type", "message_types", "message category", "project"],
  ["question_reminder", "question_reminders", "check-in reminder", "question"],
  ["hill_chart", "hill_charts", "hill chart", "to-do set"],
  ["document_version", "document_versions", "document version", "document"],
  ["schedule_reminder", "schedule_reminders", "schedule reminder", "schedule entry"],
  ["client_visibility", "client_visibilities", "client visibility setting", "record"],
  ["dock_tool", "dock_tools", "dock tool", "project"],
];

const projectHub = (): Connector => {
  const reads: Spec[] = [];
  const writes: Spec[] = [];
  for (const [singular, plural, label, parent] of PROJECT_RECORDS) {
    reads.push([`list_${plural}`, `List every ${label} in a ${parent}, newest first.`, ["project_id", "page"]]);
    reads.push([`get_${singular}`, `Get one ${label} by id.`, ["project_id", `${singular}_id`]]);
    writes.push([`create_${singular}`, `Create a ${label} in a ${parent}.`, ["project_id", "content"]]);
    writes.push([`update_${singular}`, `Update one ${label}.`, ["project_id", `${singular}_id`]]);
    writes.push([`trash_${singular}`, `Move one ${label} to the trash.`, ["project_id", `${singular}_id`]]);
    writes.push([`archive_${singular}`, `Archive one ${label}.`, ["project_id", `${singular}_id`]]);
    writes.push([`unarchive_${singular}`, `Restore one archived ${label}.`, ["project_id", `${singular}_id`]]);
    if (["todo", "message", "document", "upload", "card"].includes(singular)) {
      writes.push([
        `move_${singular}`,
        `Move one ${label} to another ${parent}.`,
        ["project_id", `${singular}_id`, "target_id"],
      ]);
      writes.push([
        `copy_${singular}`,
        `Copy one ${label} into another ${parent}.`,
        ["project_id", `${singular}_id`, "target_id"],
      ]);
      writes.push([
        `subscribe_${singular}`,
        `Subscribe yourself to notifications about one ${label}.`,
        ["project_id", `${singular}_id`],
      ]);
      writes.push([
        `unsubscribe_${singular}`,
        `Stop notifications about one ${label}.`,
        ["project_id", `${singular}_id`],
      ]);
    }
  }
  reads.push(
    ["list_projects", "List active projects with their name, description and dock tools.", ["status"]],
    ["list_recent_projects", "List the projects you visited most recently."],
    [
      "get_project",
      "Get one project with its dock: message board, to-dos, schedule, folders and lounge.",
      ["project_id"],
    ],
    ["get_message_board", "Get a project's message board.", ["project_id"]],
    ["get_schedule", "Get a project's schedule and its settings.", ["project_id"]],
    ["get_upcoming_schedule", "Upcoming schedule entries and due to-dos across every project.", ["window_days"]],
    ["get_card_table", "Get a project's card table with its columns.", ["project_id"]],
    ["get_questionnaire", "Get a project's automatic check-ins.", ["project_id"]],
    ["get_inbox", "Get a project's email forwarding inbox.", ["project_id"]],
    ["list_project_people", "List the people on one project with their roles.", ["project_id"]],
    ["list_people", "List everyone in the account.", ["page"]],
    ["get_person", "Get one person's profile.", ["person_id"]],
    ["get_my_profile", "Get the signed-in person's profile."],
    ["get_my_assignments", "Your open assignments across every project, grouped by project."],
    ["get_my_due_assignments", "Your assignments due soon or overdue."],
    ["get_assigned_todos", "To-dos assigned to one person across projects.", ["person_id"]],
    ["get_overdue_todos", "Every to-do past its due date across projects."],
    ["get_my_day", "Your day: assignments due today, today's schedule entries and items you bookmarked."],
    ["list_everything_todos", "Every to-do in the account across projects, filtered by status.", ["status"]],
    ["list_everything_feed", "The account-wide activity feed of new records and changes.", ["since"]],
    ["list_feed_events", "Events for one record: created, edited, completed, moved.", ["recording_id"]],
    ["get_project_timeline", "A project's timeline of activity, newest first.", ["project_id"]],
    ["get_progress_report", "The account's progress report: what changed in every project since a date.", ["since"]],
    ["get_timesheet_report", "Hours logged by everyone across projects in a date range.", ["start_date", "end_date"]],
    ["get_project_timesheet", "Hours logged on one project.", ["project_id"]],
    ["search", "Search every project for records whose text matches a query.", ["q", "type"]],
    ["list_recordings", "List records of one type across projects.", ["type", "status"]],
    ["list_bookmarks", "Items you bookmarked."],
    ["list_notifications", "Your unread notifications."],
    ["get_subscription", "Who is notified about one record.", ["recording_id"]],
    ["list_attachments", "Files attached to one record.", ["recording_id"]],
    ["list_todo_completions", "Who completed which to-dos, and when.", ["todolist_id"]],
  );
  writes.push(
    ["complete_todo", "Mark one to-do complete.", ["project_id", "todo_id"]],
    ["uncomplete_todo", "Mark one completed to-do incomplete again.", ["project_id", "todo_id"]],
    ["reposition_todo", "Change a to-do's position in its list.", ["project_id", "todo_id", "position"]],
    ["create_project", "Create a project, optionally from a template.", ["name", "template_id"]],
    ["update_project", "Rename a project or change its description.", ["project_id"]],
    ["trash_project", "Move a project to the trash.", ["project_id"]],
    ["grant_project_access", "Give people access to a project.", ["project_id", "person_ids"]],
    ["revoke_project_access", "Remove people from a project.", ["project_id", "person_ids"]],
    ["create_attachment", "Upload a file so it can be attached to a record.", ["filename", "content"]],
    ["bookmark_recording", "Bookmark one record.", ["recording_id"]],
    ["log_time", "Log hours against a record.", ["recording_id", "hours", "date"]],
  );
  return remote(
    "projects",
    "Project Hub",
    "Projects, to-dos, messages, schedules, docs and files for the studio and its clients.",
    tools(reads, writes),
  );
};

const handbook = remote(
  "handbook",
  "Studio Handbook",
  "Internal documents: pricing, services, processes and policies.",
  tools([
    ["search_docs", "Full-text search across the studio's internal documents.", ["query"]],
    ["get_doc", "Read one internal document by path.", ["path"]],
    ["list_docs", "List internal documents with their titles and folders.", ["folder"]],
  ]),
);

const SUBSCRIPTION_READS: readonly Spec[] = [
  [
    "list-customers",
    "List customers of a project, with their first-seen date and last activity.",
    ["project_id", "search", "limit"],
  ],
  [
    "get-customer",
    "Get one customer by app user id with their active entitlements, subscriptions and purchases.",
    ["project_id", "customer_id"],
  ],
  [
    "list-subscriptions",
    "List one customer's subscriptions with product, store, status and renewal date.",
    ["project_id", "customer_id"],
  ],
  ["get-subscription", "Get one subscription by id.", ["project_id", "subscription_id"]],
  ["list-purchases", "List one customer's one-time purchases.", ["project_id", "customer_id"]],
  ["list-entitlements", "List the project's entitlements and the products that unlock them.", ["project_id"]],
  ["get-entitlement", "Get one entitlement.", ["project_id", "entitlement_id"]],
  ["list-offerings", "List offerings: the sets of packages shown to customers.", ["project_id"]],
  ["get-offering", "Get one offering with its packages.", ["project_id", "offering_id"]],
  ["list-packages", "List the packages in one offering.", ["project_id", "offering_id"]],
  ["list-products", "List store products configured for the project.", ["project_id"]],
  ["list-paywalls", "List paywall screens and the offerings they present.", ["project_id"]],
  ["get-paywall", "Get one paywall's configuration.", ["project_id", "paywall_id"]],
  ["list-experiments", "List price and paywall experiments with their status.", ["project_id"]],
  ["get-experiment", "Get one experiment's variants and results.", ["project_id", "experiment_id"]],
  [
    "get-overview-metrics",
    "Overview metrics: active subscriptions, active trials, MRR, revenue, new customers and churn.",
    ["project_id"],
  ],
  [
    "get-revenue-metric",
    "Revenue for a period, gross and net of store fees.",
    ["project_id", "start_date", "end_date"],
  ],
  [
    "get-chart-data",
    "Time series for one chart (MRR, revenue, conversions, churn, actives) with resolution and filters.",
    ["project_id", "chart", "resolution"],
  ],
  [
    "get-benchmarks",
    "Compare the project's conversion and retention with app store benchmarks for its category.",
    ["project_id"],
  ],
  ["list-apps", "List the apps in a project and their stores.", ["project_id"]],
  ["get-app", "Get one app's store configuration.", ["project_id", "app_id"]],
  ["list-invoices", "List one customer's web billing invoices.", ["project_id", "customer_id"]],
  ["list-webhooks", "List webhook integrations.", ["project_id"]],
  ["list-audit-logs", "List configuration changes made by collaborators.", ["project_id"]],
  ["list-customer-attributes", "List one customer's attributes.", ["project_id", "customer_id"]],
  ["list-virtual-currencies", "List virtual currencies and balances.", ["project_id"]],
];

const SUBSCRIPTION_WRITES: readonly Spec[] = [
  ["create-entitlement", "Create an entitlement.", ["project_id", "lookup_key"]],
  ["update-entitlement", "Rename an entitlement.", ["project_id", "entitlement_id"]],
  ["delete-entitlement", "Delete an entitlement.", ["project_id", "entitlement_id"]],
  [
    "grant-entitlement",
    "Grant one customer an entitlement until a date, without a purchase.",
    ["project_id", "customer_id", "entitlement_id"],
  ],
  [
    "revoke-entitlement",
    "Revoke an entitlement granted without a purchase.",
    ["project_id", "customer_id", "entitlement_id"],
  ],
  ["create-offering", "Create an offering.", ["project_id", "lookup_key"]],
  ["update-offering", "Change an offering's name or make it current.", ["project_id", "offering_id"]],
  ["create-package", "Add a package to an offering.", ["project_id", "offering_id"]],
  ["attach-products", "Attach store products to a package or entitlement.", ["project_id", "product_ids"]],
  ["create-paywall", "Create a paywall for an offering.", ["project_id", "offering_id"]],
  ["delete-customer", "Delete one customer and their purchase history.", ["project_id", "customer_id"]],
  ["refund-transaction", "Refund one web billing transaction.", ["project_id", "transaction_id"]],
  ["create-webhook", "Create a webhook integration.", ["project_id", "url"]],
  ["set-customer-attributes", "Set attributes on one customer.", ["project_id", "customer_id", "attributes"]],
];

const subscriptions = (id: string, title: string, full: boolean) =>
  remote(
    id,
    title,
    "In-app subscription customers, entitlements, offerings, paywalls and revenue charts.",
    tools(
      full ? SUBSCRIPTION_READS : SUBSCRIPTION_READS.slice(0, 20),
      full ? SUBSCRIPTION_WRITES : SUBSCRIPTION_WRITES.slice(0, 6),
    ),
  );

const analytics = remote(
  "analytics",
  "Product Analytics",
  "Event analytics: queries, reports, funnels, cohorts, experiments and feature flags.",
  tools(
    [
      [
        "Run-Query",
        "Run an insights, funnel, retention or flows query over tracked events and return the result table.",
        ["project_id", "query_type", "events", "from_date", "to_date"],
      ],
      ["Get-Report", "Get the results of one saved report.", ["project_id", "report_id"]],
      ["List-Saved-Reports", "List saved reports with their type and owner.", ["project_id"]],
      ["Get-Events", "List the event names tracked in a project, with their volume.", ["project_id"]],
      ["Get-Live-Events", "Stream the most recent raw events as they arrive.", ["project_id", "limit"]],
      ["Get-Event-Properties", "List the properties sent with one event.", ["project_id", "event"]],
      ["Get-Property-Values", "List the top values of one property.", ["project_id", "property"]],
      ["List-Experiments", "List experiments with their status and exposure counts.", ["project_id"]],
      ["Get-Experiment", "Get one experiment's variants and metric results.", ["project_id", "experiment_id"]],
      ["List-Feature-Flags", "List feature flags with their rollout rules.", ["project_id"]],
      ["Get-Feature-Flag", "Get one feature flag.", ["project_id", "flag_id"]],
      ["List-Cohorts", "List saved cohorts with their size.", ["project_id"]],
      ["Get-Cohort", "Get one cohort's definition.", ["project_id", "cohort_id"]],
      ["List-Dashboards", "List dashboards.", ["project_id"]],
      ["Get-Dashboard", "Get one dashboard and its reports.", ["project_id", "dashboard_id"]],
      ["Get-User-Profile", "Get one user's profile properties and recent activity.", ["project_id", "distinct_id"]],
      ["Search-User-Profiles", "Search user profiles by property filters.", ["project_id", "where"]],
      ["List-Annotations", "List chart annotations.", ["project_id"]],
      ["Get-Lexicon-Schemas", "Get the data dictionary of documented events and properties.", ["project_id"]],
      ["List-Projects", "List the analytics projects you can access."],
    ],
    [
      ["Update-Feature-Flag", "Change a feature flag's rollout or turn it off.", ["project_id", "flag_id"]],
      ["Create-Cohort", "Save a cohort from property filters.", ["project_id", "definition"]],
      ["Create-Dashboard", "Create a dashboard.", ["project_id", "title"]],
      ["Create-Annotation", "Add an annotation to charts on a date.", ["project_id", "date", "description"]],
    ],
  ),
);

const TRACKER_READS: readonly Spec[] = [
  [
    "list_issues",
    "List issues filtered by team, assignee, state, label or project.",
    ["team", "assignee", "state", "label", "project"],
  ],
  ["get_issue", "Get one issue with its description, state, assignee and attachments.", ["id"]],
  ["list_comments", "List comments on one issue.", ["issueId"]],
  ["list_projects", "List projects with their lead, status and target date.", ["team", "state"]],
  ["get_project", "Get one project with its milestones.", ["id"]],
  ["list_teams", "List teams."],
  ["get_team", "Get one team.", ["id"]],
  ["list_users", "List workspace members."],
  ["get_user", "Get one member.", ["id"]],
  ["list_cycles", "List a team's cycles.", ["teamId"]],
  ["list_issue_statuses", "List a team's workflow states.", ["teamId"]],
  ["list_issue_labels", "List issue labels.", ["teamId"]],
  ["list_documents", "List documents.", ["projectId"]],
  ["get_document", "Get one document.", ["id"]],
  ["list_release_notes", "List published release notes.", ["projectId"]],
  ["get_release_note", "Get one release note.", ["id"]],
  ["list_milestones", "List a project's milestones.", ["projectId"]],
  ["search_documentation", "Search the tracker's own help documentation.", ["query"]],
];

const TRACKER_WRITES: readonly Spec[] = [
  [
    "save_issue",
    "Create an issue, or update one when an id is given.",
    ["id", "title", "team", "description", "state", "assignee"],
  ],
  ["create_comment", "Comment on one issue.", ["issueId", "body"]],
  ["save_project", "Create a project, or update one when an id is given.", ["id", "name", "team"]],
  ["create_issue_label", "Create an issue label.", ["name", "teamId"]],
  ["create_document", "Create a document.", ["title", "content"]],
];

const tracker = (id: string, title: string) =>
  remote(
    id,
    title,
    "Issues, projects, cycles and release notes for product engineering.",
    tools(TRACKER_READS, TRACKER_WRITES),
  );

const warehouse = (id: string, title: string) =>
  remote(
    id,
    title,
    "Analytics data warehouse: datasets, tables and SQL.",
    tools(
      [
        ["list_dataset_ids", "List dataset ids in the warehouse project.", ["project"]],
        ["get_dataset_info", "Get one dataset's metadata.", ["dataset_id"]],
        ["list_table_ids", "List table ids in one dataset.", ["dataset_id"]],
        ["get_table_info", "Get one table's schema, row count and partitioning.", ["dataset_id", "table_id"]],
        ["execute_sql_readonly", "Run a read-only SQL query and return rows.", ["sql"]],
      ],
      [["execute_sql", "Run any SQL statement, including DML and DDL.", ["sql"]]],
    ),
  );

const appDatabase = (id: string, title: string) =>
  remote(
    id,
    title,
    "Hosted Postgres app backend: tables, migrations, logs and edge functions.",
    tools(
      [
        ["list_tables", "List tables in the given schemas.", ["schemas"]],
        ["list_extensions", "List installed Postgres extensions."],
        ["list_migrations", "List applied migrations."],
        [
          "query_logs",
          "Query service logs (api, postgres, auth, storage, edge functions) for the last minute to day.",
          ["service"],
        ],
        ["get_advisors", "Security and performance advisor notices."],
        ["get_project_url", "Get the project's API URL."],
        ["list_edge_functions", "List deployed edge functions."],
        ["list_branches", "List development branches."],
        ["generate_typescript_types", "Generate TypeScript types from the schema."],
        ["search_docs", "Search the platform's documentation.", ["query"]],
      ],
      [
        ["execute_sql", "Run raw SQL against the database.", ["query"]],
        ["apply_migration", "Apply a DDL migration.", ["name", "query"]],
        ["deploy_edge_function", "Deploy an edge function.", ["name", "files"]],
        ["create_branch", "Create a development branch.", ["name"]],
      ],
    ),
  );

const sqlDatabase = remote(
  "sqldb",
  "Reporting Database",
  "Read replica of the production database for reporting.",
  tools([
    ["execute_sql_readonly", "Run a read-only SQL query against the reporting replica.", ["sql"]],
    ["list_tables", "List tables and views.", ["schema"]],
    ["describe_table", "Describe one table's columns.", ["table"]],
  ]),
);

const release = remote(
  "release",
  "Release Board",
  "What is shipped, rolling out and being tested in the mobile app.",
  tools([
    ["whats_live", "What is live in the app right now: shipped features, running experiments and staged rollouts."],
    ["get_experiment", "Get one running experiment's arms, audience and start date.", ["key"]],
    ["list_releases", "List app releases with version, platform and rollout percentage."],
    ["get_release", "Get one release's notes and rollout history.", ["version"]],
  ]),
);

const promos = remote(
  "promos",
  "Promo Codes",
  "Discount codes for app subscriptions.",
  tools(
    [
      ["list_promo_codes", "List promo codes with their discount, uses and expiry.", ["status"]],
      ["get_promo_code", "Get one promo code's redemptions.", ["code"]],
    ],
    [
      ["create_promo_codes", "Create one or more promo codes for an offer.", ["offer", "count", "expires_at"]],
      ["deactivate_promo_code", "Stop one promo code from being redeemed.", ["code"]],
    ],
  ),
);

const assets = remote(
  "assets",
  "Brand Assets",
  "Logos, screenshots, illustrations and videos.",
  tools(
    [
      ["asset_find", "Find images, videos and design files by description, tag or color.", ["query"]],
      ["asset_list", "List assets in a collection.", ["collection"]],
      ["asset_get", "Get one asset with its download links and usage rights.", ["id"]],
    ],
    [["asset_upload", "Upload an asset into a collection.", ["collection", "file"]]],
  ),
);

const pages = remote(
  "pages",
  "Shared Pages",
  "HTML artifact pages published for the team.",
  tools(
    [
      ["list_artifacts", "List published artifact pages with their titles and owners."],
      ["get_artifact", "Get one artifact page's HTML and metadata.", ["id"]],
    ],
    [
      ["create_artifact", "Publish a new HTML artifact page and return its link.", ["title", "html"]],
      ["update_artifact", "Replace an artifact page's HTML.", ["id", "html"]],
      ["delete_artifact", "Unpublish an artifact page.", ["id"]],
    ],
  ),
);

const mailbox = remote(
  "mailbox",
  "Agent Inbox",
  "Email inboxes that agents send from and receive at.",
  tools(
    [
      ["list_inboxes", "List the agent inboxes and their addresses."],
      ["list_messages", "List messages received by one inbox, newest first.", ["inbox_id"]],
      ["get_message", "Get one message with its body and attachments.", ["inbox_id", "message_id"]],
      ["search_messages", "Search one inbox's messages by sender, subject or text.", ["inbox_id", "query"]],
      ["list_threads", "List conversation threads in one inbox.", ["inbox_id"]],
      ["get_thread", "Get one thread with every message.", ["inbox_id", "thread_id"]],
    ],
    [
      ["send_message", "Send a new email from an inbox.", ["inbox_id", "to", "subject", "text"]],
      ["reply_to_message", "Reply to one received message.", ["inbox_id", "message_id", "text"]],
    ],
  ),
);

const lifecycle = remote(
  "lifecycle",
  "Lifecycle Messaging",
  "Automated email and push campaigns to app users.",
  tools(
    [
      [
        "lifecycle_schema",
        "Look up the messaging API's endpoints, parameters and response fields before calling it.",
        ["path"],
      ],
      [
        "lifecycle_read_api",
        "Call a read endpoint of the messaging API: campaigns, broadcasts, newsletters, segments, people, deliveries and metrics.",
        ["path", "query"],
      ],
    ],
    [["lifecycle_write_api", "Call a write endpoint of the messaging API.", ["method", "path", "body"]]],
  ),
);

const RUNBOOK_POLICY =
  "Before running it, confirm the change window with the on-call lead, record the ticket number, snapshot the affected resources, notify every dependent team, check the rollback plan, and verify the monitoring dashboards. ";

const runbook = remote(
  "runbook",
  "Operations Runbook",
  "Operational procedures with long preconditions.",
  tools(
    [["list_procedures", "List runbook procedures."]],
    Array.from({ length: 12 }, (_, index): Spec => [
      `run_procedure_${String(index + 1).padStart(2, "0")}`,
      `Run maintenance procedure ${index + 1}. ${RUNBOOK_POLICY.repeat(24)}`,
      ["ticket"],
    ]),
  ),
);

const GOOGLE = [gmail, drive, docs, sheets, slides, forms, calendar, meet] as const;
const GOOGLE_IDS = ["gmail", "drive", "docs", "sheets", "slides", "forms", "calendar", "meet"] as const;

export const DEPLOYMENTS: Readonly<Record<Deployment, () => Connector[]>> = {
  personal: () => [
    ...GOOGLE.flatMap((provider, index) => accounts(provider, GOOGLE_IDS[index]!, ["alice", "bob"])),
    ...accounts(people, "contacts", ["alice", "bob"]),
    finance,
    fitness,
    meals,
    flights,
    social,
  ],
  studio: () => [
    projectHub(),
    handbook,
    gmail.create("gmail"),
    drive.create("drive"),
    docs.create("docs"),
    sheets.create("sheets"),
    calendar.create("calendar"),
    vercel.create("vercel"),
    cloudflare.create("cloudflare"),
  ],
  product: () => [
    subscriptions("subscriptions", "App Subscriptions", true),
    subscriptions("subscriptions_android", "App Subscriptions (Android)", false),
    subscriptions("subscriptions_reader", "Reader Subscriptions", true),
    subscriptions("subscriptions_reader_android", "Reader Subscriptions (Android)", true),
    analytics,
    tracker("tracker", "Issue Tracker"),
    tracker("tracker_mobile", "Issue Tracker (Mobile)"),
    warehouse("warehouse", "Data Warehouse"),
    warehouse("warehouse_bob", "Data Warehouse (Bob)"),
    appDatabase("appdb", "App Database"),
    appDatabase("appdb_reader_android", "App Database (Reader Android)"),
    sqlDatabase,
    release,
    promos,
    assets,
    pages,
    mailbox,
    lifecycle,
    ...accounts(stripe, "stripe", ["reader", "journal"]),
    github.create("github"),
    granola.create("granola"),
    intercom.create("intercom"),
    cloudflare.create("cloudflare"),
    vercel.create("vercel"),
  ],
};

export const pagingDeployment = (): Connector[] => [projectHub(), runbook];
