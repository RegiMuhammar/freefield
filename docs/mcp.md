# Freefield MCP Server

Freefield ships a native **Model Context Protocol (MCP)** server (`server/mcp.ts` and `/mcp` on `server/server.ts`), modeled after [Higgsfield MCP](https://higgsfield.ai/mcp). It lets AI agents—including **Antigravity / Gemini CLI**, **Claude Desktop**, **Claude Code**, **Cursor**, and **ChatGPT**—discover and run all 120 open-weights image, video, VFX, and audio apps on your GPU backend (Modal, Google Colab, or Local GPU).

---

## 1. Quick Start: Connect Your AI Client

### A. Antigravity / Gemini CLI / Claude Desktop / Cursor (Stdio Transport)

Add `freefield` to your client's MCP configuration (`mcp_config.json`, `claude_desktop_config.json`, or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "freefield": {
      "command": "node",
      "args": [
        "--env-file-if-exists=.env",
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        "server/mcp.ts"
      ],
      "cwd": "/absolute/path/to/freefield"
    }
  }
}
```

*(On Windows, use forward slashes in `cwd`, e.g. `"D:/Project Coding/freefield"`).*

### B. Claude Code (CLI)

**Local stdio:**
```sh
claude mcp add freefield -- node --env-file-if-exists=.env --experimental-strip-types --disable-warning=ExperimentalWarning /path/to/freefield/server/mcp.ts
```

**HTTP transport (when `npm run serve` or the Modal web app is running):**
```sh
claude mcp add --transport http freefield http://127.0.0.1:3000/mcp
```

### C. ChatGPT Connectors / Claude Web Connectors (Streamable HTTP)

Every `npm run serve` instance (and the hosted Modal web demo in `infra/web_app.py`) serves the Streamable HTTP MCP endpoint at **`/mcp`**:

- **Local URL:** `http://127.0.0.1:3000/mcp`
- **Hosted / Modal URL (with passcode):**
  - Query parameter: `https://<workspace>--freefield-demo.modal.run/mcp?key=<FREEFIELD_PASSCODE>`
  - Or HTTP header: `Authorization: Bearer <FREEFIELD_PASSCODE>`
- **Standalone HTTP MCP server (without the Web UI):**
  ```sh
  npm run mcp -- --http 3001
  ```

---

## 2. Available MCP Tools

Instead of exposing 120 separate tools that bloat the LLM context window, Freefield MCP exposes **10 unified tools**:

| Tool | Purpose |
| :--- | :--- |
| `freefield_list_apps` | Browse and filter the 120 apps by `section` (`image`, `video`, `audio`, `utility`), `search` keyword, `pack`, or `max_vram_gb` (e.g. `15` for Colab T4, `24` for L4/A10G). |
| `freefield_recommend_app` | Rank the best apps and preset workflows for a natural-language creative goal (e.g. *"turn a product photo into a volcano commercial"*). |
| `freefield_get_app` | Inspect the full input schema, allowed select options, presets, models, and VRAM footprint of any `app_id`. |
| `freefield_get_flow` | Inspect Higgsfield-style multi-step preset workflows (`/ugc-flow`, `/katana`, `/vox-mixed-media`, `/product-photoshoot`, `/soul-id`, `/cinema-shot`). |
| `freefield_run_app` | Universal runner for any of the 120 apps (`app_id`, `values`, `preset`, `wait`, `timeout_seconds`, `output_dir`, `include_inline_image`). |
| `freefield_generate_image` | Shortcut for image creation & editing (`create-image`, `edit`, `z-image`, `cinema-studio`, `styles`, `product-shot`, `character`, `ugc-shot`, `poster`). |
| `freefield_generate_video` | Shortcut for video generation & restyling (`video`, `video-t2v`, `cinema-video`, `mixed-media`, `effects`, `morph`, `speak`, `camera-moves`). |
| `freefield_generate_audio` | Shortcut for music (`music` via MiniMax Music 3) and sound effects (`sfx` via Stable Audio 3). |
| `freefield_get_run` | Check status, live node/step progress, and output files of a run (supports `wait_seconds` long-polling and `output_dir` export). |
| `freefield_list_history` | List recent runs from `out/history/` (shared with the Freefield Web UI). |
| `freefield_cancel_run` | Cancel a queued or running job on the GPU backend. |
| `freefield_gpu_status` | Check if the backend (Modal, Colab, or Local GPU) is warm, inspect VRAM usage, or wake a cold GPU container (`wake: true`). |

---

## 3. Higgsfield-Style Preset Flows & Slash Commands

Freefield MCP registers 6 multi-step creative workflows as **MCP Prompts** (which appear as `/command` slash commands in Claude, Cursor, and Antigravity) and via `freefield_get_flow`:

- **`/ugc-flow` (`ugc-flow`)**: *Creator & Product UGC Factory* — Places a product in a casual creator/hand shot (`ugc-shot`, `try-on`, `character`) and chains the result (`history:<run_id>`) into spoken lip-sync video (`speak`) or tactile ASMR (`asmr-product`).
- **`/katana` (`katana`)**: *Reference-Led Video Remix* — Recreates or remixes a reference video clip using `camera-copy` (copy camera motion), `recast` (swap character with SAM 3.1 + SCAIL-2), `motion-transfer` (Wan Animate 2), `reshoot` (new camera angle), or `transitions`.
- **`/vox-mixed-media` (`vox-mixed-media`)**: *Vox Editorial & Documentary Mixed Media* — Restyles footage or generated clips into tactile paper-cutout collage (`vox-collage`, `paper-cutout`, `comic-book`, `pencil-sketch`) using `mixed-media` (FLUX 3 Klein + LTX-2.5 Union Control IC-LoRA).
- **`/product-photoshoot` (`product-photoshoot`)**: *Commercial Product Studio* — Studio shots (`product-shot`), closing `packshot`, typographic `poster`, `macro-scene`, `billboard`, and motion ads (`volcano-ad`, `truck-ad`, `kick-ad`, `chameleon`).
- **`/soul-id` (`soul-id`)**: *Zero-Training Character Consistency* — Face-faithful character generation from 1 reference (`character`), 3 references (`character-3`), or a 4-frame aesthetic `photodump`.
- **`/cinema-shot` (`cinema-shot`)**: *Cinema Studio Director* — Directs film stills (`cinema-studio`) and motion (`cinema-video`) with explicit genre, era, camera body, lens glass, aperture, lighting, color palette, and up to 3 ordered camera moves.

---

## 4. File Inputs & Chaining (`history:<run_id>`)

Every file input (`image`, `video`, `audio`) in `freefield_run_app`, `freefield_generate_image`, and `freefield_generate_video` accepts:

1. **Local file path**: `"/path/to/photo.png"` or `"assets/clip.mp4"`
2. **HTTP/HTTPS URL**: `"https://example.com/product.jpg"`
3. **Data URI / Base64**: `"data:image/png;base64,iVBOR..."`
4. **Chained output from a previous Freefield run**: `"history:<run_id>"` (or `"history:<run_id>/out-01.png"`)

Every MCP run is recorded in `out/history/<run_id>/`, so assets generated from chat appear immediately in the **History** and **Library** tabs of the Freefield Web UI.
