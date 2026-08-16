# Window Refactor Implementation Report

- **Completed:** 2026-08-16
- **Scope:** `src/window.js` and its extracted chat-window collaborators
- **Behavioral intent:** Preserve existing application behavior while separating responsibilities

## Summary

The main application window has been changed from a single 11,257-line implementation into a 3,398-line composition root backed by 34 focused modules. This removed 7,859 lines from `src/window.js`, a reduction of approximately 70%.

The window remains responsible for constructing the top-level `Adw.ApplicationWindow`, owning shared window state, connecting feature collaborators, and retaining the compatibility entry points used by the existing smoke harness. Feature logic now lives next to the chat, composer, provider, hook, cron, and tool subsystems that own it.

No user-visible behavior was intentionally changed by this refactor.

## Goals and outcome

| Goal | Outcome |
|---|---|
| Make `src/window.js` easier to navigate | Reduced it from 11,257 to 3,398 lines. |
| Separate presentation from orchestration | Moved widget presentation, turn coordination, provider streaming, and background integration into distinct modules. |
| Keep ownership close to each feature | Added modules beneath `src/chat/`, `src/composer/`, `src/providers/`, `src/hooks/`, `src/cron/`, and `src/tools/`. |
| Preserve behavior during extraction | Kept thin window delegates where tests or existing call sites depend on the original method boundary. |
| Keep the source build complete | Registered every extracted module in `src/meson.build` and extended the import smoke coverage. |

## Resulting architecture

`src/window.js` is now the composition layer. It creates the primary widgets and shared state, instantiates or calls the extracted collaborators, and routes window lifecycle events. The extracted modules own the following areas:

| Area | Modules | Responsibility |
|---|---|---|
| Chat presentation | `presentation.js`, `messagePresenter.js`, `agentActivityPresenter.js`, `emptyConversationPresenter.js`, `transcriptRenderer.js`, `scrollController.js` | Pure presentation decisions, message and activity widgets, empty state, transcript rendering, and scroll behavior. |
| Sidebar and usage surfaces | `conversationSidebar.js`, `usagePage.js`, `usagePagePresentation.js`, `composerUsage.js` | Conversation-list behavior and usage-state presentation. |
| Turn lifecycle | `turnSubmission.js`, `turnCoordinator.js`, `assistantStreamRunner.js`, `providerStream.js`, `contextBuilder.js` | Submission, context assembly, provider streaming, completion, cancellation, and queued-turn coordination. |
| Agent and message behavior | `agentRuntime.js`, `agentActivity.js`, `messageActions.js`, `pendingMessages.js`, `streamingAssistantView.js` | Agent execution state, activity updates, message actions, pending messages, and the active assistant response surface. |
| Composer | `chatSurface.js`, `inputController.js`, `attachmentsController.js`, `attachmentPresentation.js`, `suggestions.js`, `agentQuestions.js`, `menus.js`, `presentation.js` | Composer construction, input, attachments, suggestions, questions, menus, and display helpers. |
| Provider selection | `providers/chatSelection.js`, `providers/modelPicker.js` | Provider/model choice and the model picker UI. |
| Integrations | `hooks/coordinator.js`, `cron/conversationSync.js`, `tools/requestedToolRunner.js`, `chat/conversationActions.js` | Hook execution, scheduled conversation synchronization, requested tool execution, and conversation-level actions. |

The dependency direction is intentionally toward the extracted modules:

```text
window.js
  -> chat and composer presentation
  -> turn and provider orchestration
  -> hooks, tools, and background synchronization
  -> existing stores, services, and reusable views
```

The extracted modules receive the state and callbacks they need instead of importing the application window. This keeps them independently importable and avoids introducing a circular dependency around `window.js`.

## Compatibility strategy

The refactor was performed as a behavior-preserving extraction rather than a rewrite. Existing window method boundaries used by tests and internal call sites remain as small delegates to their new owners. This allowed each responsibility to move without requiring simultaneous changes to every consumer.

Compatibility delegates should stay thin. New feature logic belongs in the relevant extracted module; it should not accumulate in the delegate or move back into `src/window.js`.

## Build and test integration

`src/meson.build` now includes all extracted JavaScript modules so installed resource bundles match source execution. `tests/import-smoke.js` imports the new modules, catching syntax errors and imports that accidentally depend on an initialized GTK window.

The completed refactor passed:

- The full `scripts/check.sh` smoke suite.
- Import, rendering, streaming, provider fallback, agent mode, tools, hooks, usage, background synchronization, chat management, and conversation-store coverage included by that suite.
- Meson configuration and compilation, including generated application resources.
- `git diff --check` for whitespace and patch integrity.

The conversation-store recovery test still prints its deliberately induced transient-write diagnostic; the test itself passes as expected.

## Maintenance guidance

- Add new chat behavior to the closest existing collaborator rather than directly to `src/window.js`.
- Keep presentation-only transformations free of GTK window state when practical so they remain easy to test.
- Pass narrow callbacks and required state into orchestration modules; do not make them reach back through the entire window object.
- Register every new runtime module in `src/meson.build` and `tests/import-smoke.js`.
- Run `scripts/check.sh` after changes that cross window, streaming, provider, hook, or persistence boundaries.

`src/window.js` is still substantial because it owns top-level widget composition, shared state, and compatibility routing. Further reductions should be driven by a clear responsibility boundary rather than a line-count target.
