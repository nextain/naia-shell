import { readFileSync } from "node:fs";
const files = ["packages/shell/src/styles/global.css", "packages/shell/src/apps/projects/projects.css", "packages/shell/src/apps/slides/slides.css"];
for (const path of files) {
    const css = readFileSync(path, "utf-8");
    const declarations = [...css.matchAll(/font-size\s*:\s*([^;}]+)/g)].map(
        (m) => m[1].trim(),
    );
    const unscaled = declarations.filter(
        (value) =>
            /\d(px|rem)\b/.test(value) && !value.includes("var(--ui-font-scale"),
    );
    if (unscaled.length > 0) {
        console.log(`File: ${path}`);
        console.log(unscaled);
    }
}
