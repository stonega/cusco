# Provider Models

This page mirrors Cusco's built-in provider registry in `src/providers/config.js`
and the thinking-level registry in `src/providers/thinking.js`.

Thinking levels are shown only when the selected provider and model support
them. If a chat's saved level is not supported by a newly selected model, Cusco
falls back to the model's configured default when available, then to `Auto`,
and finally to the model's first supported level. Models without thinking
support keep the chat picker disabled.

## Thinking Levels

| Level | Meaning |
|---|---|
| `Off` | Disable provider reasoning when the API supports disabling it. |
| `Minimal` | Smallest explicit thinking mode, currently used by Gemini 3.5 Flash. |
| `Auto` | Let the provider choose its default thinking behavior. |
| `Low` | Request low reasoning effort or a low thinking budget. |
| `Medium` | Request medium reasoning effort or a medium thinking budget. |
| `High` | Request high reasoning effort or a high thinking budget. |
| `X-High` | Request extra-high reasoning effort when the provider supports it. |
| `Max` | Request maximum reasoning effort for quality-first workloads. |

## Built-In Models

| Provider | Default model | Models | Thinking levels |
|---|---|---|---|
| OpenAI | `gpt-5.6-sol` | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | `Off`, `Auto`, `Low`, `Medium`, `High`, `X-High`, `Max` |
| OpenAI | `gpt-5.6-sol` | `gpt-5.5`, `gpt-5.4-mini` | `Off`, `Auto`, `Low`, `Medium`, `High` |
| OpenAI | `gpt-5.6-sol` | `gpt-4.1` | None |
| Anthropic | `claude-sonnet-5` | `claude-fable-5` | `Low`, `Medium`, `High`, `X-High`, `Max` |
| Anthropic | `claude-sonnet-5` | `claude-opus-4-8`, `claude-sonnet-5` | `Off`, `Low`, `Medium`, `High`, `X-High`, `Max` |
| Anthropic | `claude-sonnet-5` | `claude-haiku-4-5` | `Off`, `Auto`, `Low`, `Medium`, `High` |
| Google Gemini | `gemini-3.5-flash` | `gemini-3.5-flash` | `Minimal`, `Auto`, `Low`, `Medium`, `High` |
| Google Gemini | `gemini-3.5-flash` | `gemini-3.1-pro-preview` | `Auto`, `Low`, `Medium`, `High` |
| Kimi | `kimi-k3` | `kimi-k3` | `Max` |
| Kimi | `kimi-k3` | `kimi-k2.7-code`, `kimi-k2.7-code-highspeed` | `Auto` |
| Kimi | `kimi-k3` | `kimi-k2.6` | `Off`, `Auto` |
| DeepSeek | `deepseek-v4-pro` | `deepseek-v4-pro`, `deepseek-v4-flash` | `Off`, `Auto`, `High`, `Max` |
| Grok | `grok-4.5` | `grok-4.5` | `Low`, `Medium`, `High` |
| Grok | `grok-4.5` | `grok-4.3` | `Off`, `Low`, `Medium`, `High` |
| Z.ai | `glm-5.2` | `glm-5.2` | `Off`, `Auto`, `High`, `Max` |
| Z.ai | `glm-5.2` | `glm-5-turbo` | `Off`, `Auto` |
| Custom APIs | First discovered model | Discovered or user configured | None |

## Context Windows

The composer usage percentage uses these approximate maximum context windows
from the built-in model metadata.

| Provider | Model | Context window |
|---|---|---|
| OpenAI | `gpt-5.6-sol` | 1.05M tokens |
| OpenAI | `gpt-5.6-terra` | 1.05M tokens |
| OpenAI | `gpt-5.6-luna` | 1.05M tokens |
| OpenAI | `gpt-5.5` | 1M tokens |
| OpenAI | `gpt-5.4-mini` | 400K tokens |
| OpenAI | `gpt-4.1` | 1M tokens |
| Anthropic | `claude-fable-5` | 1M tokens |
| Anthropic | `claude-opus-4-8` | 1M tokens |
| Anthropic | `claude-sonnet-5` | 1M tokens |
| Anthropic | `claude-haiku-4-5` | 200K tokens |
| Google Gemini | `gemini-3.5-flash` | 1,048,576 tokens |
| Google Gemini | `gemini-3.1-pro-preview` | 1,048,576 tokens |
| Kimi | `kimi-k3` | 1M tokens |
| Kimi | `kimi-k2.7-code` | 256K tokens |
| Kimi | `kimi-k2.7-code-highspeed` | 256K tokens |
| Kimi | `kimi-k2.6` | 256K tokens |
| DeepSeek | `deepseek-v4-pro` | 1M tokens |
| DeepSeek | `deepseek-v4-flash` | 1M tokens |
| Grok | `grok-4.5` | 1M tokens |
| Grok | `grok-4.3` | 1M tokens |
| Z.ai | `glm-5.2` | 1M tokens |
| Z.ai | `glm-5-turbo` | 200K tokens |
| Custom APIs | Discovered or user configured | Unknown |

## Image Generation Models

Image generation models are configured separately from chat models. The
`image_gen` chat tool uses the standalone image generation provider and model
chosen in Settings, independent of the active conversation's chat provider. For
example, an OpenAI chat can generate images through Gemini when Gemini is the
selected image provider. Each custom API can also have manually entered image
models that use its OpenAI-compatible image generation endpoint.

| Provider | Default image model | Supported image models |
|---|---|---|
| OpenAI | `gpt-image-2` | `gpt-image-2` |
| Google Gemini | `gemini-3.1-flash-image` | `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image` |
| Grok | `grok-imagine-image-quality` | `grok-imagine-image-quality`, `grok-imagine-image` |
| Z.ai | `glm-image` | `glm-image` |
| Custom APIs | None | User configured per endpoint |

## Provider Notes

- OpenAI uses `gpt-5.6-sol` as the default chat model. The documented
  `gpt-5.6` alias is normalized to `gpt-5.6-sol`; Terra balances intelligence
  and cost, and Luna is optimized for cost-sensitive workloads. Only the GPT-5.6
  family exposes `X-High` and `Max` reasoning in Cusco.
- Gemini is intentionally limited to `gemini-3.5-flash` and
  `gemini-3.1-pro-preview`. Persisted or discovered Gemini 2.x models are
  ignored, and the stale `gemini-3.1-pro` ID is migrated to
  `gemini-3.1-pro-preview`. Gemini image generation excludes
  `gemini-2.5-flash-image`; only the Gemini 3 image models listed above are
  supported.
- Anthropic is intentionally limited to `claude-fable-5`,
  `claude-opus-4-8`, `claude-sonnet-5`, and
  `claude-haiku-4-5`. Fable 5 uses always-on adaptive thinking and
  cannot expose `Off`; Opus 4.8 and Sonnet 5 can disable adaptive thinking.
  Their explicit effort levels are sent in `output_config`, default to `High`,
  and support `X-High` and `Max`. Haiku 4.5 continues to use manual
  extended-thinking budgets and does not support those two higher efforts.
- Kimi is intentionally limited to `kimi-k3`, `kimi-k2.7-code`,
  `kimi-k2.7-code-highspeed`, and `kimi-k2.6`. Persisted or discovered
  Moonshot V1 and older Kimi models are ignored. Kimi K3 uses always-on
  thinking with its only currently supported effort, `Max`; requests use
  top-level `reasoning_effort` and `max_completion_tokens`, not the K2.x
  `thinking` parameter. Kimi K2.7 Code variants use always-on thinking through
  `Auto`; only Kimi K2.6 exposes `Off`.
- DeepSeek is intentionally limited to `deepseek-v4-pro` and
  `deepseek-v4-flash`. Older persisted models such as `deepseek-v3` are
  ignored. `Auto` enables DeepSeek thinking without an explicit effort;
  `High` and `Max` send the matching `reasoning_effort`.
- Grok uses xAI's OpenAI-compatible API and is intentionally limited to
  `grok-4.5` and `grok-4.3`. Grok image generation uses xAI's
  OpenAI-compatible image endpoint with `grok-imagine-image-quality` and
  `grok-imagine-image`. `grok-4.5` exposes `Low`, `Medium`, and `High`
  reasoning and defaults to `High`; `grok-4.3` also supports `Off`.
- Z.ai is intentionally limited to `glm-5.2` and `glm-5-turbo`, and model
  discovery is disabled. `glm-5.2` supports explicit `High` and `Max`
  reasoning effort; `glm-5-turbo` supports only thinking on/off. Z.ai image
  generation supports only `glm-image`; `cogview-4-250304` is intentionally
  excluded.
- Each entry in the Custom APIs list uses the generic OpenAI-compatible chat
  completions adapter and keeps its own endpoint, models, default selection, and
  Secret Service API key. Cusco fetches models from `GET /models` when an entry
  is added or refreshed; manual model IDs remain available for services that do
  not expose discovery. Custom API models do not have built-in thinking metadata.
  Custom image models are entered manually per endpoint and use its configured
  base URL with an OpenAI-compatible image generation request.

## Constrained Provider Details

| Provider | Model | Details | Thinking levels |
|---|---|---|---|
| Anthropic | `claude-fable-5` | Anthropic's most capable model for long-running agents and demanding reasoning. Context 1M. | `Low`, `Medium`, `High`, `X-High`, `Max` |
| Anthropic | `claude-opus-4-8` | Advanced model for complex agentic coding and enterprise work. Context 1M. | `Off`, `Low`, `Medium`, `High`, `X-High`, `Max` |
| Anthropic | `claude-sonnet-5` | Best balance of speed and intelligence for production workloads. Context 1M. | `Off`, `Low`, `Medium`, `High`, `X-High`, `Max` |
| Anthropic | `claude-haiku-4-5` | Fastest Claude model with near-frontier intelligence. Context 200K. | `Off`, `Auto`, `Low`, `Medium`, `High` |
| Google Gemini | `gemini-3.5-flash` | Stable Gemini 3 model for sustained frontier performance. | `Minimal`, `Auto`, `Low`, `Medium`, `High` |
| Google Gemini | `gemini-3.1-pro-preview` | Advanced intelligence and agentic coding model. | `Auto`, `Low`, `Medium`, `High` |
| Kimi | `kimi-k3` | Kimi flagship model for long-horizon coding, knowledge work, reasoning, and visual understanding. Context 1M. | `Max` |
| Kimi | `kimi-k2.7-code` | Kimi coding model with stronger long-context instruction following and higher coding task success. Context 256k. | `Auto` |
| Kimi | `kimi-k2.7-code-highspeed` | High-speed Kimi K2.7 Code variant, around 180 tokens/s and up to 260 tokens/s in short contexts. Context 256k. | `Auto` |
| Kimi | `kimi-k2.6` | Kimi intelligent multimodal model for agent, code, visual understanding, and general tasks with thinking and non-thinking modes. Context 256k. | `Off`, `Auto` |
| DeepSeek | `deepseek-v4-pro` | DeepSeek reasoning-capable model. | `Off`, `Auto`, `High`, `Max` |
| DeepSeek | `deepseek-v4-flash` | DeepSeek lower-latency model. | `Off`, `Auto`, `High`, `Max` |
| Grok | `grok-4.5` | xAI Grok model for frontier chat, coding, and agentic work. | `Low`, `Medium`, `High` |
| Grok | `grok-4.3` | xAI Grok text and vision model with a 1M token context window. | `Off`, `Low`, `Medium`, `High` |
| Z.ai | `glm-5.2` | Z.ai flagship model for coding and agent applications. | `Off`, `Auto`, `High`, `Max` |
| Z.ai | `glm-5-turbo` | Z.ai faster GLM-5 series model optimized for agent workflows. | `Off`, `Auto` |

## References

- Claude model overview: https://platform.claude.com/docs/en/about-claude/models/overview
- Claude adaptive thinking: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
- Claude effort levels: https://platform.claude.com/docs/en/build-with-claude/effort
- Claude extended thinking: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- Kimi K3 quickstart: https://platform.kimi.ai/docs/guide/kimi-k3-quickstart
- Gemini image generation guide: https://ai.google.dev/gemini-api/docs/image-generation
- OpenAI model catalog: https://developers.openai.com/api/docs/models
- OpenAI GPT-5.6 model guidance: https://developers.openai.com/api/docs/guides/latest-model
- OpenAI image generation guide: https://developers.openai.com/api/docs/guides/images-vision
- xAI chat completions API: https://docs.x.ai/developers/rest-api-reference/inference/chat
- xAI image generation API: https://docs.x.ai/developers/rest-api-reference/inference/images
- xAI model listing API: https://docs.x.ai/developers/rest-api-reference/inference/models
- Z.ai GLM-Image guide: https://docs.z.ai/guides/image/glm-image
- Z.ai image generation API: https://docs.z.ai/api-reference/image/generate-image
- Z.ai GLM-5-Turbo guide: https://docs.z.ai/guides/llm/glm-5-turbo
- Z.ai thinking parameter overview: https://docs.z.ai/guides/overview/concept-param
