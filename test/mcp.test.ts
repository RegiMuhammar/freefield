import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { History, type JobLike } from "../server/history.ts";
import { McpServer, PRESET_FLOWS } from "../server/mcp-core.ts";
import { loadRegistry } from "../server/registry.ts";
import type { Values } from "../server/runner.ts";

const { apps } = loadRegistry();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);

function makeFakeJob(end: "succeeded" | "failed" = "succeeded", delayMs = 10): JobLike & { canceled: boolean } {
  let status = "queued";
  const started = new Date();
  return {
    id: "job-mcp-1",
    canceled: false,
    get status() { return status; },
    get outputs() {
      return status === "succeeded"
        ? [
            { name: "out.png", type: "image", nodeId: "9", contentType: "image/png", toBytes: async () => PNG },
            { name: "clip.mp4", type: "video", nodeId: "75", contentType: "video/mp4", toBytes: async () => PNG },
            { name: "restyle.mp4", type: "video", nodeId: "4852", contentType: "video/mp4", toBytes: async () => PNG },
            { name: "song.mp3", type: "audio", nodeId: "18", contentType: "audio/mpeg", toBytes: async () => PNG },
          ]
        : [];
    },
    get error() { return status === "failed" ? { message: "GPU OOM", class_type: "KSampler", node_id: "3" } : null; },
    get startedAt() { return started; },
    get completedAt() { return new Date(started.getTime() + 1200); },
    async *events() {},
    async wait() {
      status = "running";
      await new Promise((r) => setTimeout(r, delayMs));
      status = end;
    },
    async cancel() {
      this.canceled = true;
      status = "canceled";
    },
  };
}

function makeTestMcp(jobFactory: () => JobLike = () => makeFakeJob("succeeded")) {
  const dir = mkdtempSync(join(tmpdir(), "ff-mcp-"));
  const submitted: { appId: string; values: Values; preset?: string }[] = [];
  const mcp = new McpServer({
    apps,
    outDir: dir,
    getRunner: () => ({
      baseUrl: "http://gpu.test",
      token: "secret",
      allowDrafts: false,
      async submit(app, values, preset) {
        submitted.push({ appId: app.id, values, preset });
        return jobFactory();
      },
    }),
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://example.com/product.png") {
        return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
      }
      if (url.endsWith("/freefield/status")) {
        return new Response(JSON.stringify({ app: "create-image", frees: 1 }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  });
  return {
    dir,
    mcp,
    history: mcp.history,
    submitted,
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("MCP JSON-RPC initialize, ping, notifications, and batch requests", async () => {
  const { mcp, done } = makeTestMcp();
  try {
    const init = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    assert.equal(init?.id, 1);
    const res = init?.result as { protocolVersion: string; serverInfo: { name: string } };
    assert.equal(res.protocolVersion, "2025-03-26");
    assert.equal(res.serverInfo.name, "freefield-mcp");

    // notifications return null
    assert.equal(await mcp.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);

    // batch with a notification and a ping
    const batch = await mcp.handlePayload([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "p1", method: "ping" },
    ]);
    assert.deepEqual(batch, [{ jsonrpc: "2.0", id: "p1", result: {} }]);

    // unknown method
    const unknown = await mcp.handleMessage({ jsonrpc: "2.0", id: 9, method: "nope/method" });
    assert.equal(unknown?.error?.code, -32601);
  } finally {
    done();
  }
});

test("discovery tools: list_apps, recommend_app, get_app (with vox-collage), and get_flow", async () => {
  const { mcp, done } = makeTestMcp();
  try {
    const listRes = await mcp.callTool("freefield_list_apps", { section: "audio", max_vram_gb: 20 });
    const listData = JSON.parse((listRes.content[0] as { text: string }).text);
    assert.ok(listData.count >= 2);
    assert.ok(listData.apps.some((a: { id: string }) => a.id === "music"));

    const recRes = await mcp.callTool("freefield_recommend_app", {
      goal: "make a vox mixed media paper collage explainer video",
      has_video: true,
    });
    const recData = JSON.parse((recRes.content[0] as { text: string }).text);
    assert.equal(recData.recommended_apps[0].id, "mixed-media");
    assert.ok(recData.matching_preset_flows.some((f: { id: string }) => f.id === "vox-mixed-media"));

    const appRes = await mcp.callTool("freefield_get_app", { app_id: "mixed-media" });
    const appData = JSON.parse((appRes.content[0] as { text: string }).text);
    const styleInput = appData.inputs.find((i: { id: string }) => i.id === "style");
    assert.ok(styleInput.options.some((o: { value: string }) => o.value === "vox-collage"), "vox-collage look is present in mixed-media");

    const flowRes = await mcp.callTool("freefield_get_flow", { flow_id: "/katana" });
    const flowData = JSON.parse((flowRes.content[0] as { text: string }).text);
    assert.equal(flowData.id, "katana");
    assert.ok(flowData.steps[0].apps.includes("camera-copy"));
  } finally {
    done();
  }
});

test("execution, local output_dir saving, inline image blocks, and history:<run_id> chaining across steps", async () => {
  const { dir, mcp, submitted, done } = makeTestMcp();
  try {
    const outDir = join(dir, "exported");
    // Step 1: generate an image with freefield_generate_image
    const step1 = await mcp.callTool("freefield_generate_image", {
      prompt: "a matte black perfume bottle on wet stone",
      aspect: "9:16",
      look: "Flash editorial",
      output_dir: outDir,
      include_inline_image: true,
      seed: 42,
    });
    assert.equal(step1.isError, undefined);
    assert.equal(step1.content.length, 2, "text JSON + inline base64 image block");
    assert.equal(step1.content[1].type, "image");
    const run1 = JSON.parse((step1.content[0] as { text: string }).text);
    assert.equal(run1.status, "succeeded");
    assert.equal(submitted[0].appId, "create-image");
    assert.equal(submitted[0].values.aspect, "9:16");
    assert.equal(run1.saved_to_output_dir.length, 1);
    assert.ok(existsSync(run1.saved_to_output_dir[0]));

    // Step 2: chain Step 1's output into video using history:<run_id>
    const step2 = await mcp.callTool("freefield_generate_video", {
      prompt: "camera orbits the bottle as sparks fly",
      image: `history:${run1.id}`,
      duration: 5,
      seed: 7,
    });
    assert.equal(step2.isError, undefined);
    const run2 = JSON.parse((step2.content[0] as { text: string }).text);
    assert.equal(run2.status, "succeeded");
    assert.equal(submitted[1].appId, "video");
    const passedImg = submitted[1].values.image as { bytes: Uint8Array; name: string };
    assert.deepEqual([...passedImg.bytes], [...PNG], "chained bytes from run1 reached run2");

    // Step 3: resolve file input from URL and data URI in freefield_run_app
    const step3 = await mcp.callTool("freefield_run_app", {
      app_id: "ugc-shot",
      values: {
        image: "https://example.com/product.png",
        where: "a busy cafe",
        details: "held up to the lens",
      },
    });
    assert.equal(step3.isError, undefined);
    assert.equal(submitted[2].appId, "ugc-shot");

    const b64 = Buffer.from(PNG).toString("base64");
    const step4 = await mcp.callTool("freefield_run_app", {
      app_id: "edit",
      values: {
        image: `data:image/png;base64,${b64}`,
        instruction: "add neon rim light",
      },
    });
    assert.equal(step4.isError, undefined);
    assert.equal(submitted[3].appId, "edit");

    // History listing
    const histRes = await mcp.callTool("freefield_list_history", { limit: 10 });
    const histData = JSON.parse((histRes.content[0] as { text: string }).text);
    assert.equal(histData.count, 4);
  } finally {
    done();
  }
});

test("async wait=false, freefield_get_run polling, and freefield_cancel_run", async () => {
  const slowJob = makeFakeJob("succeeded", 120);
  const { mcp, done } = makeTestMcp(() => slowJob);
  try {
    const startRes = await mcp.callTool("freefield_generate_audio", {
      kind: "music",
      prompt: "lo-fi hip hop beat",
      wait: false,
    });
    const started = JSON.parse((startRes.content[0] as { text: string }).text);
    // Poll with wait_seconds=1 so it finishes
    const polledRes = await mcp.callTool("freefield_get_run", {
      run_id: started.id,
      wait_seconds: 1,
    });
    const polled = JSON.parse((polledRes.content[0] as { text: string }).text);
    assert.equal(polled.status, "succeeded");
  } finally {
    done();
  }
});

test("resources and slash-command prompts (/ugc-flow, /katana, /vox-mixed-media)", async () => {
  const { mcp, done } = makeTestMcp();
  try {
    assert.equal(mcp.listResources().length, 4);
    assert.equal(mcp.listResourceTemplates().length, 1);
    const flowsResource = JSON.parse(mcp.readResource("freefield://catalog/flows")[0].text);
    assert.equal(flowsResource.length, PRESET_FLOWS.length);

    const appResource = JSON.parse(mcp.readResource("freefield://apps/cinema-video")[0].text);
    assert.equal(appResource.id, "cinema-video");

    const prompts = mcp.listPrompts();
    assert.ok(prompts.some((p) => p.name === "ugc-flow"));
    assert.ok(prompts.some((p) => p.name === "katana"));
    assert.ok(prompts.some((p) => p.name === "vox-mixed-media"));

    const promptMsg = mcp.getPrompt("/ugc-flow", { product: "cold brew bottle", script: "Best iced coffee ever" });
    assert.match(promptMsg.messages[0].content.text, /cold brew bottle/);
    assert.match(promptMsg.messages[0].content.text, /ugc-shot/);
  } finally {
    done();
  }
});
