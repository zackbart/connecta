---
type: fixed
---

Match advertised resource URI templates with deterministic forward scans. Refuse ambiguous expression boundaries with resource_template_ambiguous and cap each read at 262144 template-plus-URI characters with resource_match_budget_exceeded. Operator diagnostics retain each typed refusal once without URI or template text. Keep scheme and authority literal, reject Unicode controls and format characters at every decoding layer, and allow safe multi-segment reserved and exploded paths.
