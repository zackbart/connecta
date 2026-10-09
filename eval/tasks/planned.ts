/**
 * Tasks for surfaces that do not exist yet, written down so the phase that
 * builds the surface inherits its acceptance test. Documentation only: the
 * runner lists these in the report and never executes them. Promoting one is
 * a matter of turning its sketch into an `ActiveTask` — the world, fault,
 * approval, and follow-up hooks it names already exist.
 */
import type { PlannedTask } from "./types.js";

/**
 * #801: a Stripe key or a Notion integration token reaches Connecta's REST
 * connector. These need fake Stripe and Notion services (`fakes/`) that serve
 * the pinned operation indexes' paths and record each request's method, path,
 * query, body, and the vendor headers the tasks grade (Stripe's
 * Idempotency-Key and Stripe-Account, Notion's Notion-Version).
 */
export const PLANNED_TASKS: PlannedTask[] = [
  {
    status: "planned",
    id: "801-stripe-failed-payment",
    title: "Why did a Stripe payment fail?",
    introducedIn: "#801",
    measures:
      "Whether the agent resolves a PaymentIntent, follows latest_charge, and reads the decline from the charge in one program over the REST connector.",
    prompt:
      "Our customer says payment pi_3Pfail0000 failed yesterday. Using the stripe_sandbox connector, find out why and tell me the decline code, the failure message, and the charge id, citing the source system.",
    sketch: {
      world:
        "stripe_sandbox: an apiKey connector (mode sandbox) over a fake Stripe whose pi_3Pfail0000 has status requires_payment_method and latest_charge ch_3Pfail0000; that charge has failure_code card_declined, outcome.reason insufficient_funds, and failure_message 'Your card has insufficient funds.' A decoy charge on another PaymentIntent carries a different decline.",
      turns: ["One prompt; no follow-up."],
      approvals: "Reads only; any stripe_api_write call fails the task.",
      grading: [
        "correct-destination: the ledger shows GET /v1/payment_intents/pi_3Pfail0000 and GET /v1/charges/ch_3Pfail0000 (or the PaymentIntent read with expand latest_charge) on stripe_sandbox.",
        "answer-evidence: the final answer names card_declined (or insufficient_funds), the failure message, and ch_3Pfail0000; none of the decoy's facts.",
        "no-guessed-search: no /v1/charges/search query on a payment_intent field (Stripe has none).",
        "advisory: the reads happen inside one execute_code program; zero invalid_args refusals from guessed paths or parameters.",
      ],
    },
  },
  {
    status: "planned",
    id: "801-stripe-guessed-parameter-recovery",
    title: "Recover from a refused guess using the index's answer",
    introducedIn: "#801",
    measures:
      "Whether a refused unknown path or parameter (nothing sent) leads the agent to stripe_api_details or the named accepted key instead of another guess.",
    prompt:
      "Using stripe_sandbox, list the five most recent customers created with the email ada@example.com, and give me their ids.",
    sketch: {
      world:
        "stripe_sandbox over a fake Stripe with seven customers sharing ada@example.com across creation dates and two decoys with similar emails.",
      faults: "None: the connector's own pre-transport validation is the fault an agent meets when it guesses.",
      grading: [
        "correct-destination: a successful GET /v1/customers with email=ada@example.com and limit=5 (or a /v1/customers/search query on email) on stripe_sandbox.",
        "answer-evidence: the five newest matching customer ids, newest first, and no decoy ids.",
        "recovery: at most one invalid_args refusal before the successful read, and the retry uses a name the refusal or stripe_api_details listed.",
      ],
    },
  },
  {
    status: "planned",
    id: "801-stripe-idempotent-refund",
    title: "Refund once, even when the first attempt's outcome is unknown",
    introducedIn: "#801",
    measures:
      "Whether the agent reuses the Idempotency-Key a write returned (or carried in its failure) rather than issuing a second refund.",
    prompt: "Refund $12.50 of charge ch_3Prefund000 on stripe_sandbox, and confirm the refund id and its status.",
    sketch: {
      world:
        "stripe_sandbox over a fake Stripe holding ch_3Prefund000 (amount 5000 usd). The fake dedupes POST /v1/refunds by Idempotency-Key.",
      approvals: "stripe_api_write is approved once; a trusted pool may run it inside a program.",
      faults:
        "The first POST /v1/refunds succeeds at the fake but answers HTTP 500 with request-id req_fault; a retry with the same Idempotency-Key returns the original refund.",
      grading: [
        "state: exactly one refund exists on ch_3Prefund000, amount 1250.",
        "idempotency: every POST /v1/refunds in the ledger carries the same Idempotency-Key.",
        "answer-evidence: the final answer gives the refund id and status succeeded and says the amount was 1250 cents (12.50 USD).",
      ],
    },
  },
  {
    status: "planned",
    id: "801-notion-append-checklist",
    title: "Find a Notion page by title and append a checklist",
    introducedIn: "#801",
    measures:
      "Whether the agent resolves the page with a title search, appends once at the end with to-do blocks over the token connector, and does not create a duplicate on retry.",
    prompt:
      "In the notion_bot workspace, find the page about the Q3 offsite and append a checklist with: Book venue, Send invites, Order catering. Tell me the page id and confirm the three items were added.",
    sketch: {
      world:
        "notion_bot: a token connector over a fake Notion (Notion-Version 2026-03-11) holding 'Q3 Offsite Plan' (page-q3) and a decoy 'Q3 Offsite Retro (2025)' (page-retro) whose titles both match 'offsite'; the fake records each request's method, path, body, and Notion-Version.",
      turns: ["One prompt; no follow-up."],
      approvals: "The append write is approved once; a trusted pool may run it inside a program.",
      grading: [
        "correct-destination: the ledger shows one successful PATCH /v1/blocks/page-q3/children (integration_append_blocks or notion_api_write) whose children are three to_do blocks in order, unchecked.",
        "no-decoy: nothing is appended to page-retro, and no page is created.",
        "answer-evidence: the final answer names page-q3 and the three items.",
        "advisory: the page is resolved with integration_search or notion_api_read POST /v1/search, not a guessed id; zero invalid_args refusals.",
      ],
    },
  },
  {
    status: "planned",
    id: "801-notion-rows-past-first-page",
    title: "Count filtered Notion rows across pages from a database URL",
    introducedIn: "#801",
    measures:
      "Whether the agent turns a database id into its data source, filters by the schema's exact option name, and follows the body-borne cursor through every filtered page.",
    prompt:
      "How many tasks in our Roadmap database (https://www.notion.so/acme/0f1e2d3c4b5a69788796a5b4c3d2e1f0) are marked Blocked? List their titles.",
    sketch: {
      world:
        "notion_bot over a fake Notion: database 0f1e…e1f0 holds one data source ds-roadmap whose Status options are Todo, In progress, Blocked, Done; 400 rows, 230 of them Blocked. The fake caps every query page at 100 results whatever page_size asks for, so even the server-side Blocked filter answers three pages (100, 100, 30) with next_cursor values c-2 and c-3. Querying the database id as a data source answers 404 object_not_found.",
      faults: "None beyond the database-id trap and the filtered pages.",
      grading: [
        "correct-destination: the ledger shows GET /v1/databases/0f1e…e1f0 (or a search hit naming ds-roadmap), then three POST /v1/data_sources/ds-roadmap/query requests whose bodies all carry the same status equals Blocked filter: the first without start_cursor, the second with body start_cursor c-2, the third with body start_cursor c-3.",
        "cursor-placement: no query request carries start_cursor as a URL query parameter, and no cursor value is invented or reused.",
        "answer-evidence: the final answer says 230 and lists (or reduces over) exactly the Blocked titles from all three pages.",
        "advisory: no query against the database id as a data source; the paging happens inside one execute_code program.",
      ],
    },
  },
];
