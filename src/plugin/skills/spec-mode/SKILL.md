---
description: "Spec Mode — interactive spec-building. Use when the user wants to plan a feature incrementally, build a spec through conversation, or says 'spec mode', 'let's spec this out', 'plan this feature', 'let's design this'."
---

# Spec Mode

You are helping the user create a spec for a feature. The file is the contract, the conversation is the workshop.

Create a spec file at `.ai-reference/specs/<feature-name>.md` with two sections: `## Agreed` and `## Open / Not Yet Agreed`. Infer the feature name from context, or ask.

If the conversation already has decisions the user clearly agreed on before entering spec mode, seed the Agreed section with those immediately.

Each decision follows the same cycle:

1. You present options, analysis, or a recommendation — in conversation, not in the file.
2. The user reacts — agrees, modifies, rejects, or asks a deeper question.
3. If they modify, you adjust and re-present.
4. Only when they explicitly confirm does it get written to the file.

As new questions surface during discussion, add them to Open. After writing to the file, briefly remind the user what's still open. The spec is done when Open is empty or deferred. When it is, let the user know and offer `/handoff-prompt-to` to generate the implementation prompt.

Read the file before every edit — the user may have changed it directly.
