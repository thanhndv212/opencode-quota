import { mkdir, copyFile } from "fs/promises";
import { join, dirname } from "path";

const files = [
  {
    src: join("src", "data", "modelsdev-pricing.min.json"),
    dst: join("dist", "data", "modelsdev-pricing.min.json"),
  },
  {
    src: join("src", "dashboard", "schema.sql"),
    dst: join("dist", "dashboard", "schema.sql"),
  },
  {
    src: join("src", "dashboard", "public", "index.html"),
    dst: join("dist", "dashboard", "public", "index.html"),
  },
  {
    src: join("src", "dashboard", "public", "styles.css"),
    dst: join("dist", "dashboard", "public", "styles.css"),
  },
  {
    src: join("src", "dashboard", "public", "dashboard.js"),
    dst: join("dist", "dashboard", "public", "dashboard.js"),
  },
];

for (const f of files) {
  await mkdir(dirname(f.dst), { recursive: true });
  await copyFile(f.src, f.dst);
}
