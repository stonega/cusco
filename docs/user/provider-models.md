# Provider Models

This page mirrors Cusco's built-in provider registry in `src/providers/config.js`
and the thinking-level registry in `src/providers/thinking.js`.

Thinking levels are shown only when the selected provider and model support
them. If a chat's saved level is not supported by a newly selected model, Cusco
falls back to `Auto` when available, otherwise to the model's first supported
level. Models without thinking support keep the chat picker disabled.

## Thinking Levels

| Level | Meaning |
|---|---|
| `Off` | Disable provider reasoning when the API supports disabling it. |
| `Minimal` | Smallest explicit thinking mode, currently used by Gemini 3.5 Flash. |
| `Auto` | Let the provider choose its default thinking behavior. |
| `Low` | Request low reasoning effort or a low thinking budget. |
| `Medium` | Request medium reasoning effort or a medium thinking budget. |
| `High` | Request high reasoning effort or a high thinking budget. |
| `Max` | Request DeepSeek's maximum reasoning effort. |

## Built-In Models

| Provider | Default model | Models | Thinking levels |
|---|---|---|---|
| OpenAI | `gpt-5.5` | `gpt-5.5`, `gpt-5.4-mini` | `Off`, `Auto`, `Low`, `Medium`, `High` |
| OpenAI | `gpt-5.5` | `gpt-4.1` | None |
| Anthropic | `claude-sonnet-4-6` | `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` | `Off`, `Auto`, `Low`, `Medium`, `High` |
| Google Gemini | `gemini-3.5-flash` | `gemini-3.5-flash` | `Minimal`, `Auto`, `Low`, `Medium`, `High` |
| Google Gemini | `gemini-3.5-flash` | `gemini-3.1-pro-preview` | `Auto`, `Low`, `Medium`, `High` |
| Kimi | `kimi-k2.7-code` | `kimi-k2.7-code`, `kimi-k2.7-code-highspeed` | `Auto` |
| Kimi | `kimi-k2.7-code` | `kimi-k2.6` | `Off`, `Auto` |
| DeepSeek | `deepseek-v4-pro` | `deepseek-v4-pro`, `deepseek-v4-flash` | `Off`, `Auto`, `High`, `Max` |
| MiniMax | `MiniMax-M3` | `MiniMax-M3`, `MiniMax-M2.7`, `MiniMax-M2.7-highspeed`, `MiniMax-M2.5`, `MiniMax-M2.5-highspeed`, `MiniMax-M2.1`, `MiniMax-M2.1-highspeed`, `MiniMax-M2` | None |
| Z.ai | `glm-5.2` | `glm-5.2` | `Off`, `Auto`, `High`, `Max` |
| Z.ai | `glm-5.2` | `glm-5-turbo` | `Off`, `Auto` |
| Custom API | None | User configured | None |

## Image Generation Models

Image generation models are configured separately from chat models. The
`image_gen` chat tool uses the standalone image generation provider and model
chosen in Settings, independent of the active conversation's chat provider. For
example, an OpenAI chat can generate images through Gemini when Gemini is the
selected image provider. Custom API image models are entered by the user and use
an OpenAI-compatible image generation endpoint.

| Provider | Default image model | Supported image models |
|---|---|---|
| OpenAI | `gpt-image-2` | `gpt-image-2` |
| Google Gemini | `gemini-3.1-flash-image` | `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image` |
| Z.ai | `glm-image` | `glm-image` |
| Custom API | None | User configured |

## Provider Notes

- Gemini is intentionally limited to `gemini-3.5-flash` and
  `gemini-3.1-pro-preview`. Persisted or discovered Gemini 2.x models are
  ignored, and the stale `gemini-3.1-pro` ID is migrated to
  `gemini-3.1-pro-preview`. Gemini image generation excludes
  `gemini-2.5-flash-image`; only the Gemini 3 image models listed above are
  supported.
- Kimi is intentionally limited to `kimi-k2.7-code`,
  `kimi-k2.7-code-highspeed`, and `kimi-k2.6`. Persisted or discovered
  Moonshot V1 and older Kimi models are ignored. Kimi K2.7 Code variants use
  always-on thinking through `Auto`; only Kimi K2.6 exposes `Off`.
- DeepSeek is intentionally limited to `deepseek-v4-pro` and
  `deepseek-v4-flash`. Older persisted models such as `deepseek-v3` are
  ignored. `Auto` enables DeepSeek thinking without an explicit effort;
  `High` and `Max` send the matching `reasoning_effort`.
- Z.ai is intentionally limited to `glm-5.2` and `glm-5-turbo`, and model
  discovery is disabled. `glm-5.2` supports explicit `High` and `Max`
  reasoning effort; `glm-5-turbo` supports only thinking on/off. Z.ai image
  generation supports only `glm-image`; `cogview-4-250304` is intentionally
  excluded.
- Custom API models are entered by the user and use the generic
  OpenAI-compatible chat completions adapter without built-in thinking metadata.
  Custom API image models are also entered by the user and use the configured
  base URL with an OpenAI-compatible image generation request.

## Constrained Provider Details

| Provider | Model | Details | Thinking levels |
|---|---|---|---|
| Google Gemini | `gemini-3.5-flash` | Stable Gemini 3 model for sustained frontier performance. | `Minimal`, `Auto`, `Low`, `Medium`, `High` |
| Google Gemini | `gemini-3.1-pro-preview` | Advanced intelligence and agentic coding model. | `Auto`, `Low`, `Medium`, `High` |
| Kimi | `kimi-k2.7-code` | Kimi coding model with stronger long-context instruction following and higher coding task success. Context 256k. | `Auto` |
| Kimi | `kimi-k2.7-code-highspeed` | High-speed Kimi K2.7 Code variant, around 180 tokens/s and up to 260 tokens/s in short contexts. Context 256k. | `Auto` |
| Kimi | `kimi-k2.6` | Kimi intelligent multimodal model for agent, code, visual understanding, and general tasks with thinking and non-thinking modes. Context 256k. | `Off`, `Auto` |
| DeepSeek | `deepseek-v4-pro` | DeepSeek reasoning-capable model. | `Off`, `Auto`, `High`, `Max` |
| DeepSeek | `deepseek-v4-flash` | DeepSeek lower-latency model. | `Off`, `Auto`, `High`, `Max` |
| Z.ai | `glm-5.2` | Z.ai flagship model for coding and agent applications. | `Off`, `Auto`, `High`, `Max` |
| Z.ai | `glm-5-turbo` | Z.ai faster GLM-5 series model optimized for agent workflows. | `Off`, `Auto` |

## References

- Gemini image generation guide: https://ai.google.dev/gemini-api/docs/image-generation
- OpenAI image generation guide: https://developers.openai.com/api/docs/guides/images-vision
- Z.ai GLM-Image guide: https://docs.z.ai/guides/image/glm-image
- Z.ai image generation API: https://docs.z.ai/api-reference/image/generate-image
- Z.ai GLM-5-Turbo guide: https://docs.z.ai/guides/llm/glm-5-turbo
- Z.ai thinking parameter overview: https://docs.z.ai/guides/overview/concept-param
