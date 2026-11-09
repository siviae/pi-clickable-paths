/**
 * Self-check: `node test/clickable-paths.test.ts` (run from the repo root).
 * Creates temp files under .tmp-test/, asserts, cleans up.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { linkifyPaths, toClickable, toFileUrl } from "../index.ts";

const tmp = path.join(import.meta.dirname, ".tmp-test");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
const sample = path.join(tmp, "sample.txt");
fs.writeFileSync(sample, "hi");

const md = (p: string) => `[${p}](file:///${p.replace(/\\/g, "/")})`;

// 1. backticked absolute path -> link
const t1 = linkifyPaths(`your file is in \`${sample}\``, tmp);
assert.equal(t1, `your file is in ${md(sample)}`);

// 2. plain path, trailing sentence dot stays outside the link
const t2 = linkifyPaths(`see ${sample}.`, tmp);
assert.equal(t2, `see ${md(sample)}.`);

// 3. fenced code block untouched
const t3 = linkifyPaths(`before\n\`\`\`\n${sample}\n\`\`\`\nafter`, tmp);
assert.ok(t3.includes(`\`\`\`\n${sample}\n\`\`\``), "fence content must be unchanged");

// 4. non-existent path untouched
assert.equal(linkifyPaths(`see ${tmp}\\nope.txt here`, tmp), `see ${tmp}\\nope.txt here`);

// 5. URLs untouched
assert.ok(!linkifyPaths(`visit https://example.com/a/b.py now`, tmp).includes("]("), "URL must not become a link");

// 6. existing markdown link preserved
const t6 = `[my notes](${sample})`;
assert.equal(linkifyPaths(t6, tmp), t6);

// 7. relative path resolved against cwd (test dir)
const t7 = linkifyPaths(`open .tmp-test/sample.txt now`, import.meta.dirname);
assert.equal(t7, `open [.tmp-test/sample.txt](${toFileUrl(sample)}) now`);

// 8. folder link works
assert.equal(linkifyPaths(`folder: \`${tmp}\\sub\``, tmp), `folder: ${md(path.join(tmp, "sub"))}`);

// 9. drive root skipped
assert.equal(linkifyPaths(`on C:\\ you find stuff`, tmp), `on C:\\ you find stuff`);

// 10. toClickable edge cases
assert.equal(toClickable("https://a.com/x.ts", tmp), null);
assert.equal(toClickable("ab", tmp), null);
assert.ok(toClickable(`${sample}.`, tmp)!.startsWith(`[${sample}](`));

fs.rmSync(tmp, { recursive: true, force: true });
console.log("OK — all clickable-paths checks passed");
