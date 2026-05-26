// BioHarmonize Agent 4: Image Generator (self-contained Vercel function)
// Cron runs daily at 15:13 UTC (8:13am PT during PDT). Slightly before Agent 2's run.
// For each canonical .md in Dropbox /BioHarmonize/01_Canonical_Approved/, generates:
//   - Blog header image (1792x1024, 16:9-ish)
//   - Instagram card (1024x1024, 1:1)
// Saves outputs to Dropbox /BioHarmonize/Images/<slug>/
// Idempotent: skips canonicals that already have both images generated.
//
// Env vars:
//   DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN (required)
//   OPENAI_API_KEY (required to actually generate; channel gracefully skips if missing)
//   CRON_SECRET (optional, requires Bearer header if set)

// ============================================================================
// CONFIG
// ============================================================================

const CANONICAL_FOLDER = "/BioHarmonize/01_Canonical_Approved";
const IMAGES_FOLDER = "/BioHarmonize/Images";
const STATUS_FOLDER = "/BioHarmonize/_status";

// Image variants to generate per canonical (sizes per gpt-image-1 supported list)
const VARIANTS = [
  { name: "header", size: "1536x1024", style: "blog header" },
  { name: "ig", size: "1024x1024", style: "Instagram square card" },
];

// Brand style prompt fragment appended to each image generation
const BRAND_STYLE = `Editorial photography in a calm, slow-living style. Muted natural color palette: warm cream, soft sage green, dusty terracotta, gentle morning light. Minimalist composition with a lot of negative space. Soft focus background, shallow depth of field. No people in the frame. No text, no logos, no watermarks. Quiet, considered, thoughtful aesthetic. Reminiscent of a typewriter document or a slow-pour-coffee morning.`;

// ============================================================================
// UTILITIES
// ============================================================================

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var missing`);
  return v;
}

function has(name) {
  return Boolean(process.env[name]);
}

function slugFromFilename(filename) {
  return filename.replace(/\.md$/i, "");
}

// ============================================================================
// DROPBOX CLIENT (refresh token flow)
// ============================================================================

let cachedAccessToken = null;
let cachedExpiresAt = 0;

async function getDropboxAccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpiresAt - 60_000) return cachedAccessToken;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: need("DROPBOX_REFRESH_TOKEN"),
  });
  const auth = Buffer.from(`${need("DROPBOX_APP_KEY")}:${need("DROPBOX_APP_SECRET")}`).toString("base64");
  const res = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Dropbox token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedAccessToken = data.access_token;
  cachedExpiresAt = Date.now() + (data.expires_in || 14400) * 1000;
  return cachedAccessToken;
}

async function dropboxAuth() {
  return { Authorization: `Bearer ${await getDropboxAccessToken()}` };
}

async function listFolder(path) {
  const res = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
    method: "POST",
    headers: { ...(await dropboxAuth()), "Content-Type": "application/json" },
    body: JSON.stringify({ path, recursive: false, limit: 200 }),
  });
  if (!res.ok) throw new Error(`Dropbox listFolder failed: ${res.status} ${await res.text()}`);
  return (await res.json()).entries || [];
}

async function downloadFile(path) {
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: { ...(await dropboxAuth()), "Dropbox-API-Arg": JSON.stringify({ path }) },
  });
  if (!res.ok) throw new Error(`Dropbox downloadFile failed: ${res.status} ${await res.text()}`);
  return await res.text();
}

async function uploadBinaryFile(path, buffer) {
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      ...(await dropboxAuth()),
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path, mode: "overwrite", autorename: false, mute: true, strict_conflict: false,
      }),
    },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Dropbox uploadBinaryFile failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function uploadJsonFile(path, obj) {
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      ...(await dropboxAuth()),
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path, mode: "overwrite", autorename: false, mute: true, strict_conflict: false,
      }),
    },
    body: JSON.stringify(obj, null, 2),
  });
  if (!res.ok) throw new Error(`Dropbox uploadJsonFile failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function ensureFolder(path) {
  const res = await fetch("https://api.dropboxapi.com/2/files/create_folder_v2", {
    method: "POST",
    headers: { ...(await dropboxAuth()), "Content-Type": "application/json" },
    body: JSON.stringify({ path, autorename: false }),
  });
  if (!res.ok) {
    const txt = await res.text();
    if (!/path\/conflict\/folder/.test(txt)) {
      console.warn(`ensureFolder ${path}:`, txt.slice(0, 200));
    }
  }
}

async function fileExists(path) {
  const res = await fetch("https://api.dropboxapi.com/2/files/get_metadata", {
    method: "POST",
    headers: { ...(await dropboxAuth()), "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return res.ok;
}

// ============================================================================
// OPENAI DALL-E 3 IMAGE GENERATION
// ============================================================================

async function generateImage({ prompt, size }) {
  if (!has("OPENAI_API_KEY")) {
    return { skipped: true, reason: "OPENAI_API_KEY not set" };
  }
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      n: 1,
      size,
      quality: "medium",
    }),
  });
  if (!res.ok) throw new Error(`OpenAI image gen failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const item = data?.data?.[0];
  if (!item) throw new Error(`OpenAI returned no data: ${JSON.stringify(data).slice(0, 300)}`);
  // gpt-image-1 returns base64 by default; fall back to URL if API ever changes
  if (item.b64_json) {
    return {
      success: true,
      buffer: Buffer.from(item.b64_json, "base64"),
      revisedPrompt: item.revised_prompt,
    };
  }
  if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status}`);
    const arrayBuf = await imgRes.arrayBuffer();
    return {
      success: true,
      buffer: Buffer.from(arrayBuf),
      revisedPrompt: item.revised_prompt,
    };
  }
  throw new Error(`OpenAI returned no b64 or url: ${JSON.stringify(item).slice(0, 300)}`);
}

// ============================================================================
// PROMPT BUILDING
// ============================================================================

// Extract the canonical's H1 title + a short topic hint from the markdown content
function extractCanonicalContext(markdown) {
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "BioHarmonize";

  // Pull a short topic descriptor from the first H2 or first paragraph
  const firstH2 = markdown.match(/^##\s+(.+)$/m);
  const topic = firstH2 ? firstH2[1].trim() : title;
  return { title, topic };
}

function buildPrompt(title, topic, variant) {
  // Different framing per variant
  const variantHints = {
    header: `Wide composition suitable for a blog post header. The subject is implied by the topic, not literal text. Cinematic feel.`,
    ig: `Square composition. The composition should work as the focal image on an Instagram square post (1:1).`,
  };

  // Subject derived from topic (keeping it abstract and non-stocky)
  return `${variantHints[variant.name]}\n\nTopic context: "${title}". Subtopic: "${topic}". The image should evoke the feeling and subject matter of this topic without being literal or didactic. For example, an article about bedroom EMF audits might show a serene morning bedroom scene with soft natural light, plants, an unmade linen bed.\n\n${BRAND_STYLE}`;
}

// ============================================================================
// STATUS TRACKING
// ============================================================================

async function writeStatus(payload) {
  try {
    await ensureFolder(STATUS_FOLDER);
    await uploadJsonFile(`${STATUS_FOLDER}/agent_4_last_run.json`, {
      agent: "agent_4_images",
      ...payload,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.warn("Failed to write status:", err.message);
  }
}

// ============================================================================
// CORE PROCESSING
// ============================================================================

async function processCanonical(file) {
  const filename = file.name;
  const slug = slugFromFilename(filename);
  const slugFolder = `${IMAGES_FOLDER}/${slug}`;

  // Skip if all variants already exist
  const variantPaths = VARIANTS.map((v) => `${slugFolder}/${v.name}.png`);
  const allExist = await Promise.all(variantPaths.map((p) => fileExists(p)));
  if (allExist.every(Boolean)) {
    return { filename, skipped: true, reason: "all variants already exist" };
  }

  // Read canonical content for context
  const content = await downloadFile(file.path_lower || file.path_display);
  const { title, topic } = extractCanonicalContext(content);

  // Ensure target folder
  await ensureFolder(slugFolder);

  const results = [];
  for (let i = 0; i < VARIANTS.length; i++) {
    const variant = VARIANTS[i];
    const outputPath = variantPaths[i];

    if (await fileExists(outputPath)) {
      results.push({ variant: variant.name, skipped: true, reason: "already exists" });
      continue;
    }

    const prompt = buildPrompt(title, topic, variant);
    try {
      const gen = await generateImage({ prompt, size: variant.size });
      if (gen.skipped) {
        results.push({ variant: variant.name, skipped: true, reason: gen.reason });
        continue;
      }
      await uploadBinaryFile(outputPath, gen.buffer);
      results.push({
        variant: variant.name,
        success: true,
        outputPath,
        size: variant.size,
        revisedPrompt: gen.revisedPrompt?.slice(0, 200),
      });
    } catch (err) {
      results.push({ variant: variant.name, success: false, error: err.message });
    }
  }

  return { filename, slug, title, results };
}

// ============================================================================
// HANDLER
// ============================================================================

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers.authorization || "";
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const runStartedAt = new Date().toISOString();

  try {
    const entries = await listFolder(CANONICAL_FOLDER);
    const mdFiles = entries.filter(
      (e) => e[".tag"] === "file" && e.name.toLowerCase().endsWith(".md")
    );

    if (mdFiles.length === 0) {
      const payload = {
        ok: true,
        message: "No .md files in canonical folder",
        runStartedAt,
      };
      await writeStatus(payload);
      return res.status(200).json({ ...payload, timestamp: new Date().toISOString() });
    }

    const results = [];
    for (const file of mdFiles) {
      const r = await processCanonical(file);
      results.push(r);
      console.log(`[agent4]`, JSON.stringify(r));
    }

    const payload = {
      ok: true,
      processed: results.length,
      results,
      runStartedAt,
    };
    await writeStatus(payload);
    return res.status(200).json({ ...payload, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("Agent 4 failed:", err);
    const payload = {
      ok: false,
      error: err.message,
      stack: err.stack,
      runStartedAt,
    };
    await writeStatus(payload).catch(() => {});
    return res.status(500).json({ ...payload, timestamp: new Date().toISOString() });
  }
}
