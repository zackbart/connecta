/**
 * Tasks for surfaces that do not exist yet, written down so the phase that
 * builds the surface inherits its acceptance test. Documentation only: the
 * runner lists these in the report and never executes them. Promoting one is
 * a matter of turning its sketch into an `ActiveTask` — the world, fault,
 * approval, and follow-up hooks it names already exist.
 */
import type { PlannedTask } from "./types.js";

/**
 * #801: a Stripe key reaches Connecta's REST connector. These need a fake
 * Stripe service (`fakes/`) that serves the pinned operation index's paths,
 * answers form-encoded v1 bodies, and records each request's method, path,
 * query, Idempotency-Key, and Stripe-Account.
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
];
