---
description: Pick an assistant message and annotate it in Schlop (Neovim), then send the annotations to Claude
argument-hint: "[n]"
disable-model-invocation: true
---

The user just annotated one of your earlier messages in Schlop. Their annotations, which quote the passages they refer to, are attached to this message as UserPromptSubmit hook context. Treat that feedback as the user's message and respond to it.

If no Schlop feedback is attached, the Schlop plugin hook did not run: say so and do nothing else.
