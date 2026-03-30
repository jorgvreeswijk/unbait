#!/usr/bin/env node

/**
 * build-changelog.js
 *
 * Generates docs/changelog.json from git history, grouped by version tags.
 *
 * Usage:
 *   node scripts/build-changelog.js          # adds new versions, preserves existing
 *   node scripts/build-changelog.js --force   # regenerates everything
 *   node scripts/build-changelog.js --preview # prints to stdout, no file write
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const OUTPUT = path.join(__dirname, "..", "docs", "changelog.json");
const force = process.argv.includes("--force");
const preview = process.argv.includes("--preview");

// ── Filters: commits matching any of these patterns are excluded ──
const EXCLUDE_PATTERNS = [
  /^website:/i,
  /^prepare repo/i,
  /^code quality/i,
  /^clean up/i,
  /license/i,
  /^merge /i,
  /^initial commit/i,
  /bump version/i,
  /update chrome zip/i,
  /^rename api key/i,
  /^only italicize/i,
  /^improve landing page/i,
  /add cname/i,
  /co-authored-by/i,
];

// ── Categorization rules (first match wins) ──
function categorize(msg) {
  const m = msg.toLowerCase();
  if (m.startsWith("add ") || m.startsWith("enable ")) return "features";
  if (m.startsWith("fix ")) return "fixes";
  return "improvements";
}

// ── Friendly label for commit message ──
function cleanMessage(msg) {
  return msg.replace(/\n*Co-Authored-By:.*/gi, "").trim();
}

// ── Get sorted version tags ──
function getVersionTags() {
  const raw = execFileSync("git", ["tag", "-l", "v*", "--sort=version:refname"], {
    encoding: "utf-8",
  }).trim();
  if (!raw) return [];
  return raw.split("\n").filter(Boolean);
}

// ── Get commits between two refs ──
function getCommits(from, to) {
  const args = ["log", "--pretty=format:%H|||%s|||%ai", "--reverse"];
  args.push(from ? `${from}..${to}` : to);
  const raw = execFileSync("git", args, { encoding: "utf-8" }).trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [hash, message, date] = line.split("|||");
    return { hash: hash.slice(0, 7), message: cleanMessage(message), date: date.split(" ")[0] };
  });
}

// ── Build changelog for a version ──
function buildVersion(tag, commits) {
  const tagDate = execFileSync("git", ["log", "-1", "--format=%ai", tag], {
    encoding: "utf-8",
  })
    .trim()
    .split(" ")[0];

  const filtered = commits.filter(
    (c) => !EXCLUDE_PATTERNS.some((p) => p.test(c.message))
  );

  const groups = { features: [], improvements: [], fixes: [] };
  for (const c of filtered) {
    const cat = categorize(c.message);
    groups[cat].push(c.message);
  }

  // Deduplicate
  for (const cat of Object.keys(groups)) {
    groups[cat] = [...new Set(groups[cat])];
  }

  const changes = {};
  if (groups.features.length) changes.features = groups.features;
  if (groups.improvements.length) changes.improvements = groups.improvements;
  if (groups.fixes.length) changes.fixes = groups.fixes;

  return {
    version: tag.replace(/^v/, ""),
    tag,
    date: tagDate,
    changes,
  };
}

// ── Main ──
function main() {
  const tags = getVersionTags();
  if (tags.length === 0) {
    console.error("No version tags found. Create tags first: git tag v1.0.0 <commit>");
    process.exit(1);
  }

  let existing = [];
  if (!force && fs.existsSync(OUTPUT)) {
    try {
      const data = JSON.parse(fs.readFileSync(OUTPUT, "utf-8"));
      existing = data.versions || [];
    } catch (e) {
      // ignore parse errors, regenerate
    }
  }

  const existingVersions = new Set(existing.map((v) => v.tag));

  const versions = [];
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    const prevTag = i > 0 ? tags[i - 1] : null;

    if (!force && existingVersions.has(tag)) {
      versions.push(existing.find((v) => v.tag === tag));
      continue;
    }

    const commits = getCommits(prevTag, tag);
    versions.push(buildVersion(tag, commits));
  }

  // Newest first
  versions.reverse();

  const changelog = {
    generatedAt: new Date().toISOString(),
    versions,
  };

  if (preview) {
    console.log(JSON.stringify(changelog, null, 2));
  } else {
    fs.writeFileSync(OUTPUT, JSON.stringify(changelog, null, 2));
    console.log(`Changelog written to ${OUTPUT}`);
    console.log(`${versions.length} versions, newest first.`);
  }
}

main();
