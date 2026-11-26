
const HEADERS = {
  "content-type": "application/json; charset=utf-8"
};

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
      ...HEADERS,
      ...cors(origin)
    }
  });
}

// Verify the signed-in Supabase user.
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

// Server-side database requests.
// Supabase sb_secret keys are sent through apikey only.
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

// Cloudflare API helper.
async function cf(env, path, method = "GET", body, contentType) {
  const headers = {
    Authorization: `Bearer ${env.CF_API_TOKEN}`
  };

  if (contentType) {
    headers["content-type"] = contentType;
  }

  return fetch(
    `https://api.cloudflare.com/client/v4${path}`,
    {
      method,
      headers,
      body: body
        ? contentType
          ? JSON.stringify(body)
          : body
        : undefined
    }
  );
}

// Generate a unique Cloudflare Pages project name.
function projectName(name, id) {
  const slug = String(name)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 22) || "site";

  return `zfy-${slug}-${id.replace(/-/g, "").slice(0, 10)}`;
}

// Reject unsafe upload paths.
function safePath(path) {
  return (
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

// Calculate SHA-256 file hashes.
async function hash(buffer) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    buffer
  );

  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Create a Pages project and save its name.
async function getOrCreatePagesProject(env, project) {
  if (project.cf_project_name) {
    return project.cf_project_name;
  }

  const name = projectName(
    project.site_name,
    project.id
  );

  const path =
    `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${name}`;

  let response = await cf(
    env,
    `/accounts/${env.CF_ACCOUNT_ID}/pages/projects`,
    "POST",
    {
      name,
      production_branch: "main"
    },
    "application/json"
  );

  let result = await response.json();

  // If the project already exists, retrieve it.
  if (!response.ok || !result.success) {
    const existing = await cf(env, path, "GET");
    const existingResult = await existing.json();

    if (!existing.ok || !existingResult.success) {
      throw new Error(
        result.errors?.[0]?.message ||
        "Could not create the Cloudflare Pages project."
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
    throw new Error(
      "Could not save the Cloudflare project information."
    );
  }

  return name;
}

// Upload website files to Cloudflare Pages.
async function deploy(env, name, files) {
  const manifest = {};
  const parts = [];

  for (const file of files) {
    const buffer = await file.arrayBuffer();
    const fileHash = await hash(buffer);

    manifest[file.name] = fileHash;

    parts.push({
      hash: fileHash,
      buffer,
      name: file.name
    });
  }

  const form = new FormData();

  form.set("manifest", JSON.stringify(manifest));
  form.set("branch", "main");
  form.set("commit_dirty", "false");
  form.set(
    "commit_message",
    "Published from Zapify Hosting"
  );

  for (const part of parts) {
    form.append(
      part.hash,
      new Blob([part.buffer]),
      part.name
    );
  }

  const response = await cf(
    env,
    `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${name}/deployments`,
    "POST",
    form
  );

  const result = await response.json();

  if (!response.ok || !result.success) {
    throw new Error(
      result.errors?.[0]?.message ||
      "Cloudflare could not deploy your website."
    );
  }

  // Always use the permanent production hostname.
  // Do not use the unique deployment URL.
  const productionUrl = `https://${name}.pages.dev`;

  return {
    deploymentId: result.result?.id || null,
    url: productionUrl
  };
}

// Main Worker.
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "";

    if (origin !== allowedOrigin || !allowedOrigin) {
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

    try {
      // Check required environment variables.
      const required = [
        "SUPABASE_URL",
        "SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "CF_ACCOUNT_ID",
        "CF_API_TOKEN"
      ];

      for (const key of required) {
        if (!env[key]) {
          throw new Error(
            `Missing Cloudflare configuration: ${key}`
          );
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
          { error: "Please sign in to continue." },
          401,
          origin
        );
      }

      const user = await userFor(env, token);

      if (!user?.id) {
        return reply(
          {
            error: "Your session has expired. Please sign in again."
          },
          401,
          origin
        );
      }

      // Read upload.
      const form = await request.formData();

      const siteName = String(
        form.get("siteName") || ""
      ).trim();

      const files = form
        .getAll("files")
        .filter(file => file instanceof File);

      if (!siteName || siteName.length > 60) {
        return reply(
          {
            error: "Enter a website name (maximum 60 characters)."
          },
          400,
          origin
        );
      }

      if (!files.length || files.length > 100) {
        return reply(
          {
            error: "Upload between 1 and 100 files."
          },
          400,
          origin
        );
      }

      // Validate files.
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
          {
            error: "Your expanded website exceeds 20 MiB."
          },
          413,
          origin
        );
      }

      if (!paths.has("index.html")) {
        return reply(
          {
            error: "Your ZIP must contain index.html at its root."
          },
          400,
          origin
        );
      }

      // Create database record.
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
          "Supabase project creation failed:",
          created.status,
          raw
        );

        throw new Error(
          `Could not create project record (database status ${created.status}).`
        );
      }

      const project = rows[0];

      try {
        // Create Pages project.
        const name = await getOrCreatePagesProject(
          env,
          project
        );

        // Deploy website.
        const deployment = await deploy(
          env,
          name,
          files
        );

        // Save permanent website URL.
        const saved = await db(
          env,
          `projects?id=eq.${project.id}&user_id=eq.${user.id}`,
          "PATCH",
          {
            cf_deployment_id: deployment.deploymentId,
            live_url: deployment.url,
            status: "published",
            updated_at: new Date().toISOString()
          }
        );

        if (!saved.ok) {
          throw new Error(
            "Website deployed, but its status could not be saved."
          );
        }

        return reply(
          {
            success: true,
            message: "Your website has been published successfully.",
            projectId: project.id,
            url: deployment.url
          },
          200,
          origin
        );

      } catch (error) {
        await db(
          env,
          `projects?id=eq.${project.id}&user_id=eq.${user.id}`,
          "PATCH",
          {
            status: "failed",
            updated_at: new Date().toISOString()
          }
        );

        throw error;
      }

    } catch (error) {
      console.error(
        "Zapify Hosting deployment error:",
        error
      );

      return reply(
        {
          error: error.message || "An unexpected deployment error occurred."
        },
        500,
        origin
      );
    }
  }
};
