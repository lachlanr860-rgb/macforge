import { defineConfig } from "vite";
import { handleApi } from "./server/api.mjs";

/** Mounts the shared game API (detection, artwork, launch) on the dev server. */
function macforgeApi() {
  const attach = (server) => {
    server.middlewares.use((req, res, next) => {
      if ((req.url ?? "").startsWith("/api/")) handleApi(req, res);
      else next();
    });
  };

  return {
    name: "macforge-api",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

export default defineConfig({
  plugins: [macforgeApi()],
});
