#!/usr/bin/env node
// Zero-dependency tooling for this repo.
//   node scripts/skills.mjs sync        regenerate every harness manifest
//   node scripts/skills.mjs check       validate skills and fail if manifests are stale (CI)
//   node scripts/skills.mjs new <name>  scaffold skills/<name>/SKILL.md
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "plugin.config.json"), "utf8"));
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PLACEHOLDER = "__FILL_IN__"; // left in templates/skill/SKILL.md for the author to replace
const isValidName = (name) => NAME_RE.test(name) && name.length <= 64;

// `>` and `|` values. Folded (`>`) joins neighbouring lines with a space; blank and
// more-indented lines keep their line breaks. Trailing line breaks are dropped.
function blockScalar(style, header, rest) {
  const first = rest.find((l) => l.trim());
  if (!first) return "";
  const spaces = (l) => l.match(/^ */)[0].length;
  const indent = Number(header.match(/[1-9]/)?.[0] ?? spaces(first));
  if (!indent || rest.some((l) => l.trim() && spaces(l) < indent)) throw new Error("has a badly indented block");
  const body = rest.map((l) => l.slice(indent));
  while (body.length && !body.at(-1).trim()) body.pop();
  if (style === "|") return body.join("\n");
  let out = "", prev = null, blanks = 0;
  for (const line of body) {
    if (!line.trim()) { blanks++; continue; }
    if (prev === null) out = "\n".repeat(blanks) + line;
    else if (/^\s/.test(prev) || /^\s/.test(line)) out += "\n".repeat(blanks + 1) + line;
    else out += (blanks ? "\n".repeat(blanks) : " ") + line;
    prev = line; blanks = 0;
  }
  return out;
}

// Reads a string value: one line (plain or quoted) or a block. Anything else is an error,
// so a description is never silently cut short in the manifests.
function scalar(value, rest) {
  const block = value.match(/^([>|])([-+]?[1-9]?|[1-9][-+]?)(?:\s+#.*)?$/);
  if (block) return blockScalar(block[1], block[2], rest);
  if (rest.some((l) => /^\s+[^\s#]/.test(l))) throw new Error("spans several lines. Put it on one line or use a >- block");
  const double = value.match(/^"((?:[^"\\]|\\.)*)"(?:\s+#.*)?$/);
  if (double) {
    try { return JSON.parse(`"${double[1]}"`); } catch { throw new Error("uses an escape or tab this script cannot read"); }
  }
  const single = value.match(/^'((?:[^']|'')*)'(?:\s+#.*)?$/);
  if (single) return single[1].replaceAll("''", "'");
  if (/^["']/.test(value)) throw new Error("has a broken quoted string (invalid YAML)");
  if (/^([\[\]{},#&*!|>%@`]|[-?:](\s|$))/.test(value) || /:(\s|$)|\s#/.test(value))
    throw new Error("is unsafe unquoted YAML (strict parsers drop or cut it). Wrap it in double quotes");
  return value;
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fields = {}, invalid = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):(?:\s+(.*))?$/);
    if (!kv) continue;
    const [key, value] = [kv[1], (kv[2] || "").trim()];
    const rest = []; // indented and blank lines below a key belong to its value
    while (i + 1 < lines.length && /^(\s|$)/.test(lines[i + 1])) rest.push(lines[++i]);
    if (key === "name" || key === "description") {
      try { fields[key] = scalar(value, rest); } catch (e) { invalid[key] = e.message; }
    } else if (/^[^"'>|[{]/.test(value) && /:\s|\s#/.test(value)) {
      invalid[key] = 'is unquoted and contains ": " or " #" (invalid YAML or cut short). Wrap it in double quotes';
    }
  }
  return { fields, invalid };
}

function loadSkills() {
  const dir = path.join(root, "skills");
  const skills = [], errors = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const fail = (message) => errors.push(`skills/${e.name}: ${message}`);
    const file = path.join(dir, e.name, "SKILL.md");
    if (!fs.existsSync(file)) { fail("missing SKILL.md"); continue; }
    const text = fs.readFileSync(file, "utf8");
    const parsed = frontmatter(text);
    if (!parsed) { fail("SKILL.md has no frontmatter"); continue; }
    const { fields: fm, invalid } = parsed;
    for (const [key, why] of Object.entries(invalid)) fail(`frontmatter "${key}" ${why}`);
    if (!invalid.name && fm.name !== e.name) fail(`frontmatter name "${fm.name}" must equal the directory name`);
    if (!isValidName(e.name)) fail("name must be lowercase-hyphenated, <= 64 chars");
    if (e.name === cfg.name) fail('name is already used by the bundle plugin ("name" in plugin.config.json)');
    if (!invalid.description) {
      if (!fm.description) fail("description is required");
      else if (fm.description.length > 1024) fail("description exceeds 1024 chars");
      else if (fm.description.includes(PLACEHOLDER)) fail(`description still contains ${PLACEHOLDER}`);
    }
    const lines = text.replace(/\n$/, "").split("\n").length;
    if (lines > 500) fail(`SKILL.md is ${lines} lines (max 500); move detail to references/`);
    skills.push({ name: e.name, description: fm.description || "" });
  }
  return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), errors };
}

function manifests(skills) {
  const base = { name: cfg.name, version: cfg.version, description: cfg.description,
    author: cfg.author, repository: cfg.repository, license: cfg.license };
  const bundle = { name: cfg.name, source: "./", description: cfg.description, version: cfg.version };
  const owner = cfg.author;
  return {
    // Claude Code: plugin + marketplace (bundle, then one entry per skill so users can pick one)
    ".claude-plugin/plugin.json": { ...base, keywords: cfg.keywords, skills: "./skills/" },
    ".claude-plugin/marketplace.json": {
      name: cfg.name, description: cfg.description, owner,
      // Per-skill entries are rooted at the skill folder: rooted at "./" they would
      // conflict with .claude-plugin/plugin.json and fail to load.
      plugins: [bundle, ...skills.map((s) => ({
        name: s.name, source: `./skills/${s.name}`, strict: false, description: s.description,
        version: cfg.version, skills: ["./"] }))],
    },
    // Codex: plugin manifest + marketplace catalog
    ".codex-plugin/plugin.json": { ...base, keywords: cfg.keywords, skills: "./skills/",
      interface: { displayName: cfg.displayName, shortDescription: cfg.description, category: cfg.category } },
    ".agents/plugins/marketplace.json": {
      name: cfg.name, interface: { displayName: cfg.displayName },
      plugins: [{ name: cfg.name, source: { source: "local", path: "./" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: cfg.category }],
    },
    // Agent Plugins 1.0 package (read by GitHub Copilot and others) + Copilot marketplace
    "plugin.json": { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      ...base, keywords: cfg.keywords },
    "marketplace.json": {
      name: cfg.name, owner, metadata: { description: cfg.description },
      plugins: [bundle, ...skills.map((s) => ({
        name: s.name, source: `./skills/${s.name}`, description: s.description, version: cfg.version }))],
    },
  };
}

const render = (o) => JSON.stringify(o, null, 2) + "\n";
const [cmd, arg] = process.argv.slice(2);
const exitWith = (errors) => { console.error(errors.map((e) => "✗ " + e).join("\n")); process.exit(1); };

if (cmd === "sync" || cmd === "check") {
  const { skills, errors } = loadSkills();
  if (!skills.length) errors.push("no skills found under skills/");
  if (errors.length) exitWith(errors); // never write or compare manifests built from bad skills
  const out = manifests(skills);
  const stale = [];
  for (const [rel, obj] of Object.entries(out)) {
    const file = path.join(root, rel), next = render(obj);
    if (cmd === "sync") { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, next); }
    else if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== next) stale.push(rel);
  }
  if (stale.length) exitWith(stale.map((f) => `${f} is stale: run "node scripts/skills.mjs sync"`));
  console.log(`✓ ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
  console.log(cmd === "sync" ? `✓ wrote ${Object.keys(out).length} manifests` : "✓ manifests up to date");
} else if (cmd === "new") {
  if (!arg || !isValidName(arg)) { console.error("usage: skills.mjs new <lowercase-hyphen-name, max 64 chars>"); process.exit(1); }
  if (arg === cfg.name) { console.error(`"${arg}" is already used by the bundle plugin`); process.exit(1); }
  const dest = path.join(root, "skills", arg);
  if (fs.existsSync(dest)) { console.error(`skills/${arg} already exists`); process.exit(1); }
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "SKILL.md"),
    fs.readFileSync(path.join(root, "templates/skill/SKILL.md"), "utf8")
      .replaceAll("__NAME__", arg).replaceAll("__LICENSE__", cfg.license));
  console.log(`✓ created skills/${arg}/SKILL.md. Replace ${PLACEHOLDER} in it, then run: node scripts/skills.mjs sync`);
} else {
  console.error("usage: skills.mjs <sync|check|new <name>>"); process.exit(1);
}
