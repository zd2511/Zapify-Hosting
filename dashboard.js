
(() => {
  "use strict";

  const c = window.ZAPIFY_CONFIG || {};

  const ready =
    c.supabaseUrl &&
    !c.supabaseUrl.includes("YOUR_") &&
    c.supabaseAnonKey &&
    !c.supabaseAnonKey.includes("YOUR_");

  const db =
    ready && window.supabase
      ? window.supabase.createClient(
          c.supabaseUrl,
          c.supabaseAnonKey
        )
      : null;

  const $ = id => document.getElementById(id);

  let session = null;

  const say = (message, bad = false) => {
    const el = $("uploadStatus");
    el.textContent = message;
    el.style.color = bad ? "#b23b57" : "#80518a";
  };

  const esc = value =>
    String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[ch]);

  function validPath(path) {
    if (
      !path ||
      path.length > 500 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes("\0")
    ) return false;

    const parts = path.split("/");

    if (
      parts.some(part =>
        !part ||
        part === "." ||
        part === ".." ||
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

  async function load() {
    const { data, error } = await db
      .from("projects")
      .select("id,site_name,slug,status,live_url,created_at")
      .order("created_at", { ascending: false });

    if (error) {
      $("projectsList").innerHTML =
        `<div class="empty">${esc(error.message)}</div>`;
      return;
    }

    $("projectCount").textContent =
      `${data.length} ${data.length === 1 ? "website" : "websites"}`;

    $("projectsList").innerHTML = data.length
      ? data.map(project => `
          <article class="projectcard">
            <div>
              <h3>${esc(project.site_name)}</h3>
              <p>
                ${project.live_url
                  ? esc(project.live_url)
                  : "Not published yet"}
                · ${esc(project.slug)}
              </p>
            </div>

            <div class="projectactions">
              <span class="status">${esc(project.status)}</span>
              ${project.live_url
                ? `<a href="${esc(project.live_url)}"
                     target="_blank"
                     rel="noopener">Open website ↗</a>`
                : ""}
            </div>
          </article>
        `).join("")
      : `<div class="empty">
           No websites yet. Upload your first ZIP above.
         </div>`;
  }

  async function init() {
    if (!db) {
      $("userEmail").textContent = "Setup required";
      $("projectsList").innerHTML =
        `<div class="empty">
          Add your Supabase details in config.js, then reload.
        </div>`;
      $("deployButton").disabled = true;
      return;
    }

    const { data, error } = await db.auth.getSession();

    if (error || !data.session) {
      location.href = "index.html";
      return;
    }

    session = data.session;
    $("userEmail").textContent = session.user.email;

    await load();
  }

  async function freshSession() {
    const now = Math.floor(Date.now() / 1000);

    if (
      session?.expires_at &&
      session.expires_at - now < 60
    ) {
      const { data, error } = await db.auth.refreshSession();

      if (error || !data.session) {
        throw new Error(
          "Your login expired. Please sign in again."
        );
      }

      session = data.session;
    }

    if (!session?.access_token) {
      throw new Error("Please sign in again.");
    }

    return session;
  }

  async function readResponse(response) {
    const text = await response.text();

    let result;

    try {
      result = JSON.parse(text);
    } catch {
      throw new Error(
        `Hosting server returned HTTP ${response.status}: ${
          text.slice(0, 250) || "Empty response"
        }`
      );
    }

    if (!response.ok || result.success === false) {
      const stage = result.stage
        ? `${result.stage}: `
        : "";

      throw new Error(
        stage + (result.error || `Deployment failed (${response.status}).`)
      );
    }

    return result;
  }

  $("uploadForm").addEventListener("submit", async event => {
    event.preventDefault();

    if (!session) {
      say("Please sign in again.", true);
      return;
    }

    if (
      !c.apiBaseUrl ||
      c.apiBaseUrl.includes("YOUR_")
    ) {
      say("Setup required: add your Worker URL in config.js.", true);
      return;
    }

    if (typeof JSZip === "undefined") {
      say("ZIP library is missing. Please reload the page.", true);
      return;
    }

    const name = $("siteName").value.trim();
    const file = $("siteZip").files[0];

    if (!name || !file) {
      say("Enter a website name and choose a ZIP file.", true);
      return;
    }

    if (name.length > 60) {
      say("Website name must be 60 characters or fewer.", true);
      return;
    }

    if (
      !file.name.toLowerCase().endsWith(".zip") ||
      file.size > 8 * 1024 * 1024
    ) {
      say("Choose a ZIP file smaller than 8 MiB.", true);
      return;
    }

    const button = $("deployButton");
    button.disabled = true;
    button.textContent = "Checking ZIP…";

    try {
      await freshSession();

      const zip = await JSZip.loadAsync(file, {
        checkCRC32: true
      });

      const entries = Object.values(zip.files)
        .filter(entry => !entry.dir);

      if (!entries.length) {
        throw new Error("Your ZIP is empty.");
      }

      if (entries.length > 100) {
        throw new Error("Your ZIP contains more than 100 files.");
      }

      if (!entries.some(entry => entry.name === "index.html")) {
        throw new Error(
          "Your ZIP needs index.html at its root, not inside another folder."
        );
      }

      const body = new FormData();
      body.append("siteName", name);

      let total = 0;

      for (const entry of entries) {
        if (!validPath(entry.name)) {
          throw new Error(
            `Unsafe file path: ${entry.name}. Remove hidden or system files.`
          );
        }

        const bytes = await entry.async("uint8array");

        total += bytes.byteLength;

        if (total > 20 * 1024 * 1024) {
          throw new Error(
            "Expanded website is larger than 20 MiB."
          );
        }

        const blob = new Blob([bytes]);

        body.append("files", blob, entry.name);
      }

      say("Uploading website files…");
      button.textContent = "Uploading…";

      const response = await fetch(
        c.apiBaseUrl.replace(/\/$/, "") + "/api/deploy",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + session.access_token
          },
          body
        }
      );

      const result = await readResponse(response);

      say("Website published successfully!");

      $("siteName").value = "";
      $("siteZip").value = "";

      await load();

      say(
        `Published! Your website: ${result.url}`
      );

    } catch (error) {
      console.error("Zapify upload error:", error);
      say(error.message || "Could not publish this ZIP.", true);

    } finally {
      button.disabled = false;
      button.textContent = "Upload and deploy ↗";
    }
  });

  $("signOut").addEventListener("click", async () => {
    if (db) {
      await db.auth.signOut();
    }

    location.href = "index.html";
  });

  init();
})();
