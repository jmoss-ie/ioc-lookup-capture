import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

/**
 * Minimal static file server for e2e fixtures.
 * @param {string} rootDir
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startStaticServer(rootDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Strip the query string BEFORE mapping "/" to index.html — the batch
      // tests navigate to "/?job=1", "/?job=2" so each job has a distinct URL,
      // and those must serve the fixture page, not a 404.
      const pathname = decodeURIComponent(req.url.split("?")[0]);
      const urlPath = pathname === "/" ? "/index.html" : pathname;
      const filePath = path.join(rootDir, urlPath);
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, {
          "Content-Type": MIME[ext] || "application/octet-stream",
          Date: new Date().toUTCString(),
        });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
