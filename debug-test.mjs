import { readFileSync } from "node:fs";
const css = readFileSync("packages/shell/src/styles/global.css", "utf-8");
const declarations = [...css.matchAll(/font-size\s*:\s*([^;}]+)/g)].map(
    (m) => m[1].trim(),
);
const unscaled = declarations.filter(
    (value) =>
        /\d(px|rem)\b/.test(value) && !value.includes("var(--ui-font-scale"),
);
console.log(unscaled);
