import fs from "node:fs";
const t = fs.readFileSync(process.argv[2], "utf8");
const CJK = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;
const est = s => { const c=(s.match(CJK)||[]).length; return Math.ceil(c/1.7 + (s.length-c)/3.8); };
for (const name of ["read_range","tool_catalog"]) {
  const i = t.indexOf(`"name": "${name}"`);
  if (i < 0) { console.log(name + ": NOT FOUND"); continue; }
  // block runs until the next top-level tool name
  const next = t.indexOf(`"name": "`, i + 10);
  const span = t.slice(i, next > 0 ? next : t.length);
  console.log(`${name.padEnd(14)} chars=${String(span.length).padStart(5)}  tokens=${String(est(span)).padStart(5)}`);
}
