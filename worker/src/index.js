
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
    headers: {
      ...JSON_HEADERS,
      ...cors(origin)
    }
  });
}

async function readJson(response) {
  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!response.ok || !data?.success) {
    const message =
      data?.errors?.map(e => e.message).filter(Boolean).join("; ") ||
      `API request failed (${response.status}).`;

    throw new Error(message);
  }

  return data;
}

// Supabase user authentication.
async function userFor(env, token) {
  const response = await fetch(
    `${env.SUPABASE_URL}/auth/v1/user`,
    {
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) return null;

  return response.json();
}

// Supabase database access.
// New sb_secret keys are used in apikey only.
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
      body: data ? JSON.stringify(data) : undefined
    }
  );
}

// Cloudflare API request using the account API token.
async function cf(env, path, method = "GET", body) {
  const headers = {
    Authorization: `Bearer ${env.CF_API_TOKEN}`
  };

  if (body !== undefined && !(body instanceof FormData)) {
    headers["content-type"] = "application/json";
  }

  return fetch(`${CF_API}${path}`, {
    method,
    headers,
    body: body === undefined
      ? undefined
      : body instanceof FormData
        ? body
        : JSON.stringify(body)
  });
}

// Cloudflare Pages project name.
function projectName(name, id) {
  const slug = String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 22) || "site";

  return `zfy-${slug}-${id.replace(/-/g, "").slice(0, 10)}`;
}

// Validate website file paths.
function safePath(path) {
  return Boolean(
    path &&
    path.length <= 500 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every(part =>
      part &&
      part !== "." &&
      part !== ".." &&
      !part.startsWith(".")
    )
  );
}

// SHA-256 hash.
async function hash(buffer) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    buffer
  );

  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

// File MIME types.
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
    txt: "text/plain; charset=utf-8",
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

// Convert binary data to Base64 safely.
function toBase64(bytes) {
  let binary = "";
  const chunkSize = 8192;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

// Create or retrieve the Pages project.
async function getOrCreatePagesProject(env, project) {
  if (project.cf_project_name) {
    return project.cf_project_name;
  }

  const name = projectName(
    project.site_name,
    project.id
  );

  const base =
    `/accounts/${env.CF_ACCOUNT_ID}/pages/projects`;

  const createResponse = await cf(
    env,
    base,
    "POST",
    {
      name,
      production_branch: "main"
    }
  );

  if (!createResponse.ok) {
    const existingResponse = await cf(
      env,
      `${base}/${name}`,
      "GET"
    );

    const existing = await existingResponse.json();

    if (!existingResponse.ok || !existing.success) {
      const failed = await createResponse.json();

      throw new Error(
        failed.errors?.[0]?.message ||
        "Could not create the Cloudflare Pages project."
      );
    }
  } else {
    const created = await createResponse.json();

    if (!created.success) {
      throw new Error(
        created.errors?.[0]?.message ||
        "Cloudflare rejected the Pages project."
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
    throw new Error("Could not save the Pages project.");
  }

  return name;
}

// Get a temporary token for Pages asset uploads.
async function getUploadToken(env, name) {
  const response = await cf(
    env,
    `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${name}/upload-token`
  );

  const data = await readJson(response);

  if (!data.result?.jwt) {
    throw new Error("Cloudflare did not provide an asset upload token.");
  }

  return data.result.jwt;
}

// Make an authenticated Pages asset API request.
async function assetRequest(token, endpoint, body) {
  const response = await fetch(
    `${CF_API}/pages/assets/${endpoint}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  return readJson(response);
}

// Upload all website files using the proper Pages workflow.
async function uploadAssets(token, files) {
  const manifest = {};
  const fileByHash = new Map();

  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const fileHash = await hash(buffer);

    manifest[file.name] = fileHash;

    if (!fileByHash.has(fileHash)) {
      fileByHash.set(fileHash, {
        hash: fileHash,
        bytes: new Uint8Array(buffer),
        contentType: mimeType(file.name)
      });
    }
  }

  const allHashes = [...fileByHash.keys()];

  // Step 1: Find missing assets.
  const missingSet = new Set();

  for (let i = 0; i < allHashes.length; i += 100) {
    const batch = allHashes.slice(i, i + 100);

    const checked = await assetRequest(
      token,
      "check-missing",
      { hashes: batch }
    );

    for (const missingHash of checked.result || []) {
      missingSet.add(missingHash);
    }
  }

  // Step 2: Upload missing assets in small batches.
  const missingFiles = [...missingSet].map(hashValue =>
    fileByHash.get(hashValue)
  ).filter(Boolean);

  for (let i = 0; i < missingFiles.length; i += 5) {
    const batch = missingFiles.slice(i, i + 5);

    const payload = batch.map(file => ({
      key: file.hash,
      value: toBase64(file.bytes),
      base64: true,
      metadata: {
        contentType: file.contentType
      }
    }));

    await assetRequest(
      token,
      "upload",
      payload
    );
  }

  // Step 3: Register uploaded hashes.
  for (let i = 0; i < allHashes.length; i += 100) {
    const batch = allHashes.slice(i, i + 100);

    await assetRequest(
      token,
      "upsert-hashes",
      { hashes: batch }
    );
  }

  return manifest;
}

// Create the production deployment.
async function createDeployment(env, name, manifest) {
  const form = new FormData();

  form.set("manifest", JSON.stringify(manifest));
  form.set("branch", "main");
  form.set("commit_dirty", "false");
  form.set(
    "commit_message",
    "Published from Zapify Hosting"
  );

  const response = await cf(
    env,
    `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${name}/deployments`,
    "POST",
    form
  );

  const data = await readJson(response);

  if (!data.result?.id) {
    throw new Error("Cloudflare did not return a deployment ID.");
  }

  return {
    id: data.result.id,
    url: `https://${name}.pages.dev`
  };
}

// Main Worker.
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "";

    if (!allowedOrigin || origin !== allowedOrigin) {
      return new Response("Origin not allowed", {
        status: 403
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors(origin)
      });
    }

    const url = new URL(request.url);

    if (
      request.method !== "POST" ||
      url.pathname !== "/api/deploy"
    ) {
      return reply(
        { error: "Not found." },
        404,
        origin
      );
    }

    let project = null;

    try {
      // Required Cloudflare variables.
      const required = [
        "SUPABASE_URL",
        "SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "CF_ACCOUNT_ID",
        "CF_API_TOKEN"
      ];

      for (const key of required) {
        if (!env[key]) {
          throw new Error(`Missing configuration: ${key}`);
        }
      }

      // Authenticate user.
      const authorization =
        request.headers.get("Authorization") || "";

      const token = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : "";

      if (!token) {
        return reply(
          { error: "Please sign in first." },
          401,
          origin
        );
      }

      const user = await userFor(env, token);

      if (!user?.id) {
        return reply(
          { error: "Your session expired. Please sign in again." },
          401,
          origin
        );
      }

      // Read upload form.
      const form = await request.formData();

      const siteName = String(
        form.get("siteName") || ""
      ).trim();

      const files = form
        .getAll("files")
        .filter(file => file instanceof File);

      if (!siteName || siteName.length > 60) {
        return reply(
          { error: "Website name must be 1–60 characters." },
          400,
          origin
        );
      }

      if (!files.length || files.length > 100) {
        return reply(
          { error: "Upload between 1 and 100 files." },
          400,
          origin
        );
      }

      // Validate all files.
      let totalSize = 0;
      const paths = new Set();

      for (const file of files) {
        if (!safePath(file.name)) {
          return reply(
            { error: "Unsafe file path detected." },
            400,
            origin
          );
        }

        if (paths.has(file.name)) {
          return reply(
            { error: "Duplicate file path detected." },
            400,
            origin
          );
        }

        paths.add(file.name);
        totalSize += file.size;
      }

      if (totalSize > 20 * 1024 * 1024) {
        return reply(
          { error: "Website files exceed 20 MiB." },
          413,
          origin
        );
      }

      if (!paths.has("index.html")) {
        return reply(
          { error: "Your ZIP must contain index.html at its root." },
          400,
          origin
        );
      }

      // Create the Supabase project record.
      const created = await db(
        env,
        "projects",
        "POST",
        {
          user_id: user.id,
          site_name: siteName,
          slug: crypto.randomUUID().slice(0, 8),
          status: "draft"
        }
      );

      const raw = await created.text();

      let rows;

      try {
        rows = JSON.parse(raw);
      } catch {
        rows = null;
      }

      if (!created.ok || !rows?.[0]) {
        console.error(
          "Supabase insert failed:",
          created.status,
          raw
        );

        throw new Error(
          `Could not create project record (database ${created.status}).`
        );
      }

      project = rows[0];

      // Create or retrieve Pages project.
      const name = await getOrCreatePagesProject(
        env,
        project
      );

      // Get temporary asset upload token.
      const uploadToken = await getUploadToken(
        env,
        name
      );

      // Upload actual website assets.
      const manifest = await uploadAssets(
        uploadToken,
        files
      );

      // Create the real production deployment.
      const deployment = await createDeployment(
        env,
        name,
        manifest
      );

      // Save published website information.
      const saved = await db(
        env,
        `projects?id=eq.${project.id}&user_id=eq.${user.id}`,
        "PATCH",
        {
          cf_deployment_id: deployment.id,
          live_url: deployment.url,
          status: "published",
          updated_at: new Date().toISOString()
        }
      );

      if (!saved.ok) {
        throw new Error(
          "Website deployed, but database status could not be updated."
        );
      }

      return reply(
        {
          success: true,
          message: "Website published successfully.",
          projectId: project.id,
          url: deployment.url
        },
        200,
        origin
      );

    } catch (error) {
      console.error("Zapify Hosting error:", error);

      // Mark failed projects accurately.
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

      return reply(
        {
          error: error.message ||
            "An unexpected deployment error occurred."
        },
        500,
        origin
      );
    }
  }
};
