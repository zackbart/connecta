import { stripe } from "./index.js";
import type { ToolDef } from "../../types.js";
type Options = Parameters<typeof stripe>[1];
// The REST connector is the default: its tools are Connecta's own, so the
// hand-written conventions apply to it. The OAuth case reaches hosted MCP.
const options: Options = { "purpose":"Audit fixture", "auth":{"type":"apiKey"}, "mode":"sandbox" };
export const fixture = {
  name: "stripe",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"production","options":{"mode":"production"}},{"label":"connect","options":{"mode":"production","connectedAccount":"acct_fixture"}},{"label":"oauth","options":{"auth":{"type":"oauth"}}}],
  create(id = "fixture", overrides: Partial<Options> = {}) {
    // OAuth takes no mode, so its case starts from the common options alone.
    const base: Partial<Options> = overrides.auth?.type === "oauth" ? { purpose: options.purpose } : options;
    return stripe(id, { ...base, ...overrides } as Options);
  },
  conventions: {"verbs":["get","stripe"],"nestedDescriptionExceptions":[],"auth":"credential"},
};

// Hosted OAuth schemas and annotations captured with connecta.describe on 2026-10-19.
// No operational tools were called. These are test evidence, never a runtime catalog.
export const hostedTools: ToolDef[] = [
  {
    "name": "stripe_api_search",
    "inputSchema": {
      "type": "object",
      "properties": {
        "intent": {
          "type": "string",
          "description": "The intent of the operation",
          "examples": [
            "create",
            "list",
            "refund"
          ]
        },
        "resource": {
          "type": "string",
          "description": "Target resource the operation is looking to manipulate",
          "examples": [
            "customer",
            "payout methods",
            "issuing card transactions"
          ]
        },
        "limit": {
          "description": "Maximum number of results to return",
          "type": "integer",
          "minimum": 1,
          "maximum": 20,
          "default": 5
        },
        "stripe_context": {
          "type": "string",
          "description": "The account to target for this request. Use the `stripe_context` value returned by list_available_accounts_or_orgs."
        },
        "livemode": {
          "type": "boolean",
          "description": "Whether to operate in livemode (true) or test mode/ sandbox (false). Must match the livemode of the stripe_context account."
        }
      },
      "required": [
        "intent",
        "resource",
        "stripe_context",
        "livemode"
      ]
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "openapi_spec_version": {
          "description": "The OpenAPI Specification Version that the MCP Server used to look for the operation",
          "type": "string"
        },
        "api_key_deprecation_warning": {
          "description": "Present when this session authenticates with an API key that Stripe MCP will stop accepting",
          "type": "string"
        },
        "data": {
          "description": "List of operations matching the criteria",
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "method": {
                "type": "string"
              },
              "path": {
                "type": "string"
              },
              "summary": {
                "type": "string"
              },
              "path_params": {
                "type": "array",
                "items": {
                  "type": "string"
                },
                "description": "Path parameter names to pass inside `parameters`"
              },
              "llm_context": {
                "type": "string",
                "description": "Supplemental LLM guidance for this operation, if provided"
              }
            },
            "required": [
              "id",
              "method",
              "path"
            ]
          }
        }
      },
      "required": [
        "openapi_spec_version",
        "data"
      ]
    },
    "annotations": {
      "title": "Search Stripe API operations",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "stripe_api_details",
    "inputSchema": {
      "type": "object",
      "properties": {
        "stripe_api_operation_id": {
          "description": "The operation ID to get details for (e.g. 'PostCustomers', 'GetPaymentIntents')",
          "type": "string"
        },
        "stripe_context": {
          "type": "string",
          "description": "The account to target for this request. Use the `stripe_context` value returned by list_available_accounts_or_orgs."
        },
        "livemode": {
          "type": "boolean",
          "description": "Whether to operate in livemode (true) or test mode/ sandbox (false). Must match the livemode of the stripe_context account."
        }
      },
      "required": [
        "stripe_api_operation_id",
        "stripe_context",
        "livemode"
      ]
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "openapi_spec_version": {
          "description": "The OpenAPI Specification Version that the MCP Server used to look for the operation",
          "type": "string"
        },
        "llm_context": {
          "description": "Supplemental usage guidance for this operation, if available",
          "type": "string"
        }
      },
      "required": [
        "openapi_spec_version"
      ]
    },
    "annotations": {
      "title": "Get Stripe API operation details",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "stripe_api_read",
    "inputSchema": {
      "type": "object",
      "properties": {
        "stripe_api_operation_id": {
          "description": "The operation ID to execute",
          "type": "string",
          "examples": [
            "PostCustomers",
            "GetPaymentIntents"
          ]
        },
        "parameters": {
          "description": "All path, query, and request-body values for the API call. Include path parameters here, named as in the path's curly braces (e.g. 'id' for /v1/customers/{id}). Array fields (e.g. line_items) must be passed as a JSON array value, not as a plain string.",
          "type": "object"
        },
        "stripe_context": {
          "type": "string",
          "description": "The account to target for this request. Use the `stripe_context` value returned by list_available_accounts_or_orgs."
        },
        "livemode": {
          "type": "boolean",
          "description": "Whether to operate in livemode (true) or test mode/ sandbox (false). Must match the livemode of the stripe_context account."
        }
      },
      "required": [
        "stripe_api_operation_id",
        "stripe_context",
        "livemode"
      ]
    },
    "outputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": true
    },
    "annotations": {
      "title": "Read Stripe API data",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  {
    "name": "stripe_api_write",
    "inputSchema": {
      "type": "object",
      "properties": {
        "stripe_api_operation_id": {
          "description": "The operation ID to execute",
          "type": "string",
          "examples": [
            "PostCustomers",
            "GetPaymentIntents"
          ]
        },
        "parameters": {
          "description": "All path, query, and request-body values for the API call. Include path parameters here, named as in the path's curly braces (e.g. 'id' for /v1/customers/{id}). Array fields (e.g. line_items) must be passed as a JSON array value, not as a plain string.",
          "type": "object"
        },
        "human_confirmation": {
          "type": "object",
          "description": "This tool might require human confirmation. To run it, first invoke it with the desired parameters, ignoring the `approval_token` parameter.\nIf it requires human confirmation, the response will include an approval request ID and a URL to an approval page for the human to approve the tool call.\nYou, as the LLM agent, should:\n\n1. Present this URL to the human as a clickable markdown link. Tell them that they have to approve this tool call at that URL, and that they should tell you when they have approved the operation.\n2. The human will approve that call.\n3. After the human tells you they have approved the operation, you must call the tool again with the `approval_token` parameter and the exact same parameters. The operation will then go through.\n",
          "properties": {
            "approval_token": {
              "type": "string",
              "description": "The ID of the approval token for the request. This is required on only the post-human-confirmation invocation. An example ID is `approval_123`."
            }
          }
        },
        "stripe_context": {
          "type": "string",
          "description": "The account to target for this request. Use the `stripe_context` value returned by list_available_accounts_or_orgs."
        },
        "livemode": {
          "type": "boolean",
          "description": "Whether to operate in livemode (true) or test mode/ sandbox (false). Must match the livemode of the stripe_context account."
        }
      },
      "required": [
        "stripe_api_operation_id",
        "stripe_context",
        "livemode"
      ]
    },
    "outputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": true
    },
    "annotations": {
      "title": "Write Stripe API data",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "get_balance_summary",
    "inputSchema": {
      "type": "object",
      "properties": {
        "stripe_context": {
          "type": "string",
          "description": "The account to target for this request. Use the `stripe_context` value returned by list_available_accounts_or_orgs."
        },
        "livemode": {
          "type": "boolean",
          "description": "Whether to operate in livemode (true) or test mode/ sandbox (false). Must match the livemode of the stripe_context account."
        }
      },
      "required": [
        "stripe_context",
        "livemode"
      ]
    },
    "annotations": {
      "title": "Get balance summary",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "stripe_implementation_planner",
    "inputSchema": {
      "type": "object",
      "properties": {
        "guide_id": {
          "description": "ONLY pass a guide_id that was returned by a previous call to this tool in this conversation. Never fabricate, guess, or reuse guide_ids from other sessions. If you do not have a guide_id from a prior response, omit this field entirely. Invalid guide_ids will be rejected.",
          "type": "string"
        },
        "message": {
          "description": "For new guides: describe the use case or business requirements.",
          "type": "string"
        },
        "accept": {
          "description": "Set to true when returning the completed decision trees with your chosen options. Include selected_leaf_nodes with the IDs of all terminal leaves reached.",
          "type": "boolean"
        },
        "selected_leaf_nodes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "The IDs of all terminal leaves reached while traversing the guide's decision tree."
        },
        "stripe_context": {
          "type": "string",
          "description": "The account to target for this request. Use the `stripe_context` value returned by list_available_accounts_or_orgs."
        },
        "livemode": {
          "type": "boolean",
          "description": "Whether to operate in livemode (true) or test mode/ sandbox (false). Must match the livemode of the stripe_context account."
        }
      },
      "required": [
        "stripe_context",
        "livemode"
      ]
    },
    "annotations": {
      "title": "Stripe implementation planner",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "send_stripe_feedback",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sentiment": {
          "type": "string",
          "enum": [
            "positive",
            "negative",
            "neutral"
          ],
          "description": "positive, negative, or neutral"
        },
        "message": {
          "type": "string",
          "description": "What broke or worked, concrete and specific. At least 5 words.",
          "maxLength": 2000,
          "minLength": 20
        },
        "context": {
          "type": "string",
          "description": "What the user was trying to accomplish. Do not include sensitive business information.",
          "maxLength": 2000,
          "minLength": 20
        },
        "feature_area": {
          "type": "string",
          "description": "Product area this feedback is about.",
          "enum": [
            "payments",
            "connect",
            "subscriptions",
            "billing",
            "payouts",
            "reporting",
            "invoicing",
            "invoices",
            "checkout",
            "tax",
            "radar",
            "issuing",
            "terminal",
            "treasury",
            "capital",
            "docs",
            "webhooks",
            "cli",
            "dashboard",
            "crypto",
            "stablecoins",
            "managed-payments",
            "mcp",
            "identity",
            "skills",
            "apps",
            "other"
          ]
        },
        "actor": {
          "type": "string",
          "description": "Who decided to submit: human or agent. Defaults to agent.",
          "enum": [
            "human",
            "agent"
          ]
        }
      },
      "required": [
        "sentiment",
        "message",
        "context"
      ]
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "message": {
          "type": "string"
        },
        "success": {
          "type": "boolean"
        },
        "_id": {
          "type": "string"
        }
      },
      "required": [
        "message",
        "success",
        "_id"
      ]
    },
    "annotations": {
      "title": "Send Stripe feedback",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "search_stripe_documentation",
    "inputSchema": {
      "type": "object",
      "properties": {
        "question": {
          "type": "string",
          "description": "The user question about integrating with Stripe will be used to search the documentation.",
          "maxLength": 1000
        },
        "language": {
          "type": "string",
          "description": "The programming language to search for in the documentation.",
          "enum": [
            "dotnet",
            "go",
            "java",
            "node",
            "php",
            "ruby",
            "python",
            "curl"
          ]
        },
        "search_only_api_ref": {
          "type": "boolean",
          "description": "When set to true, search only in the Stripe API reference documentation instead of the full documentation set. Use true when users need specific API implementation details, code examples, or parameter references. Use false (default) for conceptual explanations, best practices, integration guides, or troubleshooting help."
        }
      },
      "required": [
        "question"
      ]
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "results": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "title": {
                "type": "string"
              },
              "subtitle": {
                "type": "string"
              },
              "url": {
                "type": "string",
                "format": "uri"
              },
              "type": {
                "type": "string"
              },
              "content": {
                "type": "string"
              }
            },
            "required": [
              "type",
              "content"
            ]
          }
        }
      },
      "required": [
        "results"
      ]
    },
    "annotations": {
      "title": "Search Stripe documentation",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  {
    "name": "stripe_analytics",
    "inputSchema": {
      "type": "object",
      "properties": {
        "intent": {
          "description": "The intent of the tool call.",
          "type": "string",
          "enum": [
            "execute_query_run",
            "retrieve_query_run",
            "search_query_tables",
            "retrieve_query_table",
            "execute_query_template",
            "retrieve_query_template"
          ]
        },
        "params": {
          "type": "object",
          "description": "The parameters for the tool call. Required parameters depend on the intent.",
          "properties": {
            "sql": {
              "description": "Used with execute_query_run. The SQL query to execute (Trino 414).",
              "type": "string"
            },
            "result_options": {
              "description": "Used with execute_query_run. Optional settings for the QueryRun results.",
              "type": "object",
              "properties": {
                "compress_file": {
                  "type": "boolean",
                  "description": "Whether to compress the generated results file."
                }
              }
            },
            "query_run_id": {
              "description": "Used with retrieve_query_run or retrieve_query_template. The QueryRun ID to retrieve.",
              "type": "string",
              "pattern": "^(qryrun|qrun)_[a-zA-Z0-9_]+$"
            },
            "search_string": {
              "description": "Used with search_query_tables. Keyword to search table names and descriptions.",
              "type": "string"
            },
            "table_name": {
              "description": "Used with retrieve_query_table. The table name.",
              "type": "string",
              "pattern": "^[a-zA-Z0-9_]+$"
            },
            "metric": {
              "description": "Used with execute_query_template. The canonical metric name.",
              "type": "string",
              "enum": [
                "gross_volume",
                "subscriber_churn_rate",
                "gross_mrr_churn_rate",
                "churned_subscribers",
                "net_mrr_churn_rate",
                "churned_revenue",
                "new_subscribers",
                "active_subscribers",
                "active_subscriber_growth"
              ]
            },
            "dimensions": {
              "description": "Used with execute_query_template. Dimensions to group by: 'product', 'price'.",
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "product",
                  "price"
                ]
              }
            },
            "grains": {
              "description": "Used with execute_query_template. Time grain: 'day', 'week', or 'month'. Default is 'month'.",
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "day",
                  "week",
                  "month"
                ]
              }
            },
            "metric_filters": {
              "description": "Used with execute_query_template. Filters to apply: 'top5' or 'all'. Default is 'all'.",
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "top5"
                ]
              }
            }
          }
        },
        "stripe_context": {
          "type": "string",
          "description": "The account to target for this request. Use the `stripe_context` value returned by list_available_accounts_or_orgs."
        },
        "livemode": {
          "type": "boolean",
          "description": "Whether to operate in livemode (true) or test mode/ sandbox (false). Must match the livemode of the stripe_context account."
        }
      },
      "required": [
        "intent",
        "stripe_context",
        "livemode"
      ]
    },
    "annotations": {
      "title": "Stripe Analytics",
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": false,
      "openWorldHint": false
    }
  },
  {
    "name": "convert_currency",
    "inputSchema": {
      "type": "object",
      "properties": {
        "financial_account": {
          "description": "Financial Account ID to create the currency conversion on.",
          "type": "string"
        },
        "from": {
          "description": "Source amount or source currency.",
          "type": "object",
          "properties": {
            "amount": {
              "type": "object",
              "properties": {
                "value": {
                  "description": "Amount in the currency's minor unit.",
                  "minimum": 1,
                  "type": "integer"
                },
                "currency": {
                  "description": "Three-letter lowercase currency code.",
                  "type": "string"
                }
              },
              "required": [
                "value",
                "currency"
              ]
            },
            "currency": {
              "description": "Three-letter lowercase source currency code.",
              "type": "string"
            }
          }
        },
        "to": {
          "description": "Destination amount or destination currency.",
          "type": "object",
          "properties": {
            "amount": {
              "type": "object",
              "properties": {
                "value": {
                  "description": "Amount in the currency's minor unit.",
                  "minimum": 1,
                  "type": "integer"
                },
                "currency": {
                  "description": "Three-letter lowercase currency code.",
                  "type": "string"
                }
              },
              "required": [
                "value",
                "currency"
              ]
            },
            "currency": {
              "description": "Three-letter lowercase destination currency code.",
              "type": "string"
            }
          }
        },
        "human_confirmation": {
          "type": "object",
          "description": "This tool might require human confirmation. To run it, first invoke it with the desired parameters, ignoring the `approval_token` parameter.\nIf it requires human confirmation, the response will include an approval request ID and a URL to an approval page for the human to approve the tool call.\nYou, as the LLM agent, should:\n\n1. Present this URL to the human as a clickable markdown link. Tell them that they have to approve this tool call at that URL, and that they should tell you when they have approved the operation.\n2. The human will approve that call.\n3. After the human tells you they have approved the operation, you must call the tool again with the `approval_token` parameter and the exact same parameters. The operation will then go through.\n",
          "properties": {
            "approval_token": {
              "type": "string",
              "description": "The ID of the approval token for the request. This is required on only the post-human-confirmation invocation. An example ID is `approval_123`."
            }
          }
        },
        "stripe_context": {
          "type": "string",
          "description": "The account to target for this request. Use the `stripe_context` value returned by list_available_accounts_or_orgs."
        },
        "livemode": {
          "type": "boolean",
          "description": "Whether to operate in livemode (true) or test mode/ sandbox (false). Must match the livemode of the stripe_context account."
        }
      },
      "required": [
        "financial_account",
        "from",
        "to",
        "stripe_context",
        "livemode"
      ]
    },
    "annotations": {
      "title": "Convert currency",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "send_money",
    "inputSchema": {
      "type": "object",
      "properties": {
        "financial_account_id": {
          "description": "Source v2 Financial Account ID, e.g. fa_....",
          "type": "string"
        },
        "recipient_account_id": {
          "description": "Recipient account ID to send to, e.g. acct_....",
          "type": "string"
        },
        "payout_method_id": {
          "description": "Optional payout method ID belonging to the RECIPIENT (recipient_account_id), e.g. usba_.... Never pass a payout method ID from the `GetV2MoneyManagementPayoutMethods` dynamic tool, which lists the merchant's own payout methods; look up the recipient via the `GetV2CoreAccountsId` dynamic tool instead. Used only for mode=direct. If omitted, Stripe uses the recipient's default payout destination when configured.",
          "type": "string"
        },
        "amount": {
          "description": "Positive amount to send, as an integer in the currency's smallest unit, e.g. 50000 for $500.00 USD.",
          "minimum": 1,
          "type": "integer"
        },
        "currency": {
          "description": "Three-letter ISO currency code in lowercase, e.g. usd.",
          "type": "string"
        },
        "description": {
          "description": "Optional description attached to the payment.",
          "type": "string"
        },
        "mode": {
          "description": "How to send the money. direct creates a v2 outbound payment to a fully configured recipient. payout_via_email creates a v2 payout link that emails the recipient to complete payout and KYC details.",
          "enum": [
            "direct",
            "payout_via_email"
          ],
          "type": "string"
        },
        "human_confirmation": {
          "type": "object",
          "description": "This tool might require human confirmation. To run it, first invoke it with the desired parameters, ignoring the `approval_token` parameter.\nIf it requires human confirmation, the response will include an approval request ID and a URL to an approval page for the human to approve the tool call.\nYou, as the LLM agent, should:\n\n1. Present this URL to the human as a clickable markdown link. Tell them that they have to approve this tool call at that URL, and that they should tell you when they have approved the operation.\n2. The human will approve that call.\n3. After the human tells you they have approved the operation, you must call the tool again with the `approval_token` parameter and the exact same parameters. The operation will then go through.\n",
          "properties": {
            "approval_token": {
              "type": "string",
              "description": "The ID of the approval token for the request. This is required on only the post-human-confirmation invocation. An example ID is `approval_123`."
            }
          }
        },
        "stripe_context": {
          "type": "string",
          "description": "The account to target for this request. Use the `stripe_context` value returned by list_available_accounts_or_orgs."
        },
        "livemode": {
          "type": "boolean",
          "description": "Whether to operate in livemode (true) or test mode/ sandbox (false). Must match the livemode of the stripe_context account."
        }
      },
      "required": [
        "financial_account_id",
        "recipient_account_id",
        "amount",
        "currency",
        "mode",
        "stripe_context",
        "livemode"
      ]
    },
    "annotations": {
      "title": "Send money",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "transfer_money",
    "inputSchema": {
      "type": "object",
      "properties": {
        "amount": {
          "description": "Amount to transfer, in the currency's minor unit.",
          "minimum": 1,
          "type": "integer"
        },
        "currency": {
          "description": "Three-letter lowercase currency code for the transfer.",
          "type": "string",
          "minLength": 1
        },
        "source": {
          "description": "The balance or Financial Account to move money from.",
          "type": "object",
          "properties": {
            "type": {
              "description": "Source type.",
              "enum": [
                "payments_balance",
                "financial_account"
              ],
              "type": "string"
            },
            "financial_account_id": {
              "description": "Source v2 Financial Account ID. Required when source.type is financial_account.",
              "type": "string"
            },
            "payments_balance_source_type": {
              "description": "Payments balance source type. Defaults to card. Use bank_account only if you know the available balance is from bank account funds.",
              "enum": [
                "card",
                "bank_account"
              ],
              "type": "string"
            }
          },
          "required": [
            "type"
          ]
        },
        "destination": {
          "description": "The balance or v2 Financial Account to move money to.",
          "type": "object",
          "properties": {
            "type": {
              "description": "Destination type.",
              "enum": [
                "payments_balance",
                "financial_account"
              ],
              "type": "string"
            },
            "financial_account_id": {
              "description": "Destination v2 Financial Account ID. Required when destination.type is financial_account.",
              "type": "string"
            }
          },
          "required": [
            "type"
          ]
        },
        "description": {
          "description": "Optional description for the transfer. Applied to the resulting payout or outbound transfer.",
          "type": "string"
        },
        "human_confirmation": {
          "type": "object",
          "description": "This tool might require human confirmation. To run it, first invoke it with the desired parameters, ignoring the `approval_token` parameter.\nIf it requires human confirmation, the response will include an approval request ID and a URL to an approval page for the human to approve the tool call.\nYou, as the LLM agent, should:\n\n1. Present this URL to the human as a clickable markdown link. Tell them that they have to approve this tool call at that URL, and that they should tell you when they have approved the operation.\n2. The human will approve that call.\n3. After the human tells you they have approved the operation, you must call the tool again with the `approval_token` parameter and the exact same parameters. The operation will then go through.\n",
          "properties": {
            "approval_token": {
              "type": "string",
              "description": "The ID of the approval token for the request. This is required on only the post-human-confirmation invocation. An example ID is `approval_123`."
            }
          }
        },
        "stripe_context": {
          "type": "string",
          "description": "The account to target for this request. Use the `stripe_context` value returned by list_available_accounts_or_orgs."
        },
        "livemode": {
          "type": "boolean",
          "description": "Whether to operate in livemode (true) or test mode/ sandbox (false). Must match the livemode of the stripe_context account."
        }
      },
      "required": [
        "amount",
        "currency",
        "source",
        "destination",
        "stripe_context",
        "livemode"
      ]
    },
    "annotations": {
      "title": "Transfer money",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "setup_recipient",
    "inputSchema": {
      "type": "object",
      "properties": {
        "recipient_country": {
          "description": "The recipient country.",
          "enum": [
            "US",
            "GB"
          ],
          "type": "string"
        },
        "display_name": {
          "description": "Optional recipient display name.",
          "type": "string"
        },
        "contact_email": {
          "description": "Recipient email address used for payout via email.",
          "format": "email",
          "type": "string"
        },
        "entity_type": {
          "description": "The recipient entity type.",
          "enum": [
            "individual",
            "company"
          ],
          "type": "string"
        },
        "given_name": {
          "description": "The recipient individual's given name. Required when entity_type is 'individual'.",
          "type": "string"
        },
        "surname": {
          "description": "The recipient individual's surname. Required when entity_type is 'individual'.",
          "type": "string"
        },
        "business_name": {
          "description": "The recipient company's registered business name. Required when entity_type is 'company'.",
          "type": "string"
        },
        "stripe_context": {
          "type": "string",
          "description": "The account to target for this request. Use the `stripe_context` value returned by list_available_accounts_or_orgs."
        },
        "livemode": {
          "type": "boolean",
          "description": "Whether to operate in livemode (true) or test mode/ sandbox (false). Must match the livemode of the stripe_context account."
        }
      },
      "required": [
        "recipient_country",
        "contact_email",
        "entity_type",
        "stripe_context",
        "livemode"
      ]
    },
    "annotations": {
      "title": "Setup recipient",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "atlas_company_formation",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "list",
            "create",
            "retrieve",
            "advance"
          ],
          "description": "List accessible Atlas applications, create a new one, retrieve the current formation, or save a formation step."
        },
        "step": {
          "type": "string",
          "description": "Required for advance; use the step returned by retrieve. Omit for list, create, and retrieve."
        },
        "data": {
          "type": "object",
          "description": "Answers matching the returned next_step_schema. Required for advance except validate, where it is ignored. Omit for list, create, and retrieve."
        },
        "stripe_context": {
          "type": "string",
          "description": "The account to target for this request. Use the `stripe_context` value returned by list_available_accounts_or_orgs."
        },
        "livemode": {
          "type": "boolean",
          "description": "Whether to operate in livemode (true) or test mode/ sandbox (false). Must match the livemode of the stripe_context account."
        }
      },
      "required": [
        "action",
        "stripe_context",
        "livemode"
      ],
      "additionalProperties": false
    },
    "outputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": true
    },
    "annotations": {
      "title": "Atlas company formation",
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false,
      "openWorldHint": true
    }
  },
  {
    "name": "list_available_accounts_or_orgs",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "accounts": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "stripe_context": {
                "type": "string",
                "description": "Value to pass as Stripe-Context tool param when targeting this account, can be account_id or org_id"
              },
              "livemode": {
                "type": "boolean",
                "description": "Whether the account is in livemode"
              },
              "name": {
                "type": "string",
                "description": "Name of the account or org"
              }
            },
            "required": [
              "stripe_context",
              "livemode"
            ]
          }
        }
      },
      "required": [
        "accounts"
      ]
    },
    "annotations": {
      "title": "List available accounts or orgs",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  },
  {
    "name": "manage_stripe_accounts",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    "outputSchema": {
      "type": "object",
      "properties": {
        "reconsent_url": {
          "type": "string",
          "description": "URL to the Stripe Dashboard page where the user can manage accounts and permissions"
        }
      },
      "required": [
        "reconsent_url"
      ]
    },
    "annotations": {
      "title": "Manage Stripe accounts",
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": false
    }
  }
];

export const createAuthored = () => fixture.create();
