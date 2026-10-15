---
description: Annotate the last assistant message in Schlop (Neovim) and send the annotations to Claude
disable-model-invocation: true
---

The user just annotated your last message in Schlop. Their annotations are attached to this message as UserPromptSubmit hook context. Treat that feedback as the user's message and respond to it.

If no Schlop feedback is attached, the Schlop plugin hook did not run: say so and do nothing else.
