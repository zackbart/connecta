// Synthetic tasks derived from repeated transcript patterns. No private records,
// provider credentials, live services, or expected answers in the agent prompts.
const schema = (properties = {}, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});
const str = { type: "string" };
const integer = { type: "integer" };

export const usabilityCases = [
  {
    id: "text-project-resolution",
    purpose: "Resolve an exact project id from a text-formatted provider result without treating a parser mistake as missing access",
    prompt: 'Does Android production customer app_93 currently have subscription access? Verify the project and customer through the connected service. Return JSON with projectId, customerId, and hasAccess. Do not change anything.',
    score({ answer, downstreamCalls }) {
      return {
        correct: answer?.projectId === "projab730001" && answer?.customerId === "app_93" && answer?.hasAccess === true,
        semantics: downstreamCalls.some(x => x.address === "subscriptions.list-projects") && downstreamCalls.some(x => x.address === "subscriptions.get-customer" && x.args.project_id === "projab730001" && x.args.customer_id === "app_93"),
        private: true,
      };
    },
  },
  {
    id: "purchase-verification",
    purpose: "Resolve production identity across payment and access without confusing payment with entitlement",
    prompt: 'Did the Android production purchase for alex@example.invalid work? Check payment and subscription access. Return JSON with paid, hasAccess, environment, and paymentId. Do not change anything.',
    score({ answer, downstreamCalls }) {
      return {
        correct: answer?.paid === true && answer?.hasAccess === false && answer?.environment === "production" && answer?.paymentId === "pay_73",
        semantics: downstreamCalls.some(x => x.address === "billing_b.find_payment") && downstreamCalls.some(x => x.address === "access_b.get_customer" && x.args.customer_id === "app_93") && !downstreamCalls.some(x => /_a\./.test(x.address)),
        private: true,
      };
    },
  },
  {
    id: "experiment-check",
    purpose: "Resolve a project, load its context, and compare the correct exposure population",
    prompt: 'How is the Android production paid-trial experiment doing for August 1–7, 2026? Compare conversion for each arm using eligible exposed users. Return JSON with projectId, controlRate, treatmentRate, and winner. Do not change anything.',
    score({ answer, downstreamCalls }) {
      const context = downstreamCalls.findIndex(x => x.address === "analytics.Get-Business-Context" && x.args.project_id === 72);
      const query = downstreamCalls.findIndex(x => x.address === "analytics.Run-Query");
      return {
        correct: answer?.projectId === 72 && answer?.controlRate === 0.2 && answer?.treatmentRate === 0.1 && answer?.winner === "control",
        semantics: context >= 0 && query > context && downstreamCalls[query].args.population === "eligible_exposed" && downstreamCalls[query].args.from === "2026-08-01" && downstreamCalls[query].args.to === "2026-08-07",
        private: true,
      };
    },
  },
  {
    id: "capability-limit",
    purpose: "Recognize an unsupported individual timeline without substituting aggregate evidence",
    prompt: 'For Android production customer app_93, did a crash occur after their purchase on August 7, 2026? I need the order of their individual events, not overall counts. Return JSON with verified and reason. Do not change anything.',
    score({ answer, downstreamCalls, toolCalls }) {
      return {
        correct: answer?.verified === false && /timeline|individual|sequence|order/i.test(answer?.reason ?? "") && /unavailable|unsupported|cannot|not (available|supported|expose)|only aggregate/i.test(answer?.reason ?? ""),
        semantics: !downstreamCalls.some(x => x.address.endsWith("Run-Query")) && toolCalls.some(x => x.tool === "skills" && x.arguments?.name === "connector:analytics"),
        private: true,
      };
    },
  },
];

export function usabilityConnectors(caseId, { connector, readTool }) {
  if (caseId === "text-project-resolution") {
    return [connector("subscriptions", {
      title: "Android production subscriptions",
      description: "Subscription access for Android production.",
      usageGuide: {
        summary: "Resolve project_id with list-projects, then use the app user id as customer_id.",
        content: "Resolve project_id with list-projects before a customer lookup. This connection reaches one project. Customer ids are app user ids. gives_access is authoritative for access; subscription status alone is not.",
      },
      tools: [
        readTool("list-projects", "List projects accessible to this connection.", schema(), () => 'object: list\nitems[1]{object,id,name}:\n  project,projab730001,Android Production\nnext_page: null', { type: "string" }),
        readTool("get-customer", "Get subscription access for a customer in a project.", schema({ project_id: str, customer_id: str }), ({ project_id, customer_id }) => {
          if (project_id !== "projab730001") throw new Error("The API key does not belong to project " + project_id);
          if (customer_id !== "app_93") throw new Error("Unknown customer");
          return { customer_id, project_id, gives_access: true, status: "billing_retry" };
        }),
      ],
    })];
  }
  if (caseId === "purchase-verification") {
    return ["a", "b"].flatMap((suffix) => {
      const environment = suffix === "a" ? "sandbox" : "production";
      return [
        connector(`billing_${suffix}`, {
          title: `Android ${environment} payments`,
          description: `Find Android ${environment} payments and the subscription app user id.`,
          tools: [readTool("find_payment", "Find a customer's payment by email.", schema({ email: str }), ({ email }) => ({
            email, payment_id: suffix === "b" ? "pay_73" : "pay_test", paid: true, environment, app_user_id: suffix === "b" ? "app_93" : "app_test",
          }))],
        }),
        connector(`access_${suffix}`, {
          title: `Android ${environment} subscription access`,
          description: `Verify Android ${environment} subscription access.`,
          usageGuide: {
            summary: "Use the payment's app_user_id as customer_id; gives_access determines access.",
            content: "Use the payment's app_user_id as customer_id, never the email or payment id. gives_access determines current access; a subscription status of active is not sufficient.",
          },
          tools: [readTool("get_customer", "Get subscription status and access for an app user.", schema({ customer_id: str }), ({ customer_id }) => {
            if (customer_id !== (suffix === "b" ? "app_93" : "app_test")) throw new Error("Unknown app user id");
            return { customer_id, status: "active", gives_access: suffix === "a", environment };
          })],
        }),
      ];
    });
  }
  const timelineOnly = caseId === "capability-limit";
  if (!timelineOnly && caseId !== "experiment-check") return undefined;
  return [connector("analytics", {
    title: "Android production and sandbox analytics",
    description: "Experiment conversion and aggregate event counts across Android projects.",
    usageGuide: {
      summary: "Resolve project then business context. Aggregate reports only; no individual event timeline.",
      content: "Start with Get-Projects, then Get-Business-Context for that exact project. Its schema leaves ids optional but project_id or organization_id is required. Experiments compare eligible_exposed users, not all app users. Run-Query provides aggregates only. This connector cannot retrieve an individual user's event timeline or establish event order. There is no event export or replay tool in this deployment.",
    },
    tools: [
      readTool("Get-Projects", "List projects and their environments.", schema(), () => ({ projects: [{ id: 71, name: "Android", environment: "sandbox" }, { id: 72, name: "Android", environment: "production" }] })),
      readTool("Get-Business-Context", "Read business context for a project or organization.", schema({ project_id: integer, organization_id: integer }, []), ({ project_id, organization_id }) => {
        if (!project_id && !organization_id) throw new Error("project_id or organization_id is required");
        return { project_id, experiment: "paid_trial", population: "eligible_exposed", conversion: "purchase / eligible exposure", timeZone: "UTC" };
      }),
      readTool("Run-Query", "Query aggregate experiment conversions or aggregate event totals. Cannot return individual event timelines.", schema({ project_id: integer, experiment: str, population: str, from: str, to: str }), ({ project_id, population }) => ({
        project_id,
        arms: population === "eligible_exposed" && project_id === 72
          ? [{ name: "control", exposed: 100, purchases: 20 }, { name: "treatment", exposed: 100, purchases: 10 }]
          : [{ name: "control", exposed: 200, purchases: 20 }, { name: "treatment", exposed: 100, purchases: 30 }],
      })),
    ],
  })];
}
