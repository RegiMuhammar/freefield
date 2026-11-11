// Model Context Protocol (MCP) server core for Freefield.
// Exposes the 120-app catalog, Higgsfield-style preset flows (/ugc-flow, /katana, /vox-mixed-media,
// /product-photoshoot, /soul-id, /cinema-shot), file input resolution (local path, URL, base64, or
// history:<run_id> chaining), and History-backed execution over JSON-RPC 2.0 (stdio and Streamable HTTP).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { isFileInput, loadRegistry, repoRoot, type App, type Input } from "./registry.ts";
import { explainSubmitError, InputError, resolveValues, Runner, type FileValue, type Values } from "./runner.ts";
import { History, type Entry, type JobLike } from "./history.ts";

export type JsonRpcId = string | number | null;
export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};
export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type VramEntry = {
  id: string;
  whole_gb: number;
  largest_phase_gb: number;
  verdict_24gb: string;
  measured_peak_gb: number | null;
};

export type FlowStep = {
  step: number;
  title: string;
  apps: string[];
  description: string;
  example_values?: Record<string, unknown>;
};

export type PresetFlow = {
  id: string;
  command: string;
  name: string;
  higgsfield_equivalent: string;
  summary: string;
  arguments: { name: string; description: string; required?: boolean }[];
  steps: FlowStep[];
};

export const PRESET_FLOWS: PresetFlow[] = [
  {
    id: "ugc-flow",
    command: "/ugc-flow",
    name: "UGC Flow (Creator & Product Video Factory)",
    higgsfield_equivalent: "/ugc-flow, /physical-ugc-skill, /try-on-ugc-skill",
    summary: "End-to-end User Generated Content (UGC) pipeline: places a product with a creator/hand in a casual phone shot, then animates it with spoken dialogue or ASMR audio.",
    arguments: [
      { name: "product", description: "Product name, description, or local path / URL to the product photo", required: true },
      { name: "script", description: "Short spoken hook or review line for the creator to say (e.g. 'Wait until you see how this works...')" },
      { name: "setting", description: "Casual environment (e.g. bright kitchen, cafe table, sunny park, studio)" },
      { name: "style", description: "'talking' (spoken review via speak), 'asmr' (asmr-product), or 'try-on' (fashion garment try-on)" },
    ],
    steps: [
      {
        step: 1,
        title: "Create the Creator / Product Reference Frame",
        apps: ["ugc-shot", "try-on", "outfit-shot", "ai-influencer", "character"],
        description: "If starting from a product photo, run `ugc-shot` (hand holding product in a casual setting). For clothing/fashion, run `try-on` or `outfit-shot` with the model + garment photos. If you need a synthetic creator first, run `ai-influencer` or `character`.",
        example_values: { image: "<product_photo>", where: "a bright kitchen", details: "natural selfie angle" },
      },
      {
        step: 2,
        title: "Animate into a Spoken UGC Clip or ASMR Video",
        apps: ["speak", "asmr-product", "asmr-host", "video"],
        description: "Chain Step 1's output using `image: \"history:<step1_run_id>\"`. Use `speak` to voice a quoted script with lip-sync and motion in one pass (LTX-2.5), or `asmr-product` / `asmr-host` for tactile ASMR sound.",
        example_values: { image: "history:<step1_run_id>", prompt: "A creator holds the product up to the camera and smiles", line: "Honestly this changed my morning routine.", aspect: "9:16 (Portrait Widescreen)" },
      },
      {
        step: 3,
        title: "Optional Upscale or Reframe",
        apps: ["upscale-video", "reframe"],
        description: "Optionally upscale the finished clip with `upscale-video` (SeedVR2) or adapt its aspect ratio with `reframe`.",
      },
    ],
  },
  {
    id: "katana",
    command: "/katana",
    name: "Katana (Reference-Led Video Remix & Shot Recreation)",
    higgsfield_equivalent: "/katana (Higgsfield Katana MCP video editor)",
    summary: "Recreates or remixes a reference video clip using your own character, product, camera motion, or angle.",
    arguments: [
      { name: "reference_clip", description: "Path, URL, or history:<run_id> of the source/reference video clip", required: true },
      { name: "asset_image", description: "Path, URL, or history:<run_id> of the replacement character, face, or product photo" },
      { name: "mode", description: "'camera-copy' (copy camera movement), 'recast' (swap person in video), 'motion-transfer' (animate character with clip's motion), 'reshoot' (new camera angle), or 'transitions'" },
    ],
    steps: [
      {
        step: 1,
        title: "Choose the Reference-Matching Pipeline",
        apps: ["camera-copy", "recast", "motion-transfer", "reshoot", "transitions"],
        description: "Pick the app that matches the edit goal:\n- `camera-copy`: Extracts the camera move of `reference_clip` (Cameraman v2 IC-LoRA) and applies it to a new scene or image.\n- `recast`: Replaces a person inside `reference_clip` with `asset_image` (SCAIL-2 + SAM 3.1 tracking).\n- `motion-transfer`: Drives `asset_image` with the body/facial motion of `reference_clip` (Wan Animate 2).\n- `reshoot`: Reprojects `reference_clip` from a new camera angle (MiniMax H3 + MoGe + CrossView).\n- `transitions`: Bridges two reference frames (`first` and `last`) into a continuous shot.",
      },
      {
        step: 2,
        title: "Optional Color Grade, VFX, or Dubbing",
        apps: ["dub", "vfx-day-to-night", "vfx-water", "sdr-hdr", "upscale-video"],
        description: "Chain the output (`history:<step1_run_id>`) into `dub` to replace spoken dialogue while keeping the speaker's voice, or apply `vfx-day-to-night` / `upscale-video`.",
      },
    ],
  },
  {
    id: "vox-mixed-media",
    command: "/vox-mixed-media",
    name: "Vox Mixed Media (Editorial Collage & Explainer Video)",
    higgsfield_equivalent: "/vox-mixed-media, Mixed Media Studio",
    summary: "Transforms video clips or static concepts into tactile editorial collage, paper-cutout, comic, or mixed-media animations inspired by Vox explainers.",
    arguments: [
      { name: "source", description: "Video clip path/URL to restyle, OR a topic/scene description to generate from scratch", required: true },
      { name: "style", description: "Look preset in mixed-media: 'vox-collage', 'paper-cutout', 'comic-book', 'pencil-sketch', 'charcoal', 'pop-art', 'claymation', 'anime', etc." },
      { name: "details", description: "Subject and setting description to anchor the restyle" },
    ],
    steps: [
      {
        step: 1,
        title: "If Starting from Text Only: Generate Base Clip or Editorial Poster",
        apps: ["video-t2v", "poster", "mixed-media"],
        description: "If the user already has a video clip, skip to Step 2. Otherwise, generate a base motion clip with `video-t2v` (or an editorial layout with `poster` / `create-image` → `video`).",
      },
      {
        step: 2,
        title: "Apply Mixed Media Union Control Restyle",
        apps: ["mixed-media"],
        description: "Run `mixed-media` on the clip (`clip: \"history:<step1_run_id>\"` or the user's clip). FLUX 3 Klein redraws the first frame in the selected `style` (e.g. `vox-collage`, `paper-cutout`, `comic-book`, `pencil-sketch`) and LTX-2.5 Union Control IC-LoRA carries the texture across the motion.",
        example_values: { clip: "<video_clip>", style: "vox-collage", details: "archival presenter and kinetic paper cutouts", strength: 0.7 },
      },
      {
        step: 3,
        title: "Optional Ambient Audio or SFX",
        apps: ["sfx", "music"],
        description: "Generate tactile paper rustles, typewriter clicks, or lo-fi documentary background music via `sfx` or `music`.",
      },
    ],
  },
  {
    id: "product-photoshoot",
    command: "/product-photoshoot",
    name: "Product Photoshoot & Commercial Ad Suite",
    higgsfield_equivalent: "/higgsfield-product-photoshoot, Marketing Studio",
    summary: "Generates commercial studio product shots, posters, packshots, macro shots, billboards, and high-energy video ads from a single product photo.",
    arguments: [
      { name: "product_image", description: "Path, URL, or history:<run_id> of the product photo", required: true },
      { name: "mode", description: "'studio' (product-shot), 'packshot', 'poster', 'macro' (macro-scene / macro-product), 'billboard', 'ugc' (ugc-shot), 'volcano-ad', 'truck-ad', 'kick-ad', or 'chameleon'" },
      { name: "headline", description: "Optional brand headline (used in 'poster' mode)" },
    ],
    steps: [
      {
        step: 1,
        title: "Clean or Prepare Product Photo (Optional)",
        apps: ["remove-bg", "upscale"],
        description: "Optionally isolate the product with `remove-bg` or sharpen it with `upscale`.",
      },
      {
        step: 2,
        title: "Generate Commercial Still or Video Ad",
        apps: ["product-shot", "packshot", "poster", "macro-scene", "macro-product", "giant-product", "volcano-ad", "truck-ad", "kick-ad", "chameleon"],
        description: "For still photography, run `product-shot`, `packshot`, `poster`, or `macro-scene`. For motion commercials where the product stays intact while the scene transforms around it, run `volcano-ad`, `truck-ad`, `kick-ad`, or `chameleon`.",
      },
    ],
  },
  {
    id: "soul-id",
    command: "/soul-id",
    name: "Soul ID (Zero-Training Character Consistency)",
    higgsfield_equivalent: "/higgsfield-soul-id, Soul Character / Moodboard / Photodump",
    summary: "Maintains face and character identity across new scenes, outfits, and 4-frame photodumps without waiting for LoRA training.",
    arguments: [
      { name: "reference_images", description: "1 to 3 reference photos of the person (paths, URLs, or history:<run_id>)", required: true },
      { name: "scene", description: "Where and how to place the character", required: true },
      { name: "mode", description: "'single' (character), 'triple-ref' (character-3), 'photodump' (4 scenes in 1 run), 'face-swap', or 'character-swap'" },
    ],
    steps: [
      {
        step: 1,
        title: "Generate Consistent Character Stills",
        apps: ["character", "character-3", "photodump", "face-swap", "character-swap"],
        description: "Use `character` for 1 reference photo, `character-3` for 3 reference angles of the same person, or `photodump` to produce 4 distinct aesthetic frames of that person in one run.",
      },
      {
        step: 2,
        title: "Bring the Character to Life in Video",
        apps: ["video", "speak", "talking", "camera-moves"],
        description: "Pass `history:<step1_run_id>` into `speak` (for spoken dialogue), `talking` (audio-driven lip-sync), or `video` / `camera-moves` (cinematic motion).",
      },
    ],
  },
  {
    id: "cinema-shot",
    command: "/cinema-shot",
    name: "Cinema Studio Director (Still & Motion)",
    higgsfield_equivalent: "Cinema Studio 4.0 (Image & Video)",
    summary: "Directs a film shot with explicit genre, era, camera body, lens glass, focal length, aperture, lighting, color palette, and up to 3 ordered camera moves.",
    arguments: [
      { name: "scene", description: "What happens in the shot", required: true },
      { name: "medium", description: "'video' (cinema-video) or 'image' (cinema-studio)" },
      { name: "camera_moves", description: "Up to 3 camera moves (e.g. Dolly in, Pan left, Crane up, Handheld, Snorricam, Bullet time)" },
      { name: "look", description: "Genre, era, lens (e.g. Classic Anamorphic), lighting, and color palette (e.g. Teal and orange, Bleach bypass)" },
    ],
    steps: [
      {
        step: 1,
        title: "Inspect Options & Execute Cinema Studio",
        apps: ["cinema-studio", "cinema-video"],
        description: "Call `freefield_get_app` with `app_id: \"cinema-video\"` (or `\"cinema-studio\"`) to view exact option values for `moves`, `genre`, `era`, `camera`, `lens`, `focal`, `aperture`, `lighting`, and `palette`, then call `freefield_run_app`.",
      },
    ],
  },
];

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
};

export type RunnerLike = {
  readonly baseUrl: string;
  readonly token?: string;
  readonly allowDrafts: boolean;
  submit(app: App, rawValues: Values, presetId?: string): Promise<JobLike>;
};

export type McpServerOptions = {
  root?: string;
  outDir?: string;
  apps?: App[];
  history?: History;
  getRunner?: () => RunnerLike;
  getGpuStatus?: (withDevice?: boolean) => Promise<Record<string, unknown>>;
  wakeGpu?: () => void;
  canStartRun?: () => string | null;
  onRunAccepted?: () => void;
  fetch?: typeof fetch;
  allowDrafts?: boolean;
  /** Public base URL when served over HTTP (e.g. https://demo.modal.run) so output URLs are absolute. */
  publicBaseUrl?: string;
};

export class McpServer {
  readonly root: string;
  readonly apps: App[];
  readonly byId: Map<string, App>;
  readonly vram: Map<string, VramEntry>;
  readonly history: History;
  private getRunnerFn: () => RunnerLike;
  private getGpuStatusFn?: (withDevice?: boolean) => Promise<Record<string, unknown>>;
  private wakeGpuFn?: () => void;
  private canStartRunFn?: () => string | null;
  private onRunAcceptedFn?: () => void;
  private doFetch: typeof fetch;
  private allowDrafts: boolean;
  private publicBaseUrl: string;

  constructor(opts: McpServerOptions = {}) {
    this.root = opts.root ?? repoRoot();
    this.apps = opts.apps ?? loadRegistry(this.root).apps;
    this.byId = new Map(this.apps.map((a) => [a.id, a]));
    const vramFile = join(this.root, "docs", "vram-map.json");
    this.vram = new Map<string, VramEntry>(
      existsSync(vramFile)
        ? (JSON.parse(readFileSync(vramFile, "utf-8")).apps as VramEntry[]).map((r) => [r.id, r])
        : [],
    );
    this.allowDrafts = opts.allowDrafts ?? process.env.FREEFIELD_DRAFTS === "1";
    this.doFetch = opts.fetch ?? fetch;
    this.publicBaseUrl = (opts.publicBaseUrl ?? process.env.FREEFIELD_PUBLIC_URL ?? "").replace(/\/$/, "");
    let defaultRunner: Runner | null = null;
    this.getRunnerFn = opts.getRunner ?? (() => (defaultRunner ??= new Runner({ allowDrafts: this.allowDrafts, fetch: this.doFetch })));
    const outDir = opts.outDir || process.env.FREEFIELD_OUT || join(this.root, "out");
    this.history = opts.history ?? new History(join(outDir, "history"), {
      appInfo: (id) => {
        const app = this.byId.get(id);
        if (!app) return undefined;
        const graph = app.graph ?? {};
        return { outputs: app.outputs.map((o) => o.node), nodes: Object.keys(graph).length, classOf: (n) => graph[n]?.class_type ?? null };
      },
      frames: (jobId, signal) => {
        const r = this.getRunnerFn() as Runner;
        return typeof r.frames === "function" ? r.frames(jobId, signal) : (async function* () {})();
      },
    });
    this.getGpuStatusFn = opts.getGpuStatus;
    this.wakeGpuFn = opts.wakeGpu;
    this.canStartRunFn = opts.canStartRun;
    this.onRunAcceptedFn = opts.onRunAccepted;
  }

  private isRunnable(app: App): boolean {
    return Boolean(app.workflowPath) && (app.status === "ready" || this.allowDrafts);
  }

  /** Compact summary of an app for catalog listing and recommendations. */
  summarizeApp(a: App) {
    const v = this.vram.get(a.id);
    return {
      id: a.id,
      name: a.name,
      section: a.section,
      higgsfield_feature: a.higgsfield_feature ?? null,
      summary: a.summary ?? "",
      pack: a.pack,
      status: a.status,
      runnable: this.isRunnable(a),
      required_inputs: a.inputs.filter((i) => i.required || isFileInput(i)).map((i) => ({ id: i.id, type: i.type, label: i.label })),
      optional_inputs: a.inputs.filter((i) => !i.required && !isFileInput(i)).map((i) => i.id),
      presets: (a.presets ?? []).map((p) => p.id),
      outputs: a.outputs.map((o) => o.type),
      vram_largest_phase_gb: v?.largest_phase_gb ?? null,
      vram_measured_peak_gb: v?.measured_peak_gb ?? a.vram?.peak_gb ?? null,
      vram_verdict_24gb: v?.verdict_24gb ?? null,
    };
  }

  /** Full schema of an app for `freefield_get_app` and `freefield://apps/{id}`. */
  describeApp(a: App) {
    const v = this.vram.get(a.id);
    return {
      id: a.id,
      name: a.name,
      section: a.section,
      higgsfield_feature: a.higgsfield_feature ?? null,
      modes: a.modes ?? null,
      pack: a.pack,
      status: a.status,
      runnable: this.isRunnable(a),
      summary: a.summary ?? "",
      notes: a.notes ?? null,
      inputs: a.inputs.map((inp: Input) => ({
        id: inp.id,
        type: inp.type,
        label: inp.label,
        help: inp.help ?? null,
        required: Boolean(inp.required || isFileInput(inp)),
        default: inp.default ?? null,
        min: inp.min ?? null,
        max: inp.max ?? null,
        step: inp.step ?? null,
        multiple: inp.multiple ?? null,
        paint: inp.paint ?? null,
        limits: inp.limits ?? null,
        options: inp.options ? inp.options.map((o) => ({ value: o.value, label: o.label })) : undefined,
      })),
      presets: (a.presets ?? []).map((p) => ({ id: p.id, label: p.label })),
      outputs: a.outputs.map((o) => ({ type: o.type, label: o.label ?? null })),
      models: a.models.map((m) => ({
        file: m.file.split("/").pop(),
        repo: m.repo,
        gb: m.gb,
        phase: m.phase,
        license: m.license ?? null,
        gated: Boolean(m.gated),
        optional: Boolean(m.optional),
      })),
      vram: v
        ? {
            whole_gb: v.whole_gb,
            largest_phase_gb: v.largest_phase_gb,
            verdict_24gb: v.verdict_24gb,
            measured_peak_gb: v.measured_peak_gb,
          }
        : a.vram ?? null,
      example_test_values: a.test ?? null,
    };
  }

  /**
   * Resolve a file input provided to an MCP tool into `{ bytes, name, type }`:
   * - Already a `FileValue` (`{ bytes, name }`)
   * - `history:<run_id>` or `history:<run_id>/<file>` (chains output from a previous run!)
   * - `data:<mime>;base64,<data>` or `{ base64, name?, type? }`
   * - `http://` or `https://` URL
   * - Local file path (absolute or relative to `this.root`)
   */
  async resolveFileInput(inputName: string, raw: unknown): Promise<FileValue> {
    if (typeof raw === "object" && raw !== null) {
      if ((raw as FileValue).bytes instanceof Uint8Array) return raw as FileValue;
      const obj = raw as { path?: string; url?: string; base64?: string; data_base64?: string; name?: string; mime?: string; type?: string };
      if (typeof obj.base64 === "string" || typeof obj.data_base64 === "string") {
        const b64 = (obj.base64 ?? obj.data_base64)!;
        const mime = obj.mime ?? obj.type ?? "application/octet-stream";
        const ext = Object.entries(MIME_BY_EXT).find(([, m]) => m === mime)?.[0] ?? ".bin";
        return { bytes: new Uint8Array(Buffer.from(b64, "base64")), name: obj.name ?? `${inputName}${ext}`, type: mime };
      }
      if (typeof obj.path === "string") return this.resolveFileInput(inputName, obj.path);
      if (typeof obj.url === "string") return this.resolveFileInput(inputName, obj.url);
    }
    if (typeof raw !== "string" || !raw.trim()) {
      throw new InputError(`${inputName}: expected a file path, URL, data URI, or history:<run_id>`);
    }
    const str = raw.trim();

    // 1. History reference: history:<run_id> or history:<run_id>/<file> or /api/history/<run_id>/files/<file>
    const histMatch = /^history:([^/]+)(?:\/(.+))?$/.exec(str)
      ?? /^\/api\/history\/([^/]+)\/files\/(.+)$/.exec(str);
    if (histMatch) {
      const [, runId, wantedFile] = histMatch;
      const entry = this.history.get(runId);
      if (!entry) throw new InputError(`${inputName}: unknown history run "${runId}"`);
      const target = wantedFile
        ? entry.outputs.find((o) => o.file === wantedFile || o.name === wantedFile)
          ?? entry.inputs.find((i) => i.file === wantedFile || i.name === wantedFile)
        : entry.outputs[0];
      const fileName = target?.file ?? wantedFile;
      if (!fileName) throw new InputError(`${inputName}: run "${runId}" has no output files yet (status: ${entry.status})`);
      const diskPath = this.history.file(runId, fileName);
      if (!diskPath) throw new InputError(`${inputName}: file "${fileName}" not found in run "${runId}"`);
      const ext = extname(diskPath).toLowerCase();
      return {
        bytes: new Uint8Array(readFileSync(diskPath)),
        name: basename(diskPath),
        type: MIME_BY_EXT[ext] ?? "application/octet-stream",
      };
    }

    // 2. Data URI: data:image/png;base64,iVBOR...
    const dataMatch = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(str);
    if (dataMatch) {
      const mime = (dataMatch[1] || "application/octet-stream").trim();
      const ext = Object.entries(MIME_BY_EXT).find(([, m]) => m === mime)?.[0] ?? ".bin";
      return {
        bytes: new Uint8Array(Buffer.from(dataMatch[2].trim(), "base64")),
        name: `${inputName}${ext}`,
        type: mime,
      };
    }

    // 3. HTTP / HTTPS URL
    if (/^https?:\/\//i.test(str)) {
      const res = await this.doFetch(str);
      if (!res.ok) throw new InputError(`${inputName}: failed to fetch ${str} (HTTP ${res.status})`);
      const contentType = res.headers.get("content-type")?.split(";")[0].trim() || undefined;
      const urlPath = new URL(str).pathname;
      const base = basename(urlPath) || `${inputName}${Object.entries(MIME_BY_EXT).find(([, m]) => m === contentType)?.[0] ?? ".bin"}`;
      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        name: base,
        type: contentType,
      };
    }

    // 4. Local file path (or file:// URI)
    const cleanPath = str.startsWith("file://")
      ? decodeURIComponent(str.replace(/^file:\/\/\/?/, process.platform === "win32" ? "" : "/"))
      : str;
    const resolved = isAbsolute(cleanPath) ? cleanPath : resolve(this.root, cleanPath);
    if (!existsSync(resolved)) {
      throw new InputError(`${inputName}: local file not found at "${resolved}"`);
    }
    const ext = extname(resolved).toLowerCase();
    return {
      bytes: new Uint8Array(readFileSync(resolved)),
      name: basename(resolved),
      type: MIME_BY_EXT[ext] ?? "application/octet-stream",
    };
  }

  /** Convert raw tool values so file inputs become `FileValue` before `resolveValues(app, ...)`. */
  async prepareAppValues(app: App, rawValues: Record<string, unknown>): Promise<Values> {
    const out: Values = { ...rawValues };
    for (const input of app.inputs) {
      if (!isFileInput(input)) continue;
      const v = out[input.id];
      if (v === undefined || v === null || v === "") continue;
      out[input.id] = await this.resolveFileInput(input.id, v);
    }
    return resolveValues(app, out);
  }

  /** Format a History entry view with local file paths and optional copies into `outputDir`. */
  formatRunResult(entryId: string, outputDir?: string): {
    run: Record<string, unknown>;
    savedPaths: string[];
    inlineImages: { data: string; mimeType: string }[];
  } {
    const view = this.history.get(entryId);
    if (!view) throw new InputError(`unknown run "${entryId}"`);
    const savedPaths: string[] = [];
    const inlineImages: { data: string; mimeType: string }[] = [];
    if (outputDir && view.status === "succeeded") {
      const targetDir = isAbsolute(outputDir) ? outputDir : resolve(this.root, outputDir);
      mkdirSync(targetDir, { recursive: true });
      for (const o of view.outputs) {
        const src = this.history.file(view.id, o.file);
        if (!src) continue;
        const dest = join(targetDir, `${view.app}-${view.id}-${o.file}`);
        copyFileSync(src, dest);
        savedPaths.push(dest);
      }
    }
    const outputsWithPaths = view.outputs.map((o) => {
      const localPath = this.history.file(view.id, o.file);
      return {
        ...o,
        url: this.publicBaseUrl ? `${this.publicBaseUrl}${o.url}` : o.url,
        local_path: localPath,
        chain_ref: `history:${view.id}/${o.file}`,
      };
    });
    return {
      run: {
        ...view,
        chain_ref: `history:${view.id}`,
        outputs: outputsWithPaths,
        ...(savedPaths.length ? { saved_to_output_dir: savedPaths } : {}),
      },
      savedPaths,
      inlineImages,
    };
  }

  /** Execute an app, record in `History`, and optionally wait up to `timeoutSeconds`. */
  async executeApp(opts: {
    appId: string;
    rawValues: Record<string, unknown>;
    preset?: string;
    wait?: boolean;
    timeoutSeconds?: number;
    outputDir?: string;
    includeInlineImage?: boolean;
  }) {
    const app = this.byId.get(opts.appId);
    if (!app) throw new InputError(`unknown app "${opts.appId}". Call freefield_list_apps or freefield_recommend_app first.`);
    if (!app.workflowPath) throw new InputError(`${app.id} has no workflow yet`);
    if (!this.isRunnable(app)) {
      throw new InputError(`${app.id} is a draft; set FREEFIELD_DRAFTS=1 to allow running draft apps`);
    }
    const refused = this.canStartRunFn?.() ?? null;
    if (refused) throw new InputError(refused);

    const values = await this.prepareAppValues(app, opts.rawValues);
    const entry = this.history.start(app, values, opts.preset);
    this.onRunAcceptedFn?.();

    const runPromise = (async () => {
      try {
        const job = await this.getRunnerFn().submit(app, values, opts.preset);
        await this.history.follow(entry, job);
      } catch (e) {
        const explained = explainSubmitError(app, e);
        const message = explained ?? (e as Error).message ?? String(e);
        this.history.fail(entry, message);
      }
    })();

    const shouldWait = opts.wait !== false;
    const timeoutMs = Math.max(1, (opts.timeoutSeconds ?? 180) * 1000);
    if (shouldWait) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          runPromise,
          new Promise<void>((r) => {
            timer = setTimeout(r, timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    const formatted = this.formatRunResult(entry.id, opts.outputDir);
    if (opts.includeInlineImage && formatted.run.status === "succeeded") {
      for (const o of entry.outputs) {
        if (o.type !== "image") continue;
        const diskPath = this.history.file(entry.id, o.file);
        if (!diskPath) continue;
        const bytes = readFileSync(diskPath);
        if (bytes.byteLength <= 5 * 1024 * 1024) {
          const ext = extname(diskPath).toLowerCase();
          formatted.inlineImages.push({
            data: bytes.toString("base64"),
            mimeType: MIME_BY_EXT[ext] ?? "image/png",
          });
        }
      }
    }
    return formatted;
  }

  /** Wait up to `waitSeconds` for an active run to reach a terminal status. */
  async waitForRun(runId: string, waitSeconds = 0): Promise<void> {
    if (waitSeconds <= 0) return;
    const deadline = Date.now() + waitSeconds * 1000;
    const terminal = new Set(["succeeded", "failed", "canceled", "expired", "lost"]);
    while (Date.now() < deadline) {
      const cur = this.history.get(runId);
      if (!cur || terminal.has(cur.status)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Recommend the best matching apps and preset flows for a creative goal. */
  recommendApps(params: {
    goal: string;
    section?: string;
    has_image?: boolean;
    has_video?: boolean;
    has_audio?: boolean;
    max_vram_gb?: number;
    limit?: number;
  }) {
    const q = (params.goal || "").toLowerCase();
    const words = q.split(/[^a-z0-9-]+/).filter((w) => w.length >= 2);
    const scored = this.apps
      .filter((a) => this.isRunnable(a))
      .filter((a) => !params.section || a.section === params.section)
      .filter((a) => {
        if (!params.max_vram_gb) return true;
        const v = this.vram.get(a.id)?.largest_phase_gb;
        return v === undefined || v <= params.max_vram_gb;
      })
      .map((a) => {
        let score = 0;
        const idText = a.id.toLowerCase();
        const nameText = a.name.toLowerCase();
        const hfText = (a.higgsfield_feature ?? "").toLowerCase();
        const sumText = (a.summary ?? "").toLowerCase();
        const haystack = `${idText} ${nameText} ${hfText} ${sumText} ${a.section} ${a.pack}`;

        if (q.includes(idText)) score += 30;
        if (hfText && q.includes(hfText)) score += 25;
        for (const w of words) {
          if (idText === w || idText.split("-").includes(w)) score += 12;
          if (nameText.includes(w)) score += 8;
          if (hfText.includes(w)) score += 8;
          if (sumText.includes(w)) score += 4;
          else if (haystack.includes(w)) score += 2;
        }

        const needsImg = a.inputs.some((i) => i.type === "image");
        const needsVid = a.inputs.some((i) => i.type === "video");
        const needsAud = a.inputs.some((i) => i.type === "audio");
        if (params.has_image === true && needsImg) score += 6;
        if (params.has_image === false && needsImg) score -= 8;
        if (params.has_video === true && needsVid) score += 8;
        if (params.has_video === false && needsVid) score -= 10;
        if (params.has_audio === true && needsAud) score += 8;

        // Boost flagship base apps when general terms appear
        if ((/\b(image|photo|picture|draw|generate)\b/.test(q)) && a.id === "create-image") score += 10;
        if ((/\b(video|clip|animate|motion)\b/.test(q)) && (a.id === "video" || a.id === "video-t2v" || a.id === "cinema-video")) score += 8;
        if ((/\b(ugc|tiktok|reel|review|unbox|influencer)\b/.test(q)) && ["ugc-shot", "speak", "ai-influencer", "try-on"].includes(a.id)) score += 12;
        if ((/\b(katana|remix|copy camera|swap character|recast)\b/.test(q)) && ["camera-copy", "recast", "motion-transfer", "reshoot"].includes(a.id)) score += 14;
        if ((/\b(vox|collage|explainer|mixed media|cutout|documentary)\b/.test(q)) && a.id === "mixed-media") score += 18;
        if ((/\b(music|song|soundtrack|beat)\b/.test(q)) && a.id === "music") score += 15;
        if ((/\b(sfx|sound effect|foley)\b/.test(q)) && a.id === "sfx") score += 15;

        return { app: a, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.app.id.localeCompare(b.app.id))
      .slice(0, params.limit ?? 6)
      .map((x) => ({ score: x.score, ...this.summarizeApp(x.app) }));

    const matchingFlows = PRESET_FLOWS.filter((f) => {
      const fText = `${f.id} ${f.name} ${f.higgsfield_equivalent} ${f.summary}`.toLowerCase();
      return words.some((w) => fText.includes(w));
    }).map((f) => ({ id: f.id, command: f.command, name: f.name, summary: f.summary }));

    return { recommended_apps: scored, matching_preset_flows: matchingFlows };
  }

  /** List all MCP tool definitions. */
  listTools() {
    return [
      {
        name: "freefield_list_apps",
        description: "List and filter Freefield's 120 open-weights creative apps (image, video, audio, VFX, utility) with their required inputs, outputs, model packs, and VRAM requirements.",
        inputSchema: {
          type: "object",
          properties: {
            section: { type: "string", enum: ["image", "video", "audio", "utility"], description: "Filter by studio section." },
            search: { type: "string", description: "Case-insensitive keyword filter against app id, name, Higgsfield feature, and summary." },
            pack: { type: "string", description: "Filter by model pack (e.g. 'image-flux3', 'video-ltx25', 'video-wan-effects', 'audio')." },
            max_vram_gb: { type: "number", description: "Only return apps whose largest phase fits within this VRAM budget in GB (e.g. 15 for Colab T4, 24 for L4/A10G/3090)." },
          },
        },
      },
      {
        name: "freefield_recommend_app",
        description: "Recommend the best Freefield apps and Higgsfield-style multi-step preset flows (/ugc-flow, /katana, /vox-mixed-media, /product-photoshoot, /soul-id, /cinema-shot) for a natural-language creative goal.",
        inputSchema: {
          type: "object",
          required: ["goal"],
          properties: {
            goal: { type: "string", description: "What the user wants to create or edit (e.g. 'turn a product photo into a volcano commercial', 'make a Vox-style paper collage explainer', 'lip-sync dialogue on a portrait')." },
            section: { type: "string", enum: ["image", "video", "audio", "utility"] },
            has_image: { type: "boolean", description: "True if you have a reference image to pass in." },
            has_video: { type: "boolean", description: "True if you have a reference video clip to pass in." },
            has_audio: { type: "boolean", description: "True if you have a reference audio file to pass in." },
            max_vram_gb: { type: "number", description: "Optional VRAM limit in GB." },
            limit: { type: "number", description: "Max apps to return (default 6)." },
          },
        },
      },
      {
        name: "freefield_get_app",
        description: "Get the complete input schema, allowed select options, presets, models, VRAM profile, and example values for a specific Freefield app before calling freefield_run_app.",
        inputSchema: {
          type: "object",
          required: ["app_id"],
          properties: {
            app_id: { type: "string", description: "The app id (e.g. 'create-image', 'cinema-video', 'effects', 'mixed-media', 'speak', 'ugc-shot')." },
          },
        },
      },
      {
        name: "freefield_get_flow",
        description: "Get Higgsfield-style preset workflows and multi-step agent pipelines (/ugc-flow, /katana, /vox-mixed-media, /product-photoshoot, /soul-id, /cinema-shot). Omit flow_id to list all available preset flows.",
        inputSchema: {
          type: "object",
          properties: {
            flow_id: {
              type: "string",
              enum: ["ugc-flow", "katana", "vox-mixed-media", "product-photoshoot", "soul-id", "cinema-shot"],
              description: "Specific preset flow to inspect. Omit to list all flows.",
            },
          },
        },
      },
      {
        name: "freefield_run_app",
        description: "Run any of Freefield's 120 apps on the ComfyUI GPU backend. File inputs (image, video, audio) accept a local file path, an http(s) URL, a data:...;base64 URI, or 'history:<run_id>' to chain the output of a previous run.",
        inputSchema: {
          type: "object",
          required: ["app_id"],
          properties: {
            app_id: { type: "string", description: "App id to execute (e.g. 'create-image', 'edit', 'cinema-video', 'mixed-media', 'effects', 'morph', 'speak', 'music', 'upscale')." },
            values: {
              type: "object",
              description: "Input key-value pairs matching the app's inputs in freefield_get_app. Omitted inputs use their defaults.",
              additionalProperties: true,
            },
            preset: { type: "string", description: "Optional preset id if the app defines presets (e.g. 'fast' on 'effects' or 'camera-moves')." },
            wait: { type: "boolean", description: "Wait for the GPU run to finish before returning (default: true). Set false to start asynchronously and poll with freefield_get_run." },
            timeout_seconds: { type: "number", description: "Max seconds to wait when wait=true (default: 180). If the run is still going after this, returns status='running' and the run_id so you can poll freefield_get_run." },
            output_dir: { type: "string", description: "Optional local directory path to copy generated files into once the run succeeds." },
            include_inline_image: { type: "boolean", description: "When true, includes base64 image content blocks in the MCP response for generated images." },
          },
        },
      },
      {
        name: "freefield_generate_image",
        description: "High-level shortcut to generate or edit an image using Freefield (defaults to 'create-image' with FLUX 3 Image Klein, or 'edit' when an image is provided).",
        inputSchema: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string", description: "Prompt describing the image to create, or edit instruction when editing." },
            app_id: { type: "string", description: "Image app id (default: 'create-image', or 'edit' if image is given; also supports 'z-image', 'cinema-studio', 'styles', 'product-shot', 'character', 'ugc-shot', 'poster', 'packshot')." },
            image: { type: "string", description: "Optional reference image (local path, URL, data URI, or 'history:<run_id>')." },
            aspect: { type: "string", description: "Aspect ratio for create-image / cinema-studio (e.g. '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9')." },
            resolution: { type: "number", enum: [1, 1.5, 2], description: "Resolution multiplier for create-image / cinema-studio (1 = 1K, 1.5 = 1.5K, 2 = 2K)." },
            look: { type: "string", description: "Optional photographic look for create-image (e.g. 'Flash editorial', 'Black and white film', 'Street photography')." },
            expand: { type: "boolean", description: "Toggle the 9B prompt upsampler in create-image (default: true)." },
            seed: { type: "number", description: "Seed (-1 for random)." },
            extra_values: { type: "object", description: "Additional app-specific inputs.", additionalProperties: true },
            wait: { type: "boolean", description: "Wait for completion (default: true)." },
            timeout_seconds: { type: "number", description: "Max wait time in seconds (default: 180)." },
            output_dir: { type: "string", description: "Optional local folder to save generated image(s)." },
            include_inline_image: { type: "boolean", description: "Return base64 image preview inline (default: false)." },
          },
        },
      },
      {
        name: "freefield_generate_video",
        description: "High-level shortcut to generate or restyle a video clip using Freefield (defaults to 'video' image-to-video when an image is provided, or 'video-t2v' text-to-video).",
        inputSchema: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string", description: "Scene, action, or motion description." },
            app_id: { type: "string", description: "Video app id (default: 'video' with image, 'video-t2v' without image; also supports 'cinema-video', 'effects', 'mixed-media', 'morph', 'speak', 'camera-moves')." },
            image: { type: "string", description: "Optional first-frame or reference image (local path, URL, data URI, or 'history:<run_id>')." },
            clip: { type: "string", description: "Optional input video clip for video-to-video apps like 'mixed-media', 'camera-copy', 'dub', 'upscale-video'." },
            aspect: { type: "string", description: "Aspect ratio (e.g. '16:9 (Widescreen)', '9:16 (Portrait Widescreen)', '1:1 (Square)')." },
            duration: { type: "number", description: "Video duration in seconds (2 to 10)." },
            seed: { type: "number", description: "Seed (-1 for random)." },
             preset: { type: "string", description: "Optional preset (e.g. 'fast')." },
            extra_values: { type: "object", description: "Additional app-specific inputs (e.g. 'effect', 'style', 'moves', 'line').", additionalProperties: true },
            wait: { type: "boolean", description: "Wait for completion (default: true)." },
            timeout_seconds: { type: "number", description: "Max wait time in seconds (default: 180)." },
            output_dir: { type: "string", description: "Optional local folder to save the generated video." },
          },
        },
      },
      {
        name: "freefield_generate_audio",
        description: "Generate a music track ('music' via MiniMax Music 3) or sound effect ('sfx' via Stable Audio 3 medium).",
        inputSchema: {
          type: "object",
          required: ["prompt"],
          properties: {
            kind: { type: "string", enum: ["music", "sfx"], description: "'music' (full song with optional lyrics) or 'sfx' (sound effect / ambient audio). Default: 'music'." },
            prompt: { type: "string", description: "Musical style/mood (for music) or sound description (for sfx)." },
            lyrics: { type: "string", description: "Optional lyrics with [Verse], [Chorus] tags (for 'music')." },
            seconds: { type: "number", description: "Duration in seconds." },
            seed: { type: "number", description: "Seed (-1 for random)." },
            wait: { type: "boolean", description: "Wait for completion (default: true)." },
            timeout_seconds: { type: "number", description: "Max wait time in seconds (default: 180)." },
            output_dir: { type: "string", description: "Optional local folder to save the generated audio." },
          },
        },
      },
      {
        name: "freefield_get_run",
        description: "Check the status, live progress (node & sampler step), timings, and output files of a run by run_id. Can optionally wait/poll up to wait_seconds and copy finished outputs to output_dir.",
        inputSchema: {
          type: "object",
          required: ["run_id"],
          properties: {
            run_id: { type: "string", description: "The run id returned by freefield_run_app / freefield_generate_* (or 'history:<run_id>')." },
            wait_seconds: { type: "number", description: "Optional seconds to wait for a running job to finish before returning (e.g. 60)." },
            output_dir: { type: "string", description: "Optional local directory to copy output files into if the run succeeded." },
          },
        },
      },
      {
        name: "freefield_list_history",
        description: "List recent generation runs recorded in Freefield's History (shared with the Web UI), newest first.",
        inputSchema: {
          type: "object",
          properties: {
            app_id: { type: "string", description: "Filter by app id." },
            limit: { type: "number", description: "Max entries to return (default: 20, max: 100)." },
          },
        },
      },
      {
        name: "freefield_cancel_run",
        description: "Cancel a queued or running Freefield job on the GPU backend.",
        inputSchema: {
          type: "object",
          required: ["run_id"],
          properties: {
            run_id: { type: "string", description: "The run id to cancel." },
          },
        },
      },
      {
        name: "freefield_gpu_status",
        description: "Check the ComfyUI GPU backend status (Modal, Google Colab, or Local GPU): whether it is configured, warm, active runs, VRAM usage, loaded app in the gateway pantry, and optionally wake a cold GPU container.",
        inputSchema: {
          type: "object",
          properties: {
            device: { type: "boolean", description: "When true and the GPU is warm, queries /freefield/status for live GPU device name and VRAM usage." },
            wake: { type: "boolean", description: "When true, sends a wake request (/health?wake=1) to start a cold GPU container in the background." },
          },
        },
      },
    ];
  }

  /** Execute an MCP tool call and return `{ content, isError? }`. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{
    content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
    isError?: boolean;
  }> {
    try {
      switch (name) {
        case "freefield_list_apps": {
          const section = typeof args.section === "string" ? args.section : undefined;
          const search = typeof args.search === "string" ? args.search.trim().toLowerCase() : "";
          const pack = typeof args.pack === "string" ? args.pack.trim() : undefined;
          const maxVram = typeof args.max_vram_gb === "number" ? args.max_vram_gb : undefined;
          const matched = this.apps
            .filter((a) => !section || a.section === section)
            .filter((a) => !pack || a.pack === pack)
            .filter((a) => {
              if (!search) return true;
              const hay = `${a.id} ${a.name} ${a.higgsfield_feature ?? ""} ${a.summary ?? ""} ${a.pack}`.toLowerCase();
              return hay.includes(search);
            })
            .filter((a) => {
              if (maxVram === undefined) return true;
              const v = this.vram.get(a.id)?.largest_phase_gb;
              return v === undefined || v <= maxVram;
            })
            .map((a) => this.summarizeApp(a));
          return this.jsonText({ count: matched.length, apps: matched });
        }

        case "freefield_recommend_app": {
          const goal = String(args.goal ?? "");
          if (!goal.trim()) throw new InputError("goal: required");
          const res = this.recommendApps({
            goal,
            section: typeof args.section === "string" ? args.section : undefined,
            has_image: typeof args.has_image === "boolean" ? args.has_image : undefined,
            has_video: typeof args.has_video === "boolean" ? args.has_video : undefined,
            has_audio: typeof args.has_audio === "boolean" ? args.has_audio : undefined,
            max_vram_gb: typeof args.max_vram_gb === "number" ? args.max_vram_gb : undefined,
            limit: typeof args.limit === "number" ? args.limit : 6,
          });
          return this.jsonText(res);
        }

        case "freefield_get_app": {
          const appId = String(args.app_id ?? "").trim();
          const app = this.byId.get(appId);
          if (!app) throw new InputError(`unknown app "${appId}". Use freefield_list_apps to browse available ids.`);
          return this.jsonText(this.describeApp(app));
        }

        case "freefield_get_flow": {
          const flowId = typeof args.flow_id === "string" ? args.flow_id.replace(/^\//, "").trim() : "";
          if (!flowId) {
            return this.jsonText({
              flows: PRESET_FLOWS.map((f) => ({
                id: f.id,
                command: f.command,
                name: f.name,
                higgsfield_equivalent: f.higgsfield_equivalent,
                summary: f.summary,
              })),
            });
          }
          const flow = PRESET_FLOWS.find((f) => f.id === flowId || f.command === `/${flowId}`);
          if (!flow) throw new InputError(`unknown flow "${flowId}". Available: ${PRESET_FLOWS.map((f) => f.id).join(", ")}`);
          return this.jsonText(flow);
        }

        case "freefield_run_app": {
          const appId = String(args.app_id ?? "").trim();
          const rawValues = (typeof args.values === "object" && args.values !== null ? args.values : {}) as Record<string, unknown>;
          const res = await this.executeApp({
            appId,
            rawValues,
            preset: typeof args.preset === "string" && args.preset ? args.preset : undefined,
            wait: typeof args.wait === "boolean" ? args.wait : true,
            timeoutSeconds: typeof args.timeout_seconds === "number" ? args.timeout_seconds : 180,
            outputDir: typeof args.output_dir === "string" && args.output_dir ? args.output_dir : undefined,
            includeInlineImage: Boolean(args.include_inline_image),
          });
          return this.formatToolOutput(res);
        }

        case "freefield_generate_image": {
          const prompt = String(args.prompt ?? "").trim();
          if (!prompt) throw new InputError("prompt: required");
          const hasImage = args.image !== undefined && args.image !== null && args.image !== "";
          const appId = typeof args.app_id === "string" && args.app_id.trim()
            ? args.app_id.trim()
            : (hasImage ? "edit" : "create-image");
          const app = this.byId.get(appId);
          if (!app) throw new InputError(`unknown app "${appId}"`);
          const rawValues: Record<string, unknown> = {
            ...(typeof args.extra_values === "object" && args.extra_values !== null ? args.extra_values as Record<string, unknown> : {}),
          };
          // Map prompt to whichever text input the chosen image app uses
          if (app.inputs.some((i) => i.id === "prompt")) rawValues.prompt = prompt;
          else if (app.inputs.some((i) => i.id === "instruction")) rawValues.instruction = prompt;
          else if (app.inputs.some((i) => i.id === "scene")) rawValues.scene = prompt;
          else if (app.inputs.some((i) => i.id === "details")) rawValues.details = prompt;

          if (hasImage) {
            const firstImg = app.inputs.find((i) => i.type === "image");
            if (firstImg) rawValues[firstImg.id] = args.image;
          }
          if (typeof args.aspect === "string" && app.inputs.some((i) => i.id === "aspect")) {
            const lookInput = app.inputs.find((i) => i.id === "aspect")!;
            const hit = lookInput.options?.find((o) => o.value === args.aspect || o.label === args.aspect);
            rawValues.aspect = hit ? hit.value : args.aspect;
          }
          if (typeof args.resolution === "number" && app.inputs.some((i) => i.id === "resolution")) {
            rawValues.resolution = args.resolution;
          }
          if (typeof args.look === "string" && app.inputs.some((i) => i.id === "look")) {
            const lookInput = app.inputs.find((i) => i.id === "look")!;
            const hit = lookInput.options?.find((o) => o.value === args.look || o.label.toLowerCase() === String(args.look).toLowerCase());
            rawValues.look = hit ? hit.value : args.look;
          }
          if (typeof args.expand === "boolean" && app.inputs.some((i) => i.id === "expand")) {
            rawValues.expand = args.expand;
          }
          if (typeof args.seed === "number") rawValues.seed = args.seed;

          const res = await this.executeApp({
            appId,
            rawValues,
            wait: typeof args.wait === "boolean" ? args.wait : true,
            timeoutSeconds: typeof args.timeout_seconds === "number" ? args.timeout_seconds : 180,
            outputDir: typeof args.output_dir === "string" && args.output_dir ? args.output_dir : undefined,
            includeInlineImage: Boolean(args.include_inline_image),
          });
          return this.formatToolOutput(res);
        }

        case "freefield_generate_video": {
          const prompt = String(args.prompt ?? "").trim();
          const hasImage = args.image !== undefined && args.image !== null && args.image !== "";
          const hasClip = args.clip !== undefined && args.clip !== null && args.clip !== "";
          const appId = typeof args.app_id === "string" && args.app_id.trim()
            ? args.app_id.trim()
            : (hasClip ? "mixed-media" : hasImage ? "video" : "video-t2v");
          const app = this.byId.get(appId);
          if (!app) throw new InputError(`unknown app "${appId}"`);
          const rawValues: Record<string, unknown> = {
            ...(typeof args.extra_values === "object" && args.extra_values !== null ? args.extra_values as Record<string, unknown> : {}),
          };
          if (prompt) {
            if (app.inputs.some((i) => i.id === "prompt")) rawValues.prompt = prompt;
            else if (app.inputs.some((i) => i.id === "subject") && rawValues.subject === undefined) rawValues.subject = prompt;
            else if (app.inputs.some((i) => i.id === "details") && rawValues.details === undefined) rawValues.details = prompt;
          }
          if (hasImage) {
            const firstImg = app.inputs.find((i) => i.type === "image");
            if (firstImg) rawValues[firstImg.id] = args.image;
          }
          if (hasClip) {
            const firstVid = app.inputs.find((i) => i.type === "video");
            if (firstVid) rawValues[firstVid.id] = args.clip;
          }
          if (typeof args.aspect === "string" && app.inputs.some((i) => i.id === "aspect")) {
            const asp = app.inputs.find((i) => i.id === "aspect")!;
            const hit = asp.options?.find((o) => o.value === args.aspect || o.label === args.aspect || String(o.value).startsWith(String(args.aspect)));
            rawValues.aspect = hit ? hit.value : args.aspect;
          }
          if (typeof args.duration === "number" && app.inputs.some((i) => i.id === "duration")) {
            rawValues.duration = args.duration;
          }
          if (typeof args.seed === "number") rawValues.seed = args.seed;

          const res = await this.executeApp({
            appId,
            rawValues,
            preset: typeof args.preset === "string" && args.preset ? args.preset : undefined,
            wait: typeof args.wait === "boolean" ? args.wait : true,
            timeoutSeconds: typeof args.timeout_seconds === "number" ? args.timeout_seconds : 180,
            outputDir: typeof args.output_dir === "string" && args.output_dir ? args.output_dir : undefined,
          });
          return this.formatToolOutput(res);
        }

        case "freefield_generate_audio": {
          const kind = args.kind === "sfx" ? "sfx" : "music";
          const prompt = String(args.prompt ?? "").trim();
          if (!prompt) throw new InputError("prompt: required");
          const rawValues: Record<string, unknown> = { prompt };
          if (kind === "music" && typeof args.lyrics === "string") rawValues.lyrics = args.lyrics;
          if (typeof args.seconds === "number") rawValues.seconds = args.seconds;
          if (typeof args.seed === "number") rawValues.seed = args.seed;
          const res = await this.executeApp({
            appId: kind,
            rawValues,
            wait: typeof args.wait === "boolean" ? args.wait : true,
            timeoutSeconds: typeof args.timeout_seconds === "number" ? args.timeout_seconds : 180,
            outputDir: typeof args.output_dir === "string" && args.output_dir ? args.output_dir : undefined,
          });
          return this.formatToolOutput(res);
        }

        case "freefield_get_run": {
          const runId = String(args.run_id ?? "").replace(/^history:/, "").split("/")[0].trim();
          if (!runId) throw new InputError("run_id: required");
          const waitSec = typeof args.wait_seconds === "number" ? Math.min(300, Math.max(0, args.wait_seconds)) : 0;
          if (waitSec > 0) await this.waitForRun(runId, waitSec);
          const outputDir = typeof args.output_dir === "string" && args.output_dir ? args.output_dir : undefined;
          const res = this.formatRunResult(runId, outputDir);
          return this.formatToolOutput(res);
        }

        case "freefield_list_history": {
          const appId = typeof args.app_id === "string" && args.app_id.trim() ? args.app_id.trim() : undefined;
          const limit = typeof args.limit === "number" ? Math.min(100, Math.max(1, args.limit)) : 20;
          const entries = this.history.list(appId, limit).map((e) => ({
            ...e,
            chain_ref: `history:${e.id}`,
            outputs: e.outputs.map((o) => ({
              ...o,
              url: this.publicBaseUrl ? `${this.publicBaseUrl}${o.url}` : o.url,
              local_path: this.history.file(e.id, o.file),
              chain_ref: `history:${e.id}/${o.file}`,
            })),
          }));
          return this.jsonText({ count: entries.length, entries });
        }

        case "freefield_cancel_run": {
          const runId = String(args.run_id ?? "").replace(/^history:/, "").split("/")[0].trim();
          if (!runId) throw new InputError("run_id: required");
          const canceled = await this.history.cancel(runId);
          return this.jsonText({ run_id: runId, canceled });
        }

        case "freefield_gpu_status": {
          const wantDevice = Boolean(args.device);
          const wantWake = Boolean(args.wake);
          if (wantWake) {
            if (this.wakeGpuFn) {
              this.wakeGpuFn();
            } else {
              const r = this.getRunnerFn();
              void this.doFetch(`${r.baseUrl}/health?wake=1`, { signal: AbortSignal.timeout(15 * 60 * 1000) }).catch(() => {});
            }
          }
          if (this.getGpuStatusFn) {
            return this.jsonText(await this.getGpuStatusFn(wantDevice));
          }
          const configured = Boolean(process.env.COMFY_BASE_URL);
          if (!configured) {
            return this.jsonText({ configured: false, host: null, device: null });
          }
          const r = this.getRunnerFn();
          const host = new URL(r.baseUrl).host;
          let device: unknown = null;
          if (wantDevice) {
            try {
              const res = await this.doFetch(`${r.baseUrl}/freefield/status`, {
                headers: r.token ? { authorization: `Bearer ${r.token}` } : {},
                signal: AbortSignal.timeout(5000),
              });
              if (res.ok) device = await res.json();
            } catch {
              /* status is best-effort */
            }
          }
          return this.jsonText({ configured: true, host, woke: wantWake, device });
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool "${name}"` }],
            isError: true,
          };
      }
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message ?? String(e) }],
        isError: true,
      };
    }
  }

  private formatToolOutput(res: { run: Record<string, unknown>; inlineImages: { data: string; mimeType: string }[] }) {
    const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
      { type: "text", text: JSON.stringify(res.run, null, 2) },
    ];
    for (const img of res.inlineImages) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    return {
      content,
      ...(res.run.status === "failed" ? { isError: true } : {}),
    };
  }

  private jsonText(data: unknown): { content: [{ type: "text"; text: string }] } {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }

  /** List static MCP resources. */
  listResources() {
    return [
      {
        uri: "freefield://catalog/apps",
        name: "Freefield Apps Catalog",
        description: "Summary of all 120 open-weights creative apps in Freefield (image, video, audio, utility).",
        mimeType: "application/json",
      },
      {
        uri: "freefield://catalog/flows",
        name: "Freefield Higgsfield-Style Preset Flows",
        description: "Multi-step preset workflows (/ugc-flow, /katana, /vox-mixed-media, /product-photoshoot, /soul-id, /cinema-shot).",
        mimeType: "application/json",
      },
      {
        uri: "freefield://catalog/packs",
        name: "Freefield Model Packs",
        description: "Model packs (packs/index.json) grouping apps that share base weights.",
        mimeType: "application/json",
      },
      {
        uri: "freefield://catalog/vram",
        name: "Freefield VRAM Map",
        description: "VRAM footprint per app (whole weights, largest phase, 24 GB verdict, and measured GPU peak).",
        mimeType: "application/json",
      },
    ];
  }

  /** List parameterized MCP resource templates. */
  listResourceTemplates() {
    return [
      {
        uriTemplate: "freefield://apps/{id}",
        name: "Freefield App Manifest & Schema",
        description: "Full input schema, select options, presets, models, and example values for a specific app id.",
        mimeType: "application/json",
      },
    ];
  }

  /** Read a resource by URI. */
  readResource(uri: string) {
    if (uri === "freefield://catalog/apps") {
      return [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(this.apps.map((a) => this.summarizeApp(a)), null, 2),
      }];
    }
    if (uri === "freefield://catalog/flows") {
      return [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(PRESET_FLOWS, null, 2),
      }];
    }
    if (uri === "freefield://catalog/packs") {
      const packsPath = join(this.root, "packs", "index.json");
      const text = existsSync(packsPath) ? readFileSync(packsPath, "utf-8") : "{}";
      return [{ uri, mimeType: "application/json", text }];
    }
    if (uri === "freefield://catalog/vram") {
      const vramPath = join(this.root, "docs", "vram-map.json");
      const text = existsSync(vramPath) ? readFileSync(vramPath, "utf-8") : "{}";
      return [{ uri, mimeType: "application/json", text }];
    }
    const appMatch = /^freefield:\/\/apps\/([a-z0-9-]+)$/.exec(uri);
    if (appMatch) {
      const app = this.byId.get(appMatch[1]);
      if (!app) throw new InputError(`unknown app "${appMatch[1]}"`);
      return [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(this.describeApp(app), null, 2),
      }];
    }
    throw new InputError(`unknown resource URI "${uri}"`);
  }

  /** List MCP prompts (rendered as slash commands like /ugc-flow, /katana, /vox-mixed-media in MCP clients). */
  listPrompts() {
    return PRESET_FLOWS.map((f) => ({
      name: f.id,
      description: `${f.name} — ${f.summary}`,
      arguments: f.arguments.map((a) => ({
        name: a.name,
        description: a.description,
        required: Boolean(a.required),
      })),
    }));
  }

  /** Build a structured prompt message sequence for one of the preset flows. */
  getPrompt(name: string, args: Record<string, string> = {}) {
    const clean = name.replace(/^\//, "");
    const flow = PRESET_FLOWS.find((f) => f.id === clean);
    if (!flow) throw new InputError(`unknown prompt "${name}". Available: ${PRESET_FLOWS.map((f) => f.id).join(", ")}`);
    const argLines = Object.entries(args)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `- **${k}**: ${v}`)
      .join("\n");
    const stepsText = flow.steps
      .map((s) => `${s.step}. **${s.title}** (Apps: ${s.apps.map((a) => `\`${a}\``).join(", ")})\n   ${s.description}${s.example_values ? `\n   Example inputs: \`${JSON.stringify(s.example_values)}\`` : ""}`)
      .join("\n\n");
    return {
      description: flow.summary,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Execute the **${flow.name}** (${flow.command}) preset workflow using the Freefield MCP tools.\n\n` +
              (argLines ? `### User Inputs\n${argLines}\n\n` : "") +
              `### Pipeline Steps\n${stepsText}\n\n` +
              `Inspect any app's exact options first with \`freefield_get_app\`, run each step with \`freefield_run_app\`, and chain outputs between steps using \`history:<run_id>\`.`,
          },
        },
      ],
    };
  }

  /** Handle a single JSON-RPC 2.0 request or notification. Returns `null` for notifications. */
  async handleMessage(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
      return {
        jsonrpc: "2.0",
        id: (msg as { id?: JsonRpcId })?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      };
    }
    const isNotification = msg.id === undefined;
    const id = msg.id ?? null;
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;

    try {
      switch (msg.method) {
        case "initialize": {
          const clientVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
          const supported = ["2024-11-05", "2025-03-26", "2025-06-18"];
          const protocolVersion = supported.includes(clientVersion) ? clientVersion : "2024-11-05";
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion,
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                prompts: { listChanged: false },
              },
              serverInfo: {
                name: "freefield-mcp",
                version: "0.1.0",
              },
              instructions:
                "Freefield MCP server: 120 open-weights image, video, VFX, and audio apps built on ComfyUI. " +
                "Use freefield_recommend_app or freefield_list_apps to find the right app, freefield_get_app to inspect its inputs and select options, " +
                "freefield_get_flow for multi-step presets (/ugc-flow, /katana, /vox-mixed-media, /product-photoshoot, /soul-id, /cinema-shot), " +
                "and freefield_run_app (or freefield_generate_image / freefield_generate_video / freefield_generate_audio) to generate assets. " +
                "Chain outputs across apps by passing 'history:<run_id>' as the file input of the next app.",
            },
          };
        }

        case "notifications/initialized":
        case "notifications/cancelled":
          return null;

        case "ping":
          return { jsonrpc: "2.0", id, result: {} };

        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: this.listTools() } };

        case "tools/call": {
          const toolName = String(params.name ?? "");
          const toolArgs = (typeof params.arguments === "object" && params.arguments !== null
            ? params.arguments
            : {}) as Record<string, unknown>;
          const result = await this.callTool(toolName, toolArgs);
          return { jsonrpc: "2.0", id, result };
        }

        case "resources/list":
          return { jsonrpc: "2.0", id, result: { resources: this.listResources() } };

        case "resources/templates/list":
          return { jsonrpc: "2.0", id, result: { resourceTemplates: this.listResourceTemplates() } };

        case "resources/read": {
          const uri = String(params.uri ?? "");
          const contents = this.readResource(uri);
          return { jsonrpc: "2.0", id, result: { contents } };
        }

        case "prompts/list":
          return { jsonrpc: "2.0", id, result: { prompts: this.listPrompts() } };

        case "prompts/get": {
          const promptName = String(params.name ?? "");
          const promptArgs = (typeof params.arguments === "object" && params.arguments !== null
            ? params.arguments
            : {}) as Record<string, string>;
          const result = this.getPrompt(promptName, promptArgs);
          return { jsonrpc: "2.0", id, result };
        }

        default:
          if (isNotification || msg.method.startsWith("notifications/")) return null;
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
          };
      }
    } catch (e) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: e instanceof InputError ? -32602 : -32603,
          message: (e as Error).message ?? String(e),
        },
      };
    }
  }

  /** Handle a parsed JSON payload (single JSON-RPC object or batch array). */
  async handlePayload(payload: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(payload)) {
      if (!payload.length) {
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Empty batch" } };
      }
      const answers = await Promise.all(payload.map((item) => this.handleMessage(item as JsonRpcRequest)));
      const filtered = answers.filter((a): a is JsonRpcResponse => a !== null);
      return filtered.length ? filtered : null;
    }
    return this.handleMessage(payload as JsonRpcRequest);
  }
}
