# Council Architecture — 3-Stage Deliberation DAG

Source: Multi-Model Council MCP Server architecture paper (2026-04-03).

## Overview

The Model Council operates as a **Distributed Multi-Agent Consensus System** executing a deterministic, linear Directed Acyclic Graph (DAG). This avoids the cyclical infinite loops common in ReAct-style autonomous agents, ensuring bounded execution times suitable for synchronous MCP tool calls.

## Stage 1: Divergence (Fan-Out)

The incoming prompt is broadcast **in parallel** to all configured council members (e.g., GPT, Gemini, Grok).

**Objective:** Maximize entropy and explore the broadest solution space. If one model gets stuck in a logical fallacy or suboptimal approach, others may find better angles.

**Implementation:**
- Classic Fan-Out pattern using async concurrency (`Promise.allSettled` in Node.js)
- Total latency is bounded by the **slowest model**, not the sum of all models
- Each model query is an independent async task

**Maps to Brainstew:** This is already how `brainstew_council` works — parallel dispatch via `Promise.allSettled`.

## Stage 2: Convergence (Peer Review)

Every model is presented with the **anonymized** responses from its peers for cross-evaluation.

**Objective:** Eliminate self-preference bias and establish objective scoring.

**Key mechanisms:**
- **Anonymization**: Strip model identities, relabel as "Response A", "Response B", "Response C". This prevents:
  - Self-preference bias (models favoring their own architecture's style)
  - Brand reputation bias
- **Discriminator role**: Models evaluate rather than generate, using strict grading rubrics for:
  - Accuracy
  - Code efficiency
  - Edge-case handling
  - Insight quality
- **Rating matrix**: O(N^2) operation — each model evaluates all submissions
- **Aggregation**: Borda count or similar methodology identifies strongest components

**Not yet in Brainstew.** This is the major architectural evolution — currently Brainstew returns raw parallel responses for the host agent (Claude) to synthesize.

## Stage 3: Synthesis (Map-Reduce)

A designated "Chairman" model receives the full payload and produces the final output.

**Inputs to Chairman:**
1. Original query
2. All Stage 1 candidate responses
3. Complete anonymized Stage 2 peer review matrix

**Chairman responsibilities:**
- Resolve identified conflicts between responses
- Discard hallucinated APIs caught during peer review
- Compile optimal code structures into a single cohesive answer

**Chairman selection:** In a Claude Code environment, the host model (Claude) naturally serves this role. Alternatively, a powerful external model (e.g., Gemini Pro) can serve as Chairman.

**Maps to Brainstew:** Currently, Claude (the host agent) implicitly acts as Chairman when it synthesizes the raw `brainstew_council` responses. Making this explicit in-server would move synthesis server-side.

## Implementation Considerations for Brainstew

### Current state (v0.3.0)
- Stage 1 (Divergence) is implemented
- Stages 2-3 are delegated to the host agent

### Potential evolution
If implementing Stages 2-3 server-side:

1. **Latency**: Adding two more LLM round-trips significantly increases wall time. Progress notifications become critical.
2. **Cost**: O(N^2) peer review multiplies token consumption. With 3 models, that's 9 evaluations + 1 synthesis = 10 total LLM calls per council query.
3. **Complexity**: The server would need to manage multi-round orchestration internally, increasing error surface.
4. **Trade-off**: Keeping synthesis client-side (Claude as Chairman) is simpler and lets the host model use its full context window. Moving it server-side gives tighter control but adds latency and cost.

### Progress notifications for multi-stage
If implementing multi-stage, emit progress per stage:
```
Stage 1: "Dispatching queries to GPT, Gemini, and Grok"
Stage 2: "Received N responses. Formulating anonymized evaluation matrix"
Stage 3: "Peer review complete. Synthesizing final resolution"
```
Brainstew already emits per-model progress notifications — this extends that pattern.
