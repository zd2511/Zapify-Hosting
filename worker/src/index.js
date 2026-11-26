
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
};

const CF_API = "https://api.cloudflare.com/client/v4";

function cors(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

function reply(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...cors(origin) }
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function responseData(response) {
  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  return { data, text };
}

function apiError(data, text, status) {
  return (
    data?.errors?.map(e => e.message).filter(Boolean).join("; ") ||
    data?.error ||
    text?.slice(0, 300) ||
    `HTTP ${status}`
  );
}

async function cfRequest(env, path, method = "GET", body) {
  const headers = {
    Authorization: `Bearer ${env.CF_API_TOKEN}`
  };

  if (body !== undefined && !(body instanceof FormData)) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(CF_API + path, {
    method,
    headers,
    body: body === undefined
      ? undefined
      : body instanceof FormData
        ? body
        : JSON.stringify(body)
  });

  const { data, text } = await responseData(response);

  if (!response.ok || !data?.success) {
    throw new Error(
      `Cloudflare API: ${apiError(data, text, response.status)}`
    );
  }

  return data;
}

// Supabase user authentication.
async function userFor(env, accessToken) {
  const response = await fetch(
    `${env.SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  const { data, text } = await responseData(response);

  if (!response.ok || !data?.id) {
    throw new Error(
      `Supabase authentication failed (${response.status}): ${
        data?.msg || data?.message || text?.slice(0, 200) || "Invalid session"
      }`
    );
  }

  return data;
}

// Supabase database access.
async function db(env, path, method = "GET", data) {
  return fetch(
    `${env.SUPABASE_URL}/rest/v1/${path}`,
    {
      method,
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        "content-type": "application/json",
        Prefer: method === "POST"
          ? "return=representation"
          : "return=minimal"
      },
      body: data === undefined ? undefined : JSON.stringify(data)
    }
  );
}

// Safe website paths.
function safePath(path) {
  if (
    !path ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) return false;

  const parts = path.split("/");

  if (parts.some(part => !part || part === "." || part === "..")) {
    return false;
  }

  if (
    parts.some(part =>
      part === "node_modules" ||
      part === ".git" ||
      part === ".wrangler" ||
      part === "__MACOSX" ||
      part === ".DS_Store" ||
      part.startsWith(".env")
    )
  ) return false;

  return parts.every(part =>
    !part.startsWith(".") || part === ".well-known"
  );
}

// BLAKE3 implementation.
const B3_IV = new Uint32Array([
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
  0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19
]);

const B3_PERM = [
  2, 6, 3, 10, 7, 0, 4, 13,
  1, 11, 12, 5, 9, 14, 15, 8
];

function b3rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

function b3g(s, a, b, c, d, mx, my) {
  s[a] = (s[a] + s[b] + mx) >>> 0;
  s[d] = b3rotr(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = b3rotr(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b] + my) >>> 0;
  s[d] = b3rotr(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = b3rotr(s[b] ^ s[c], 7);
}

function b3compress(cv, blockWords, counter, blockLen, flags) {
  const s = new Uint32Array(16);

  s.set(cv, 0);
  s.set(B3_IV.subarray(0, 4), 8);

  s[12] = counter >>> 0;
  s[13] = Math.floor(counter / 4294967296) >>> 0;
  s[14] = blockLen >>> 0;
  s[15] = flags >>> 0;

  let m = Array.from(blockWords);

  for (let r = 0; r < 7; r++) {
    b3g(s, 0, 4, 8, 12, m[0], m[1]);
    b3g(s, 1, 5, 9, 13, m[2], m[3]);
    b3g(s, 2, 6, 10, 14, m[4], m[5]);
    b3g(s, 3, 7, 11, 15, m[6], m[7]);

    b3g(s, 0, 5, 10, 15, m[8], m[9]);
    b3g(s, 1, 6, 11, 12, m[10], m[11]);
    b3g(s, 2, 7, 8, 13, m[12], m[13]);
    b3g(s, 3, 4, 9, 14, m[14], m[15]);

    m = B3_PERM.map(i => m[i]);
  }

  const out = new Uint32Array(16);

  for (let i = 0; i < 8; i++) {
    out[i] = (s[i] ^ s[i + 8]) >>> 0;
    out[i + 8] = (s[i + 8] ^ cv[i]) >>> 0;
  }

  return out;
}

function b3words(block) {
  const padded = new Uint8Array(64);
  padded.set(block);

  const view = new DataView(padded.buffer);
  const words = new Uint32Array(16);

  for (let i = 0; i < 16; i++) {
    words[i] = view.getUint32(i * 4, true);
  }

  return words;
}

function b3chunkOutput(chunk, counter) {
  let cv = B3_IV;
  const blockCount = Math.max(1, Math.ceil(chunk.length / 64));

  for (let i = 0; i < blockCount; i++) {
    const block = chunk.subarray(
      i * 64,
      Math.min((i + 1) * 64, chunk.length)
    );

    const words = b3words(block);
    const flags =
      (i === 0 ? 1 : 0) |
      (i === blockCount - 1 ? 2 : 0);

    if (i === blockCount - 1) {
      return {
        cv,
        blockWords: words,
        counter,
        blockLen: block.length,
        flags
      };
    }

    cv = b3compress(
      cv,
      words,
      counter,
      block.length,
      flags
    ).slice(0, 8);
  }

  throw new Error("BLAKE3 chunk error.");
}

function b3cv(output) {
  return b3compress(
    output.cv,
    output.blockWords,
    output.counter,
    output.blockLen,
    output.flags
  ).slice(0, 8);
}

function b3parent(left, right) {
  const words = new Uint32Array(16);

  words.set(left, 0);
  words.set(right, 8);

  return {
    cv: B3_IV,
    blockWords: words,
    counter: 0,
    blockLen: 64,
    flags: 4
  };
}

function blake3Hex(input) {
  const chunkCount = Math.max(1, Math.ceil(input.length / 1024));
  const stack = [];

  for (let i = 0; i < chunkCount - 1; i++) {
    let cv = b3cv(
      b3chunkOutput(
        input.subarray(i * 1024, (i + 1) * 1024),
        i
      )
    );

    let total = i + 1;

    while ((total & 1) === 0) {
      cv = b3cv(b3parent(stack.pop(), cv));
      total = Math.floor(total / 2);
    }

    stack.push(cv);
  }

  let output = b3chunkOutput(
    input.subarray((chunkCount - 1) * 1024),
    chunkCount - 1
  );

  while (stack.length) {
    output = b3parent(stack.pop(), b3cv(output));
  }

  const root = b3compress(
    output.cv,
    output.blockWords,
    0,
    output.blockLen,
    output.flags | 8
  );

  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);

  for (let i = 0; i < 8; i++) {
    view.setUint32(i * 4, root[i], true);
  }

  return Array.from(bytes)
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

// Binary to Base64.
function toBase64(bytes) {
  let binary = "";

  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + 8192)
    );
  }

  return btoa(binary);
}

// Cloudflare-compatible Pages asset hash.
function pagesHash(base64, filename) {
  const basename = filename.split("/").pop();
  const dot = basename.lastIndexOf(".");
  const extension = dot >= 0
    ? basename.slice(dot + 1)
    : "";

  return blake3Hex(
    new TextEncoder().encode(base64 + extension)
  ).slice(0, 32);
}

function mimeType(filename) {
  const ext = filename.split(".").pop().toLowerCase();

  const types = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json",
    xml: "application/xml",
    txt: "text/plain",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    pdf: "application/pdf",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    webm: "video/webm"
  };

  return types[ext] || "application/octet-stream";
}

function projectName(name, id) {
  const slug = String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 22) || "site";

  return `zfy-${slug}-${id.replace(/-/g, "").slice(0, 10)}`;
}

async function getOrCreatePagesProject(env, project) {
  if (project.cf_project_name) {
    return project.cf_project_name;
  }

  const name = projectName(project.site_name, project.id);
  const base = `/accounts/${env.CF_ACCOUNT_ID}/pages/projects`;

  try {
    await cfRequest(env, base, "POST", {
      name,
      production_branch: "main"
    });
  } catch (createError) {
    try {
      await cfRequest(env, `${base}/${name}`, "GET");
    } catch {
      throw new Error(
        `Pages project creation failed: ${createError.message}`
      );
    }
  }

  const saved = await db(
    env,
    `projects?id=eq.${project.id}&user_id=eq.${project.user_id}`,
    "PATCH",
    {
      cf_project_name: name,
      status: "deploying",
      updated_at: new Date().toISOString()
    }
  );

  if (!saved.ok) {
    throw new Error("Could not save the Cloudflare project name.");
  }

  return name;
}

// Obtain the temporary Pages asset JWT.
async function getUploadToken(env, name) {
  const data = await cfRequest(
    env,
    `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${name}/upload-token`
  );

  if (!data.result?.jwt) {
    throw new Error("Cloudflare did not return an upload JWT.");
  }

  return data.result.jwt;
}

// Asset API calls use the temporary JWT, not the account API token.
async function assetRequest(env, name, tokenState, endpoint, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(
      `${CF_API}/pages/assets/${endpoint}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenState.jwt}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    const { data, text } = await responseData(response);

    if (
      (response.status === 401 || response.status === 403) &&
      !tokenState.refreshed
    ) {
      tokenState.jwt = await getUploadToken(env, name);
      tokenState.refreshed = true;
      continue;
    }

    if (response.ok && data?.success) {
      return data;
    }

    const message = apiError(data, text, response.status);

    if (
      attempt < 2 &&
      (response.status === 429 || response.status >= 500)
    ) {
      await delay(500 * (attempt + 1));
      continue;
    }

    throw new Error(
      `Cloudflare asset ${endpoint} failed (${response.status}): ${message}`
    );
  }

  throw new Error(`Cloudflare asset ${endpoint} failed after retries.`);
}

// Files that Pages treats as deployment configuration, not static assets.
const SPECIAL_FILES = new Set([
  "_headers",
  "_redirects",
  "_routes.json",
  "_worker.js"
]);

async function prepareAssets(files) {
  const manifest = {};
  const fileByHash = new Map();
  const special = {};
  const paths = new Set();

  for (const file of files) {
    const path = file.name;

    if (!safePath(path)) {
      throw new Error(`Unsafe website file path: ${path}`);
    }

    if (paths.has(path)) {
      throw new Error(`Duplicate website file: ${path}`);
    }

    paths.add(path);

    if (path.includes("/functions/") || path.startsWith("functions/")) {
      throw new Error(
        "Pages Functions are not supported by this static hosting uploader. Remove the functions folder."
      );
    }

    if (SPECIAL_FILES.has(path)) {
      special[path] = {
        bytes: new Uint8Array(await file.arrayBuffer()),
        type: mimeType(path)
      };
      continue;
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const base64 = toBase64(bytes);
    const hash = pagesHash(base64, path);

    manifest[`/${path}`] = hash;

    if (!fileByHash.has(hash)) {
      fileByHash.set(hash, {
        hash,
        bytes,
        base64,
        contentType: mimeType(path)
      });
    }
  }

  if (!manifest["/index.html"]) {
    throw new Error("Your ZIP must contain index.html at its root.");
  }

  return {
    manifest,
    fileByHash,
    special
  };
}

async function uploadAssets(env, name, tokenState, fileByHash) {
  const hashes = [...fileByHash.keys()];
  const missing = new Set();

  // Ask Cloudflare which assets it does not already have.
  for (let i = 0; i < hashes.length; i += 100) {
    const result = await assetRequest(
      env,
      name,
      tokenState,
      "check-missing",
      { hashes: hashes.slice(i, i + 100) }
    );

    for (const hash of result.result || []) {
      missing.add(hash);
    }
  }

  // Upload only missing assets.
  const missingFiles = [...missing]
    .map(hash => fileByHash.get(hash))
    .filter(Boolean);

  for (let i = 0; i < missingFiles.length; i += 5) {
    const batch = missingFiles.slice(i, i + 5);

    const payload = batch.map(file => ({
      key: file.hash,
      value: file.base64,
      base64: true,
      metadata: {
        contentType: file.contentType
      }
    }));

    await assetRequest(
      env,
      name,
      tokenState,
      "upload",
      payload
    );
  }

  // Register all manifest hashes.
  for (let i = 0; i < hashes.length; i += 100) {
    await assetRequest(
      env,
      name,
      tokenState,
      "upsert-hashes",
      { hashes: hashes.slice(i, i + 100) }
    );
  }
}

async function createDeployment(env, name, manifest, special) {
  const form = new FormData();

  form.set("manifest", JSON.stringify(manifest));
  form.set("branch", "main");
  form.set("commit_dirty", "false");
  form.set("commit_message", "Published from Zapify Hosting");

  for (const [path, item] of Object.entries(special)) {
    const field = path;

    form.set(
      field,
      new File([item.bytes], path, { type: item.type })
    );
  }

  const data = await cfRequest(
    env,
    `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${name}/deployments`,
    "POST",
    form
  );

  if (!data.result?.id) {
    throw new Error("Cloudflare did not return a deployment ID.");
  }

  return {
    id: data.result.id,
    url: `https://${name}.pages.dev`
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "";

    if (!allowedOrigin || origin !== allowedOrigin) {
      return new Response("Origin not allowed", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors(origin)
      });
    }

    const url = new URL(request.url);

    if (request.method !== "POST" || url.pathname !== "/api/deploy") {
      return reply({ error: "Not found." }, 404, origin);
    }

    let project = null;
    let stage = "Starting deployment";

    try {
      const required = [
        "SUPABASE_URL",
        "SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "CF_ACCOUNT_ID",
        "CF_API_TOKEN"
      ];

      for (const key of required) {
        if (!env[key]) {
          throw new Error(`Missing Worker configuration: ${key}`);
        }
      }

      stage = "Authenticating your Zapify account";

      const authorization = request.headers.get("Authorization") || "";
      const accessToken = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";

      if (!accessToken) {
        return reply(
          { error: "Please sign in again.", stage },
          401,
          origin
        );
      }

      const user = await userFor(env, accessToken);

      stage = "Reading your ZIP upload";

      const form = await request.formData();
      const siteName = String(form.get("siteName") || "").trim();

      const files = form.getAll("files")
        .filter(file => file instanceof File);

      if (!siteName || siteName.length > 60) {
        throw new Error("Website name must be 1–60 characters.");
      }

      if (!files.length || files.length > 100) {
        throw new Error("Upload between 1 and 100 files.");
      }

      let totalSize = 0;

      for (const file of files) {
        totalSize += file.size;
      }

      if (totalSize > 20 * 1024 * 1024) {
        throw new Error("Expanded website exceeds 20 MiB.");
      }

      stage = "Preparing website files";

      const prepared = await prepareAssets(files);

      stage = "Creating your project record";

      const created = await db(env, "projects", "POST", {
        user_id: user.id,
        site_name: siteName,
        slug: crypto.randomUUID().slice(0, 8),
        status: "draft"
      });

      const createdText = await created.text();
      let rows;

      try {
        rows = JSON.parse(createdText);
      } catch {
        rows = null;
      }

      if (!created.ok || !rows?.[0]) {
        throw new Error(
          `Supabase project record failed (${created.status}): ${
            createdText.slice(0, 250)
          }`
        );
      }

      project = rows[0];

      stage = "Creating your Cloudflare Pages project";

      const name = await getOrCreatePagesProject(env, project);

      stage = "Requesting Cloudflare upload authorization";

      const tokenState = {
        jwt: await getUploadToken(env, name),
        refreshed: false
      };

      stage = "Uploading website assets";

      await uploadAssets(
        env,
        name,
        tokenState,
        prepared.fileByHash
      );

      stage = "Publishing your website";

      const deployment = await createDeployment(
        env,
        name,
        prepared.manifest,
        prepared.special
      );

      stage = "Saving published website details";

      const saved = await db(
        env,
        `projects?id=eq.${project.id}&user_id=eq.${user.id}`,
        "PATCH",
        {
          cf_project_name: name,
          cf_deployment_id: deployment.id,
          live_url: deployment.url,
          status: "published",
          updated_at: new Date().toISOString()
        }
      );

      if (!saved.ok) {
        throw new Error(
          "Deployment succeeded, but saving its details failed."
        );
      }

      return reply({
        success: true,
        message: "Website published successfully.",
        projectId: project.id,
        url: deployment.url,
        fileCount: Object.keys(prepared.manifest).length
      }, 200, origin);

    } catch (error) {
      console.error("Zapify Hosting deployment failure:", {
        stage,
        message: error.message
      });

      if (project?.id) {
        await db(
          env,
          `projects?id=eq.${project.id}&user_id=eq.${project.user_id}`,
          "PATCH",
          {
            status: "failed",
            updated_at: new Date().toISOString()
          }
        ).catch(() => {});
      }

      return reply({
        success: false,
        stage,
        error: error.message || "Unexpected deployment error."
      }, 500, origin);
    }
  }
};
