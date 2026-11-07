# Docs

Start here. Each section names one audience and the page that serves it.

## Overview

- [Root README](../README.md) — quickstart, demo users, and links.

## First run

- [Getting started](getting-started.md) — how-to. Run the stack, walk the four scenarios, verify, and reset.

## Demo

- [Getting started](getting-started.md#4-run-the-four-scenarios) — how-to. Canonical scenarios, headless checks, and recovery.
- [Demo fixtures](demo/fixtures.md) — how-to. CLI fixture workflow for the T17 customer personas.

## Developer

- [Architecture](explanation/architecture.md) — explanation. Components, request flow, trust boundary, and failure domains.
- [Lifecycle](explanation/lifecycle.md) — explanation. Status machines, expiry, the booking saga, and alert behavior.
- [Eval index](eval/index.md) — results. Case counts, model winners, costs, and every per-agent eval report.
- [Eval design](eval/eval-design.md) - guideline. Lab practices, a small suite per AI feature, and the Grafana split.
- [Model comparison 2026-10-28](eval/model-comparison-2026-10-28.md) - report. Five credit agents across six models: winners, costs, and caveats.
- [Adverse action](explanation/adverse-action.md) - explanation. EN-08 taxonomy, jurisdiction profiles, fair-lending gates, and letter provenance.
- [Policy exception](explanation/policy-exception.md) - explanation. EN-06/EN-07 case-policy review, exception path, and memo provenance.
- [Document workflow](explanation/document-workflow.md) — explanation. Uploads, OCR, ClamAV, and v1 limits.
- [Document integrity](explanation/document-integrity.md) — explanation. Fingerprint/provenance, signals, combined extraction/consistency/brief pass, and fraud review.
- [Agent and app observability](explanation/agent-observability.md) — explanation. Grafana Agent Observability wiring, agent and service names, evals, and gcx verification.
- [Agentic memo](explanation/agentic-memo.md) - explanation. Bounded tool loop, allowlisted evidence tools, validation/repair, trace, replay, and writer modes.
- [Case assistant](explanation/case-assistant.md) - explanation. Officer Ask tab: case-scoped read-only tool loop, answer gates, trace, and flags.
- [Credit pipeline pain points](explanation/credit-pipeline-pain-points.md) — research. Bank and credit-officer bottlenecks, current coverage, and feature options.
- [Extend the pipeline](how-to/extend-the-pipeline.md) — how-to. Recipes for routes, events, migrations, policy, and demo checks.

## Operator

- [Troubleshooting](operations/troubleshooting.md) — how-to. Symptom tables, health checks, and safe recovery.
- [Configuration](reference/configuration.md) — reference. Variables, defaults, precedence, and container overrides.
- [Commands](reference/commands.md) — reference. Every root script.
- [Versions and notes](reference/versions.md) — reference. Toolchain pins and caveats.

## API caller

- [Public and internal API](reference/api.md) — reference. Auth, applications, review, loans, demo, dashboard, health, internal contracts, errors.
- [Data and events](reference/data-and-events.md) — reference. Database ownership, topics, payloads, outbox, consumer.
